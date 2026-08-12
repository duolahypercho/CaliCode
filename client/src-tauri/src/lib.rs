//! CaliCode desktop shell.
//!
//! The web editor is served in full by the Rust core: `/rpc`, `/events`, and
//! the built client all live at core's own origin. Packaged builds launch the
//! bundled `cali-core` sidecar; debug builds attach to the live core started by
//! `scripts/dev.sh`. In both cases the native window points at
//! `http://127.0.0.1:8765` once the port is accepting connections. Everything
//! the webview does is same-origin — no CORS, no proxy, no changes to the
//! client's `fetch("/rpc")` / `EventSource("/events")`.

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewWindow};

/// Port core listens on for the packaged app. Fixed so the window URL is known
/// up front. A browser dev instance on the same port would collide — that is a
/// dev-only concern, documented in the README.
const CORE_PORT: u16 = 8765;

/// Holds the core child so it can be killed when the app exits.
struct CoreProcess(Arc<Mutex<Option<Child>>>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CoreStartup {
    Starting,
    Ready,
    PortBusy,
    SpawnFailed,
    LiveCoreUnavailable,
}

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
    // `tauri dev` should use the current client/dist next to the source tree.
    // A staged resources/dist from the last desktop build is intentionally
    // ignored in debug mode; otherwise a stale bundle can mask web changes.
    if cfg!(debug_assertions) {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dist");
        return dev.exists().then_some(dev);
    }
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
fn wait_for_core(port: u16, attempts: u32, process: &Arc<Mutex<Option<Child>>>) -> bool {
    let addr = format!("127.0.0.1:{port}");
    for _ in 0..attempts {
        // A preflight check cannot eliminate a race where another process
        // binds the port between the check and our sidecar spawn. Observe the
        // child too, so readiness never attaches the window to that process.
        if let Ok(mut child) = process.lock() {
            if let Some(core) = child.as_mut() {
                if matches!(core.try_wait(), Ok(Some(_))) {
                    return false;
                }
            }
        }
        if let Ok(addr) = addr.parse() {
            if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn show_core(window: &WebviewWindow, startup: CoreStartup) {
    if startup == CoreStartup::Ready {
        let url = format!("http://127.0.0.1:{CORE_PORT}/");
        if let Ok(url) = url.parse() {
            let _ = window.navigate(url);
        }
    } else {
        let message = match startup {
            CoreStartup::PortBusy => {
                "CaliCode could not start its core because port 8765 is already in use. Quit the other CaliCode/browser core or use a separate dev port."
            }
            CoreStartup::SpawnFailed => {
                "CaliCode could not launch its bundled core. Rebuild the desktop app and try again."
            }
            CoreStartup::Starting => {
                "CaliCode core did not become ready on port 8765. Check the app logs and try again."
            }
            CoreStartup::LiveCoreUnavailable => {
                "Desktop development mode expects a live core on port 8765. Run ./scripts/dev.sh first, then relaunch the desktop shell."
            }
            CoreStartup::Ready => unreachable!(),
        };
        // Core never came up. Surface a plain message instead of a blank
        // window so the failure is visible and actionable.
        let escaped = message.replace('\\', "\\\\").replace('\'', "\\'");
        let _ = window.eval(format!(
            "document.body.innerHTML = '<div style=\"font:16px system-ui;color:#e2e8f0;\
                 background:#0f172a;height:100vh;display:flex;align-items:center;\
                 justify-content:center;text-align:center;padding:2rem\">{escaped}</div>';",
        ));
    }
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let core_process = Arc::new(Mutex::new(None));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(CoreProcess(core_process.clone()))
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
            let startup = if cfg!(debug_assertions) {
                // `pnpm desktop:dev` deliberately attaches to the live core
                // started by scripts/dev.sh. A debug Tauri shell must not
                // spawn a second sidecar and fight that process for 8765.
                if port_is_open(CORE_PORT) {
                    log::info!("attaching desktop dev shell to live core on port {CORE_PORT}");
                    CoreStartup::Starting
                } else {
                    log::error!("desktop dev shell requires a live core on port {CORE_PORT}");
                    CoreStartup::LiveCoreUnavailable
                }
            } else if port_is_open(CORE_PORT) {
                log::error!("core port {CORE_PORT} is already in use; refusing to attach the desktop window");
                CoreStartup::PortBusy
            } else {
                match spawn_core(&binary, dist) {
                    Ok(child) => {
                        app.state::<CoreProcess>().0.lock().unwrap().replace(child);
                        CoreStartup::Starting
                    }
                    Err(err) => {
                        log::error!("failed to spawn cali-core at {binary:?}: {err}");
                        CoreStartup::SpawnFailed
                    }
                }
            };

            // Poll for readiness off the main thread so the UI thread stays
            // responsive, then navigate + show the window.
            let window = app.get_webview_window("main").expect("main window exists");
            let process = app.state::<CoreProcess>().0.clone();
            std::thread::spawn(move || {
                let startup = match startup {
                    CoreStartup::Starting if wait_for_core(CORE_PORT, 100, &process) => CoreStartup::Ready,
                    other => other,
                };
                let target = window.clone();
                let _ = window.run_on_main_thread(move || show_core(&target, startup));
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

fn port_is_open(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    addr.parse()
        .ok()
        .and_then(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(150)).ok())
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_states_are_distinct() {
        assert_ne!(CoreStartup::PortBusy, CoreStartup::SpawnFailed);
        assert_ne!(CoreStartup::Starting, CoreStartup::Ready);
    }

    #[test]
    fn closed_port_is_not_reported_as_open() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind test port");
        let port = listener.local_addr().expect("test port address").port();
        assert!(port_is_open(port));
        drop(listener);
        assert!(!port_is_open(port));
    }
}
