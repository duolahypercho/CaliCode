//! Caliber Core — the Rust service behind the Caliber Arcade.
//!
//! Owns the game-side responsibilities of the studio:
//! - `GET  /health`            liveness + version
//! - `GET  /scan`              discover local game dev servers by real TCP probe
//! - `POST /games/scaffold`    create a playable starter game inside a project
//! - `GET  /play/{game}/{*path}`  serve a scaffolded game to the Arcade screen
//!
//! The forked studio UI stays TypeScript (it runs in a browser); everything
//! game-side that can live outside the browser belongs here, in Rust.

use std::{collections::HashMap, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    extract::{Path as UrlPath, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::{net::TcpStream, sync::RwLock, time::timeout};
use tower_http::cors::CorsLayer;

pub const PORT: u16 = 4870;
const SCAN_PORTS: &[u16] = &[5173, 3000, 8080, 4321, 1234, 8000, 5000, 8081];
const PROBE_TIMEOUT_MS: u64 = 400;
const STARTER_HTML: &str = include_str!("starter_game.html");
const STARTER_AGENTS: &str = include_str!("starter_agents.md");
const STARTER_CONFIG: &str = r##"{
  "background": { "color": "#05030f" },
  "ship": { "color": "#ffffff", "size": 18, "speed": 0.6 },
  "stars": { "color": "#d6d6d6", "count": 12, "speed": 0.12 }
}
"##;

#[derive(Default)]
struct AppState {
    /// game name -> directory it was scaffolded into
    games: RwLock<HashMap<String, PathBuf>>,
    /// live multi-actor activity feed (user + any number of agents)
    activity: RwLock<Vec<Activity>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Activity {
    actor: String,
    action: String,
    detail: String,
    at_ms: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

async fn push_activity(state: &Shared, actor: &str, action: &str, detail: &str) {
    let mut feed = state.activity.write().await;
    feed.push(Activity {
        actor: actor.to_string(),
        action: action.to_string(),
        detail: detail.to_string(),
        at_ms: now_ms(),
    });
    let len = feed.len();
    if len > 100 {
        feed.drain(0..len - 100);
    }
}

#[derive(Deserialize)]
struct ActivityIn {
    actor: String,
    action: String,
    #[serde(default)]
    detail: String,
}

/// Any agent (or the studio) reports what it is doing to the shared feed.
async fn post_activity(State(state): State<Shared>, Json(a): Json<ActivityIn>) -> Json<serde_json::Value> {
    push_activity(&state, &a.actor, &a.action, &a.detail).await;
    Json(serde_json::json!({ "ok": true }))
}

/// Live status: the most recent activity across all actors, newest last.
async fn get_activity(State(state): State<Shared>) -> Json<Vec<Activity>> {
    let feed = state.activity.read().await;
    let start = feed.len().saturating_sub(30);
    Json(feed[start..].to_vec())
}

type Shared = Arc<AppState>;

#[derive(Serialize)]
struct Health {
    ok: bool,
    name: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
struct ScanHit {
    port: u16,
    url: String,
}

#[derive(Deserialize)]
struct ScaffoldRequest {
    /// Absolute project directory the game folder is created in.
    directory: String,
    /// Game name; becomes the folder and play-route slug.
    name: String,
}

#[derive(Serialize)]
struct ScaffoldResponse {
    slug: String,
    directory: String,
    play_url: String,
}

fn slugify(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "game".into()
    } else {
        slug
    }
}

async fn health() -> Json<Health> {
    Json(Health {
        ok: true,
        name: "caliber-core",
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// Probe common local dev-server ports with real TCP connects (no browser
/// no-cors guesswork) and report everything that is listening.
async fn scan() -> Json<Vec<ScanHit>> {
    let handles: Vec<_> = SCAN_PORTS
        .iter()
        .map(|&port| {
            tokio::spawn(async move {
                let addr = SocketAddr::from(([127, 0, 0, 1], port));
                match timeout(
                    Duration::from_millis(PROBE_TIMEOUT_MS),
                    TcpStream::connect(addr),
                )
                .await
                {
                    Ok(Ok(_)) => Some(ScanHit {
                        port,
                        url: format!("http://localhost:{port}"),
                    }),
                    _ => None,
                }
            })
        })
        .collect();
    let mut hits = Vec::new();
    for handle in handles {
        if let Ok(Some(hit)) = handle.await {
            hits.push(hit);
        }
    }
    Json(hits)
}

async fn scaffold(
    State(state): State<Shared>,
    Json(req): Json<ScaffoldRequest>,
) -> Result<Json<ScaffoldResponse>, (StatusCode, String)> {
    let base = PathBuf::from(&req.directory);
    if !base.is_absolute() || !base.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("not a project directory: {}", req.directory),
        ));
    }
    let slug = slugify(&req.name);
    let game_dir = base.join(format!("caliber-{slug}"));
    tokio::fs::create_dir_all(&game_dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let html = STARTER_HTML.replace("__GAME_TITLE__", &req.name);
    tokio::fs::write(game_dir.join("index.html"), html)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let agents = STARTER_AGENTS.replace("__GAME_TITLE__", &req.name);
    tokio::fs::write(game_dir.join("AGENTS.md"), agents)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    tokio::fs::write(game_dir.join("config.json"), STARTER_CONFIG)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    state
        .games
        .write()
        .await
        .insert(slug.clone(), game_dir.clone());
    push_activity(&state, "core", "scaffold", &slug).await;
    Ok(Json(ScaffoldResponse {
        play_url: format!("http://localhost:{PORT}/play/{slug}/"),
        slug,
        directory: game_dir.display().to_string(),
    }))
}

#[derive(Deserialize)]
struct RegisterRequest {
    /// Absolute path of an existing game folder containing index.html.
    directory: String,
}

#[derive(Serialize)]
struct DiscoveredGame {
    name: String,
    directory: String,
}

/// Register an existing game folder (e.g. one the agent just wrote) so the
/// Arcade can play it.
async fn register(
    State(state): State<Shared>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<ScaffoldResponse>, (StatusCode, String)> {
    let dir = PathBuf::from(&req.directory);
    if !dir.is_absolute() || !dir.join("index.html").is_file() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("not a game folder (no index.html): {}", req.directory),
        ));
    }
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("game")
        .trim_start_matches("caliber-")
        .to_string();
    let slug = slugify(&name);
    state.games.write().await.insert(slug.clone(), dir.clone());
    push_activity(&state, "core", "load", &slug).await;
    Ok(Json(ScaffoldResponse {
        play_url: format!("http://localhost:{PORT}/play/{slug}/"),
        slug,
        directory: dir.display().to_string(),
    }))
}

#[derive(Deserialize)]
struct DiscoverQuery {
    directory: String,
}

/// List immediate subfolders of a project that look like playable games.
async fn discover(
    axum::extract::Query(q): axum::extract::Query<DiscoverQuery>,
) -> Json<Vec<DiscoveredGame>> {
    let mut out = Vec::new();
    let base = PathBuf::from(&q.directory);
    if let Ok(mut entries) = tokio::fs::read_dir(&base).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.is_dir() && path.join("index.html").is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name == "node_modules" || name.starts_with('.') {
                        continue;
                    }
                    out.push(DiscoveredGame {
                        name: name.trim_start_matches("caliber-").to_string(),
                        directory: path.display().to_string(),
                    });
                }
            }
        }
    }
    Json(out)
}

/// Newest modification time (ms since epoch) of any file in the game folder.
async fn game_mtime(
    State(state): State<Shared>,
    UrlPath(game): UrlPath<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let games = state.games.read().await;
    let Some(dir) = games.get(&game) else {
        return Err((StatusCode::NOT_FOUND, "unknown game".into()));
    };
    let mut newest: u128 = 0;
    if let Ok(mut entries) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if let Ok(meta) = entry.metadata().await {
                if let Ok(modified) = meta.modified() {
                    if let Ok(ms) = modified.duration_since(std::time::UNIX_EPOCH) {
                        newest = newest.max(ms.as_millis());
                    }
                }
            }
        }
    }
    Ok(Json(serde_json::json!({ "mtime": newest as u64 })))
}

async fn save_config(
    State(state): State<Shared>,
    UrlPath(game): UrlPath<String>,
    Json(config): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let games = state.games.read().await;
    let Some(dir) = games.get(&game) else {
        return Err((StatusCode::NOT_FOUND, "unknown game".into()));
    };
    let pretty = serde_json::to_string_pretty(&config).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    tokio::fs::write(dir.join("config.json"), pretty + "\n")
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Locate the built studio (packages/app/dist): env override, then upward search.
fn studio_dist() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CALIBER_STUDIO_DIST") {
        let p = PathBuf::from(dir);
        if p.join("index.html").is_file() {
            return Some(p);
        }
    }
    let mut cur = std::env::current_dir().ok()?;
    for _ in 0..5 {
        let candidate = cur.join("packages/app/dist");
        if candidate.join("index.html").is_file() {
            return Some(candidate);
        }
        if !cur.pop() {
            break;
        }
    }
    None
}

/// Serve the production studio build so Caliber runs without a dev server.
async fn studio(UrlPath(path): UrlPath<String>) -> impl IntoResponse {
    serve_studio_file(path).await
}

async fn studio_index() -> impl IntoResponse {
    serve_studio_file(String::new()).await
}

async fn serve_studio_file(path: String) -> axum::response::Response {
    let Some(dist) = studio_dist() else {
        return (StatusCode::NOT_FOUND, "studio build not found — run: bun run --cwd packages/app build")
            .into_response();
    };
    let rel = if path.is_empty() { "index.html".to_string() } else { path };
    let file = dist.join(&rel);
    let Ok(canonical) = file.canonicalize() else {
        // SPA fallback: unknown routes get index.html
        return match tokio::fs::read(dist.join("index.html")).await {
            Ok(bytes) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], bytes).into_response(),
            Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
        };
    };
    let Ok(root) = dist.canonicalize() else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if !canonical.starts_with(&root) {
        return (StatusCode::FORBIDDEN, "path escapes studio dist").into_response();
    }
    match tokio::fs::read(&canonical).await {
        Ok(bytes) => {
            let mime = match canonical.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "text/javascript",
                Some("css") => "text/css",
                Some("json") => "application/json",
                Some("svg") => "image/svg+xml",
                Some("png") => "image/png",
                Some("woff2") => "font/woff2",
                Some("ico") => "image/x-icon",
                _ => "application/octet-stream",
            };
            ([(header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

#[derive(Deserialize)]
struct RecordingUpload {
    /// data:image/jpeg;base64,... frames captured by the game.
    frames: Vec<String>,
    fps: u32,
    duration_ms: u64,
}

/// Persist a recorded animation as numbered JPEG frames + a manifest the
/// agent can read frame by frame.
async fn save_recording(
    State(state): State<Shared>,
    UrlPath(game): UrlPath<String>,
    Json(upload): Json<RecordingUpload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    use base64::Engine;
    let games = state.games.read().await;
    let Some(dir) = games.get(&game) else {
        return Err((StatusCode::NOT_FOUND, "unknown game".into()));
    };
    let rec_dir = dir.join("recording");
    let _ = tokio::fs::remove_dir_all(&rec_dir).await;
    tokio::fs::create_dir_all(&rec_dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut files = Vec::new();
    for (i, frame) in upload.frames.iter().enumerate().take(200) {
        let b64 = frame.split(",").nth(1).unwrap_or(frame);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("frame {i}: {e}")))?;
        let name = format!("frame-{i:03}.jpg");
        tokio::fs::write(rec_dir.join(&name), bytes)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        files.push(name);
    }
    let manifest = serde_json::json!({
        "fps": upload.fps,
        "duration_ms": upload.duration_ms,
        "frame_count": files.len(),
        "frames": files,
        "note": "Read frames in order to see the animation; frame N is at N/fps seconds."
    });
    tokio::fs::write(
        rec_dir.join("recording.json"),
        serde_json::to_string_pretty(&manifest).unwrap_or_default(),
    )
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true, "dir": rec_dir.display().to_string(), "frame_count": manifest["frame_count"] })))
}

async fn play(
    State(state): State<Shared>,
    UrlPath((game, path)): UrlPath<(String, String)>,
) -> impl IntoResponse {
    let games = state.games.read().await;
    let Some(dir) = games.get(&game) else {
        return (StatusCode::NOT_FOUND, "unknown game").into_response();
    };
    let rel = if path.is_empty() {
        "index.html".to_string()
    } else {
        path
    };
    let file = dir.join(&rel);
    // containment: never serve outside the scaffolded game directory
    let Ok(canonical) = file.canonicalize() else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    let Ok(root) = dir.canonicalize() else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if !canonical.starts_with(&root) {
        return (StatusCode::FORBIDDEN, "path escapes game directory").into_response();
    }
    match tokio::fs::read(&canonical).await {
        Ok(bytes) => {
            let mime = match canonical.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "text/javascript",
                Some("css") => "text/css",
                Some("json") => "application/json",
                Some("png") => "image/png",
                Some("svg") => "image/svg+xml",
                _ => "application/octet-stream",
            };
            ([(header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn play_index(state: State<Shared>, UrlPath(game): UrlPath<String>) -> impl IntoResponse {
    play(state, UrlPath((game, String::new()))).await
}

/// Build the caliber-core router.
pub fn router() -> Router {
    let state: Shared = Arc::new(AppState::default());
    Router::new()
        .route("/health", get(health))
        .route("/scan", get(scan))
        .route("/games/scaffold", post(scaffold))
        .route("/games/register", post(register))
        .route("/games/discover", get(discover))
        .route("/activity", get(get_activity).post(post_activity))
        .route("/games/{game}/config", post(save_config))
        .route("/games/{game}/mtime", get(game_mtime))
        .route("/games/{game}/recording", post(save_recording))
        .route("/studio/", get(studio_index))
        .route("/studio/{*path}", get(studio))
        .route("/play/{game}/", get(play_index))
        .route("/play/{game}/{*path}", get(play))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

/// Bind and serve caliber-core on its well-known port.
pub async fn serve() {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            println!("caliber-core listening on http://{addr}");
            if let Err(err) = axum::serve(listener, router()).await {
                eprintln!("caliber-core server error: {err}");
            }
        }
        Err(_) => {
            // Another Caliber process already owns the core port; reuse it.
            println!("caliber-core already running on http://{addr}; reusing it");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::slugify;

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Neon Dash!"), "neon-dash");
        assert_eq!(slugify("  "), "game");
        assert_eq!(slugify("Star--Sweeper"), "star--sweeper");
    }
}
