mod agent;
mod assets;
mod baselines;
mod config;
mod image3d;
mod model;
mod rpc;
mod store;
mod tools;

use agent::AgentManager;
use axum::extract::State;
use axum::http::{header, HeaderValue, Method};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::Router;
use config::{load, AppConfig};
use serde_json::Value;
use std::collections::HashMap;
use std::convert::Infallible;
use futures::Stream;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, RwLock};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<RwLock<AppConfig>>,
    pub projects_root: PathBuf,
    pub agents: AgentManager,
    pub bus: broadcast::Sender<Value>,
    pub tools: Arc<RwLock<HashMap<String, tools::ToolDef>>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    let config = load()?;
    let projects_root = config::projects_root(&config);
    std::fs::create_dir_all(&projects_root)?;
    if !projects_root.join("starter").exists() {
        store::create_project(&projects_root, "starter", "Starter")?;
    }

    let (bus, _) = broadcast::channel(256);
    let state = AppState {
        config: Arc::new(RwLock::new(config)),
        projects_root,
        agents: AgentManager::new(bus.clone()),
        bus,
        tools: Arc::new(RwLock::new(HashMap::new())),
    };

    // The RPC surface is unauthenticated and can create, overwrite, and revert
    // projects, read files, and drive the agent loop against the user's API
    // keys. `allow_origin(Any)` made all of that reachable from any website the
    // user happened to have open, so origins are restricted to the loopback
    // dev server and the core's own origin. Extra origins can be added via
    // CALI_ALLOWED_ORIGINS (comma-separated) for non-default setups.
    let mut origins: Vec<HeaderValue> = ["http://127.0.0.1:5199", "http://localhost:5199", "http://127.0.0.1:8765"]
        .iter()
        .filter_map(|origin| origin.parse().ok())
        .collect();
    if let Ok(extra) = std::env::var("CALI_ALLOWED_ORIGINS") {
        origins.extend(extra.split(',').filter_map(|origin| origin.trim().parse().ok()));
    }
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE]);
    let dist = std::env::var("CALI_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../client/dist"));

    let app = Router::new()
        .route("/rpc", post(rpc::rpc_handler))
        .route("/events", get(events))
        .fallback_service(
            ServeDir::new(&dist)
                .not_found_service(ServeFile::new(dist.join("index.html"))),
        )
        .layer(cors)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state);

    let addr = "127.0.0.1:8765";
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("CaliCode core listening on http://{}", addr);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn events(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.bus.subscribe();
    let stream = futures::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(value) => {
                    let event = Event::default()
                        .event("message")
                        .json_data(value)
                        .unwrap_or_else(|_| Event::default().data("{}"));
                    return Some((Ok(event), rx));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return None,
            }
        }
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("keepalive"))
}
