mod agent;
mod approvals;
mod asset_search;
mod assets;
mod baselines;
mod blender;
mod capture_persist;
mod compaction;
mod config;
mod devserver;
mod editor_bridge;
mod fileread;
mod goal;
mod graph;
mod image3d;
mod image_mesh;
pub(crate) mod loop_report;
mod mcp;
mod model;
mod pathlock;
mod rpc;
mod sessions;
mod skills;
mod store;
mod tools;
pub(crate) mod video_analysis;
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
use tokio::sync::{broadcast, watch, RwLock};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

/// How long shutdown may take before the process exits regardless.
///
/// This is a backstop, not the normal path: `/events` streams end as soon as
/// [`AppState::shutdown`] flips, so graceful shutdown usually finishes in
/// milliseconds. It only engages when some other response refuses to drain —
/// an in-flight agent turn, say — and it exists because a core that ignores
/// SIGTERM leaks a process on every restart.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<RwLock<AppConfig>>,
    pub projects_root: PathBuf,
    pub sessions_root: PathBuf,
    pub agents: AgentManager,
    pub graphs: graph::GraphManager,
    pub bus: broadcast::Sender<Value>,
    pub tools: Arc<RwLock<HashMap<String, tools::ToolDef>>>,
    pub editor_bridge: editor_bridge::EditorBridge,
    /// Current editor owner per durable session. A single global attachment
    /// made opening a second chat invalidate the first chat's tool routing.
    pub editor_attachment: Arc<RwLock<HashMap<String, editor_bridge::EditorAttachment>>>,
    pub mcp: Arc<mcp::McpManager>,
    /// Client-published asset catalogue (library repos etc.), replaced whole
    /// by `asset_catalog_publish`; read by `asset_search`/`asset_pick`.
    pub asset_catalog: Arc<RwLock<Vec<Value>>>,
    pub workspaces: Arc<RwLock<workspace::Registry>>,
    pub dev_servers: Arc<RwLock<devserver::Servers>>,
    /// Flips to true once shutdown starts. Long-lived responses subscribe and
    /// end themselves; without that, axum's graceful shutdown waits on an SSE
    /// stream that never completes. Held as the sender so any state — including
    /// one built in a test — can hand out fresh receivers.
    pub shutdown: Arc<watch::Sender<bool>>,
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

    // Sessions live alongside projects under `~/.cali/sessions`.
    let sessions_root = projects_root
        .parent()
        .map(|parent| parent.join("sessions"))
        .unwrap_or_else(|| projects_root.join("sessions"));
    std::fs::create_dir_all(&sessions_root).ok();

    // Workspaces are restored AFTER the port is bound, not before.
    //
    // Restoring touches every remembered folder, and that can block for a long
    // time — or forever — when a folder lives on a slow or permission-gated
    // volume. On macOS, replacing the app bundle invalidates its disk-access
    // grant, so the first read of an external-drive workspace stalls behind a
    // TCC prompt. Doing that before `bind` meant core never started listening
    // and the whole app came up dead with "core failed to start".
    let remembered = config.workspaces.clone();
    // Cloned before `config` moves into state; MCP boot runs in the
    // background so a slow server command never delays the port bind.
    let mcp_servers = config.mcp_servers.clone();

    let (bus, _) = broadcast::channel(256);
    let shutdown = Arc::new(watch::channel(false).0);
    let state = AppState {
        config: Arc::new(RwLock::new(config)),
        projects_root,
        sessions_root,
        agents: AgentManager::new(bus.clone()),
        graphs: graph::GraphManager::new(),
        bus: bus.clone(),
        tools: Arc::new(RwLock::new(HashMap::new())),
        editor_bridge: editor_bridge::EditorBridge::new(bus.clone()),
        editor_attachment: Arc::new(RwLock::new(HashMap::new())),
        mcp: Arc::new(mcp::McpManager::default()),
        asset_catalog: Arc::new(RwLock::new(Vec::new())),
        workspaces: Arc::new(RwLock::new(workspace::Registry::new())),
        dev_servers: Arc::new(RwLock::new(devserver::Servers::new())),
        shutdown: shutdown.clone(),
    };

    // Start configured MCP servers in the background (non-fatal): a broken
    // entry shows up in mcp_list as failed, it must never block startup.
    {
        let mcp = state.mcp.clone();
        tokio::spawn(async move {
            mcp.start_all(&mcp_servers).await;
        });
    }

    // Populate the registry in the background. `workspace_list` simply returns
    // fewer entries until this lands, which is recoverable; a core that never
    // binds is not.
    {
        let workspaces = state.workspaces.clone();
        tokio::spawn(async move {
            // spawn_blocking: restore is synchronous filesystem work and can
            // stall for seconds, which would otherwise occupy a runtime worker.
            let restored = tokio::task::spawn_blocking(move || {
                let mut registry = workspace::Registry::new();
                let count = workspace::restore(&mut registry, &remembered).len();
                (registry, count)
            })
            .await;
            match restored {
                Ok((registry, count)) => {
                    if count > 0 {
                        tracing::info!(count, "restored workspaces");
                    }
                    *workspaces.write().await = registry;
                }
                Err(error) => tracing::warn!(%error, "workspace restore failed"),
            }
        });
    }

    // The RPC surface is unauthenticated and can create, overwrite, and revert
    // projects, read files, and drive the agent loop against the user's API
    // keys. `allow_origin(Any)` made all of that reachable from any website the
    // user happened to have open, so origins are restricted to the loopback
    // dev server and the core's own origin. Extra origins can be added via
    // CALI_ALLOWED_ORIGINS (comma-separated) for non-default setups.
    let client_port = std::env::var("CALI_CLIENT_PORT").unwrap_or_else(|_| "5199".to_string());
    let mut origins: Vec<HeaderValue> = [
        format!("http://127.0.0.1:{client_port}"),
        format!("http://localhost:{client_port}"),
        format!("http://127.0.0.1:{}", core_port()),
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
    // reach the running dev servers and MCP children.
    let dev_servers = state.dev_servers.clone();
    let mcp_for_shutdown = state.mcp.clone();
    // Static project files (downloaded glTF models etc.) for the client's
    // loaders, e.g. /projects/<slug>/assets/polyhaven/<id>/<file>.gltf.
    let projects_dir_service = state.projects_root.clone();

    // CORS is not sufficient on its own. A DNS-rebinding attack sends a
    // same-origin-looking request with NO Origin header and a foreign Host, so
    // the origin allowlist never engages — an audit confirmed a request with
    // `Host: evil.attacker.example` and no Origin was dispatched in full.
    // Requiring a loopback Host closes that: after rebinding, the browser
    // still sends the attacker's hostname.
    let host_guard = axum::middleware::from_fn(require_loopback_host);

    let app = Router::new()
        // `DefaultBodyLimit::max` is the per-route cap that lets `video_contact_sheet`
        // send multi-frame base64 payloads up to `video_analysis::MAX_INPUT_BYTES`
        // without axum's plain-text 413 being mis-parsed by the client as a transport
        // outage. The custom `RpcEnvelope` extractor turns a too-large body into a
        // structured JSON-RPC error envelope so the client surfaces the message.
        .route(
            "/rpc",
            post(rpc::rpc_handler).layer(axum::extract::DefaultBodyLimit::max(
                rpc::RPC_BODY_LIMIT_BYTES,
            )),
        )
        // A GET liveness probe. `/` serves the built client, which does not
        // exist until `pnpm build` has run, so it is not a usable readiness
        // signal for tooling — CI waited 180s on it and timed out.
        .route("/health", get(health))
        .route("/events", get(events))
        .nest_service("/projects", ServeDir::new(projects_dir_service))
        .fallback_service(
            ServeDir::new(&dist).not_found_service(ServeFile::new(dist.join("index.html"))),
        )
        // `no-cache` means revalidate, not "never store". Without it the
        // desktop shell's WKWebView heuristically caches `index.html` off
        // `last-modified` and keeps replaying a previous build's asset hashes
        // after an update — the app looks like it silently ignored the new
        // bundle. On loopback the revalidation is a 304 and costs nothing.
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ))
        .layer(cors)
        .layer(host_guard)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state);

    // Both ports are configurable so two instances can coexist. They were
    // hardcoded, so a second core died with "Address already in use" — which
    // made concurrent work on this project genuinely painful.
    let addr = format!("127.0.0.1:{}", core_port());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("CaliCode core listening on http://{}", addr);

    // Dev-server children rely on Child::kill_on_drop, which only fires when
    // the Servers map is dropped. A signalled process does not run
    // destructors, so quitting core used to leave every vite child running.
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;

            // axum's graceful shutdown waits for every in-flight response, and
            // /events is a long-lived SSE stream that never completes on its
            // own — so a core with a browser attached released the port but
            // lingered forever, ignoring repeated SIGTERM and needing SIGKILL.
            // Telling the streams to end is what actually lets shutdown
            // finish; the timer below is only a backstop. `send_replace` rather
            // than `send` so the flag is stored even with no client attached,
            // and a request that arrives mid-shutdown still sees it.
            shutdown.send_replace(true);

            tracing::info!("shutting down; stopping dev servers");
            let ids: Vec<String> = dev_servers.read().await.keys().cloned().collect();
            {
                let mut servers = dev_servers.write().await;
                for id in ids {
                    let _ = devserver::stop(&mut servers, &id).await;
                }
            }
            // MCP children are real processes too; leave none behind.
            mcp_for_shutdown.shutdown_all().await;

            tokio::spawn(async {
                tokio::time::sleep(SHUTDOWN_GRACE).await;
                tracing::warn!(
                    seconds = SHUTDOWN_GRACE.as_secs(),
                    "shutdown grace elapsed with responses still open; exiting"
                );
                std::process::exit(0);
            });
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

/// The port core listens on. `CALI_PORT` overrides the 8765 default.
fn core_port() -> u16 {
    std::env::var("CALI_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8765)
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

async fn events(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.bus.subscribe();
    let shutdown = state.shutdown.subscribe();
    // The stream ends when shutdown starts. It is checked before every wait
    // rather than only selected on, so a client that connects *after* the flag
    // flips gets an ended stream instead of pinning the process open.
    let stream = futures::stream::unfold((rx, shutdown), |(mut rx, mut shutdown)| async move {
        loop {
            if *shutdown.borrow_and_update() {
                return None;
            }
            let received = tokio::select! {
                _ = shutdown.changed() => return None,
                received = rx.recv() => received,
            };
            match received {
                Ok(value) => {
                    let event = Event::default()
                        .event("message")
                        .json_data(value)
                        .unwrap_or_else(|_| Event::default().data("{}"));
                    return Some((Ok(event), (rx, shutdown)));
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
