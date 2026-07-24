//! Caliber as an actual application.
//!
//! One Rust binary that:
//! 1. Runs caliber-core (scan / scaffold / play) in-process.
//! 2. Opens a native window (tao + wry — the system webview, no Electron,
//!    no browser chrome) showing the Caliber studio.
//!
//! The studio UI itself is web content (that is inherent to the OpenCode
//! fork); this binary is its native home. Point it at a running studio with
//! CALIBER_STUDIO_URL (defaults to the dev server).

use std::{
    net::TcpStream,
    process::{Child, Command},
    thread,
    time::Duration,
};

use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

fn main() -> wry::Result<()> {
    // Prefer a studio bundled next to the executable. Layouts per platform:
    // macOS: Caliber.app/Contents/MacOS/<exe> -> ../Resources/studio
    // Windows/Linux: <exe dir>/studio
    if std::env::var("CALIBER_STUDIO_DIST").is_err() {
        if let Ok(exe) = std::env::current_exe() {
            let candidates = [
                exe.parent().map(|p| p.join("studio")),
                exe.parent()
                    .and_then(|p| p.parent())
                    .map(|p| p.join("Resources/studio")),
            ];
            for bundled in candidates.into_iter().flatten() {
                if bundled.join("index.html").is_file() {
                    std::env::set_var("CALIBER_STUDIO_DIST", &bundled);
                    break;
                }
            }
        }
    }

    // Spawn the agent backend (opencode serve) unless one is already running.
    let mut backend: Option<Child> = spawn_backend();

    // caliber-core runs inside the app process.
    thread::spawn(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("caliber-core runtime")
            .block_on(caliber_core::serve());
    });

    let studio_url = std::env::var("CALIBER_STUDIO_URL")
        .unwrap_or_else(|_| format!("http://localhost:{}/studio/", caliber_core::PORT));
    // Give the in-process core a moment to bind before the webview loads.
    thread::sleep(std::time::Duration::from_millis(350));

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Caliber")
        .with_inner_size(LogicalSize::new(1440.0, 900.0))
        .with_min_inner_size(LogicalSize::new(960.0, 600.0))
        .build(&event_loop)
        .expect("caliber window");

    let _webview = WebViewBuilder::new().with_url(&studio_url).build(&window)?;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            if let Some(child) = backend.as_mut() {
                let _ = child.kill();
            }
            *control_flow = ControlFlow::Exit;
        }
    });
}

/// Start `opencode serve` as a managed child if nothing answers on its port.
/// CALIBER_OPENCODE_DIR overrides the development default location.
fn spawn_backend() -> Option<Child> {
    let addr = "127.0.0.1:4096".parse().ok()?;
    if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
        return None;
    }
    let dir = std::env::var("CALIBER_OPENCODE_DIR")
        .map(std::path::PathBuf::from)
        .ok()
        .or_else(default_opencode_dir)?;
    Command::new("bun")
        .args(["run", "--conditions=browser", "src/index.ts", "serve", "--port", "4096"])
        .current_dir(dir)
        .spawn()
        .ok()
}

/// Locate packages/opencode by walking up from the executable and the working
/// directory — works from a dev build (caliber-core/target/{debug,release})
/// and from a checkout root on any OS, with no hardcoded developer path.
fn default_opencode_dir() -> Option<std::path::PathBuf> {
    let mut starts: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        starts.push(exe);
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    for start in starts {
        let mut dir = Some(start.as_path());
        while let Some(d) = dir {
            let candidate = d.join("packages").join("opencode");
            if candidate.join("src").join("index.ts").is_file() {
                return Some(candidate);
            }
            dir = d.parent();
        }
    }
    None
}
