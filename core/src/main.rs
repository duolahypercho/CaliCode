mod agent;
mod assets;
mod baselines;
mod config;
mod devserver;
mod image3d;
mod model;
mod rpc;
mod store;
mod tools;
mod workspace;

use agent::AgentManager;
use axum::extract::State;
use axum::http::{header, HeaderValue, Method};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use config::{load, AppConfig};
use futures::Stream;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
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
    pub workspaces: Arc<RwLock<workspace::Registry>>,
    pub dev_servers: Arc<RwLock<devserver::Servers>>,
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

    // Re-attach folders opened in a previous session before the router is up,
    // so the first workspace_list already reflects them.
    let mut workspaces = workspace::Registry::new();
    let restored = workspace::restore(&mut workspaces, &config.workspaces);
    if !restored.is_empty() {
        tracing::info!(count = restored.len(), "restored workspaces");
    }

    let (bus, _) = broadcast::channel(256);
    let state = AppState {
        config: Arc::new(RwLock::new(config)),
        projects_root,
        agents: AgentManager::new(bus.clone()),
        bus,
        tools: Arc::new(RwLock::new(HashMap::new())),
        workspaces: Arc::new(RwLock::new(workspaces)),
        dev_servers: Arc::new(RwLock::new(devserver::Servers::new())),
    };

    // The RPC surface is unauthenticated and can create, overwrite, and revert
    // projects, read files, and drive the agent loop against the user's API
    // keys. `allow_origin(Any)` made all of that reachable from any website the
    // user happened to have open, so origins are restricted to the loopback
    // dev server and the core's own origin. Extra origins can be added via
    // CALI_ALLOWED_ORIGINS (comma-separated) for non-default setups.
    let mut origins: Vec<HeaderValue> = [
        "http://127.0.0.1:5199",
        "http://localhost:5199",
        "http://127.0.0.1:8765",
    ]
    .iter()
    .filter_map(|origin| origin.parse().ok())
    .collect();
    if let Ok(extra) = std::env::var("CALI_ALLOWED_ORIGINS") {
        origins.extend(
            extra
                .split(',')
                .filter_map(|origin| origin.trim().parse().ok()),
        );
    }
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE]);
    let dist = std::env::var("CALI_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../client/dist"));

    // Cloned before `state` moves into the router, so shutdown can still
    // reach the running dev servers.
    let dev_servers = state.dev_servers.clone();

    // CORS is not sufficient on its own. A DNS-rebinding attack sends a
    // same-origin-looking request with NO Origin header and a foreign Host, so
    // the origin allowlist never engages — an audit confirmed a request with
    // `Host: evil.attacker.example` and no Origin was dispatched in full.
    // Requiring a loopback Host closes that: after rebinding, the browser
    // still sends the attacker's hostname.
    let host_guard = axum::middleware::from_fn(require_loopback_host);

    let app = Router::new()
        .route("/rpc", post(rpc::rpc_handler))
        // A GET liveness probe. `/` serves the built client, which does not
        // exist until `pnpm build` has run, so it is not a usable readiness
        // signal for tooling — CI waited 180s on it and timed out.
        .route("/health", get(health))
        .route("/events", get(events))
        .fallback_service(
            ServeDir::new(&dist).not_found_service(ServeFile::new(dist.join("index.html"))),
        )
        .layer(cors)
        .layer(host_guard)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state);

    let addr = "127.0.0.1:8765";
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("CaliCode core listening on http://{}", addr);

    // Dev-server children rely on Child::kill_on_drop, which only fires when
    // the Servers map is dropped. A signalled process does not run
    // destructors, so quitting core used to leave every vite child running.
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            tracing::info!("shutting down; stopping dev servers");
            let ids: Vec<String> = dev_servers.read().await.keys().cloned().collect();
            let mut servers = dev_servers.write().await;
            for id in ids {
                let _ = devserver::stop(&mut servers, &id).await;
            }
        })
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(error) => tracing::warn!(%error, "cannot listen for SIGTERM"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = interrupt => {}
        _ = terminate => {}
    }
}

/// Rejects requests whose Host is not loopback.
///
/// Extra names can be allowed with CALI_ALLOWED_HOSTS (comma-separated) for
/// setups that front core with a different local hostname.
async fn require_loopback_host(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let host = request
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    // Strip the port; only the name matters.
    let name = host.rsplit_once(':').map(|(n, _)| n).unwrap_or(&host);
    let name = name.trim_start_matches('[').trim_end_matches(']');

    let mut allowed = vec![
        "127.0.0.1".to_string(),
        "localhost".to_string(),
        "::1".to_string(),
    ];
    if let Ok(extra) = std::env::var("CALI_ALLOWED_HOSTS") {
        allowed.extend(extra.split(',').map(|value| value.trim().to_string()));
    }

    if !name.is_empty() && !allowed.iter().any(|candidate| candidate == name) {
        tracing::warn!(%host, "rejected request with a non-loopback Host");
        return (
            axum::http::StatusCode::MISDIRECTED_REQUEST,
            "CaliCode only serves loopback hosts",
        )
            .into_response();
    }
    next.run(request).await
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
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
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    )
}
