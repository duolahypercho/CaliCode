//! CaliCode desktop shell.
//!
//! The web editor is served in full by the Rust core: `/rpc`, `/events`, and
//! the built client all live at core's own origin. So this shell does exactly
//! two things: launch the bundled `cali-core` sidecar, then point one native
//! window at `http://127.0.0.1:8765` once the port is accepting connections.
//! Everything the webview does is same-origin — no CORS, no proxy, no changes
//! to the client's `fetch("/rpc")` / `EventSource("/events")`.

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewWindow};

/// Port core listens on for the packaged app. Fixed so the window URL is known
/// up front. A browser dev instance on the same port would collide — that is a
/// dev-only concern, documented in the README.
const CORE_PORT: u16 = 8765;

/// Holds the core child so it can be killed when the app exits.
struct CoreProcess(Mutex<Option<Child>>);

/// Resolve the `cali-core` binary. Packaged: a sibling of the app executable
/// in `Contents/MacOS`. Dev (`tauri dev`): the `binaries/` staging file named
/// with the target triple.
fn resolve_core_binary() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join("cali-core");
            if sibling.exists() {
                return sibling;
            }
        }
    }
    let triple = env!("TARGET");
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("cali-core-{triple}"))
}

/// Resolve the built client `dist`. Packaged: bundled under the resource dir.
/// Dev: the sibling `client/dist` produced by `pnpm build`.
fn resolve_dist(app: &tauri::App) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("resources").join("dist");
        if bundled.exists() {
            return Some(bundled);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("dist");
    dev.exists().then_some(dev)
}

/// Spawn the core JSON-RPC service. `CALI_DIST` makes core serve the built
/// client from the resolved path regardless of the child's working directory.
fn spawn_core(binary: &PathBuf, dist: Option<PathBuf>) -> std::io::Result<Child> {
    let mut cmd = Command::new(binary);
    cmd.env("CALI_PORT", CORE_PORT.to_string());
    if let Some(dist) = dist {
        cmd.env("CALI_DIST", dist);
    }
    cmd.spawn()
}

/// Block until the port accepts a TCP connection or the deadline passes.
/// A successful connect means core has bound and is serving.
fn wait_for_core(port: u16, attempts: u32) -> bool {
    let addr = format!("127.0.0.1:{port}");
    for _ in 0..attempts {
        if let Ok(addr) = addr.parse() {
            if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn show_core(window: &WebviewWindow, ready: bool) {
    if ready {
        let url = format!("http://127.0.0.1:{CORE_PORT}/");
        if let Ok(url) = url.parse() {
            let _ = window.navigate(url);
        }
    } else {
        // Core never came up. Surface a plain message instead of a blank
        // window so the failure is visible.
        let _ = window.eval(
            "document.body.innerHTML = '<div style=\"font:16px system-ui;color:#e2e8f0;\
             background:#0f172a;height:100vh;display:flex;align-items:center;\
             justify-content:center;text-align:center;padding:2rem\">CaliCode core \
             failed to start on port 8765.<br>Is another instance already using it?</div>';",
        );
    }
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CoreProcess(Mutex::new(None)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let binary = resolve_core_binary();
            let dist = resolve_dist(app);
            match spawn_core(&binary, dist) {
                Ok(child) => {
                    app.state::<CoreProcess>().0.lock().unwrap().replace(child);
                }
                Err(err) => {
                    log::error!("failed to spawn cali-core at {binary:?}: {err}");
                }
            }

            // Poll for readiness off the main thread so the UI thread stays
            // responsive, then navigate + show the window.
            let window = app.get_webview_window("main").expect("main window exists");
            std::thread::spawn(move || {
                let ready = wait_for_core(CORE_PORT, 100); // ~20s ceiling
                let target = window.clone();
                let _ = window.run_on_main_thread(move || show_core(&target, ready));
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building CaliCode")
        .run(|app, event| {
            // Kill core when the app is exiting so no orphan server lingers.
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<CoreProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
