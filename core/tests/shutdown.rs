//! SIGTERM has to kill core even while a browser client holds `/events` open.
//!
//! Regression test. axum's graceful shutdown waits for every in-flight
//! response, and `/events` is an SSE stream that never completes on its own, so
//! a core with a browser attached used to release its listening socket — which
//! made a restart *look* clean, because the port freed up — and then linger
//! forever with the SSE connections still established, ignoring further
//! SIGTERMs and needing SIGKILL. An e2e suite that repeatedly restarts core
//! accumulated a stale process each time.
#![cfg(unix)]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// The bound the fix has to hold. Deliberately below core's own
/// `SHUTDOWN_GRACE` backstop (5s) so a pass means the SSE streams actually
/// ended, not that the force-exit timer papered over a hang.
const MUST_EXIT_WITHIN: Duration = Duration::from_secs(3);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

#[test]
fn exits_on_sigterm_with_an_events_client_attached() {
    let home = tempfile::tempdir().expect("tempdir");
    let port = free_port();
    let mut child = spawn_core(home.path(), port);

    // Fail loudly rather than leaving a stray core behind if any step panics.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wait_until_healthy(port);

        // Held open for the rest of the test: this is the connection that used
        // to pin the process open.
        let _events = open_events_stream(port);

        let sent = Instant::now();
        sigterm(&child);

        let status = loop {
            match child.try_wait().expect("try_wait") {
                Some(status) => break status,
                None if sent.elapsed() > MUST_EXIT_WITHIN => panic!(
                    "core still running {:?} after SIGTERM with an /events client attached",
                    sent.elapsed()
                ),
                None => std::thread::sleep(Duration::from_millis(25)),
            }
        };
        assert!(
            status.success(),
            "core exited with a failure status: {status:?}"
        );
    }));

    let _ = child.kill();
    let _ = child.wait();
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

/// A second SIGTERM must not be needed, and the first must not be ignored when
/// no client is attached either.
#[test]
fn exits_on_sigterm_with_no_client_attached() {
    let home = tempfile::tempdir().expect("tempdir");
    let port = free_port();
    let mut child = spawn_core(home.path(), port);

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        wait_until_healthy(port);
        let sent = Instant::now();
        sigterm(&child);
        loop {
            match child.try_wait().expect("try_wait") {
                Some(status) => {
                    assert!(status.success(), "core exited with {status:?}");
                    return;
                }
                None if sent.elapsed() > MUST_EXIT_WITHIN => {
                    panic!("core still running {:?} after SIGTERM", sent.elapsed())
                }
                None => std::thread::sleep(Duration::from_millis(25)),
            }
        }
    }));

    let _ = child.kill();
    let _ = child.wait();
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

/// Asks the OS for an unused port, then releases it for core to bind.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("bind ephemeral port")
        .local_addr()
        .expect("local_addr")
        .port()
}

/// Runs the real binary, pointed at a throwaway home so it neither reads nor
/// writes the developer's `~/.cali`.
fn spawn_core(home: &Path, port: u16) -> Child {
    Command::new(env!("CARGO_BIN_EXE_cali-core"))
        .env("HOME", home)
        .env("CALI_CONFIG", home.join("config.yaml"))
        .env("CALI_PROJECTS_DIR", home.join("projects"))
        .env("CALI_PORT", port.to_string())
        .env("CALI_DIST", home.join("dist"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn cali-core")
}

fn sigterm(child: &Child) {
    let status = Command::new("kill")
        .arg("-TERM")
        .arg(child.id().to_string())
        .status()
        .expect("run kill");
    assert!(status.success(), "kill -TERM failed: {status:?}");
}

/// Polls `/health` until core answers. `/` is not usable here — it serves the
/// built client, which may not exist.
fn wait_until_healthy(port: u16) {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        if let Some(response) = request(port, "/health") {
            if response.contains("200 OK") {
                return;
            }
        }
        assert!(
            Instant::now() < deadline,
            "core never became healthy on port {port}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Opens `/events` and reads the response head, so the SSE handler is known to
/// be running and the connection registered as in-flight before we signal. The
/// returned socket must stay alive for the assertion to mean anything.
fn open_events_stream(port: u16) -> TcpStream {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect for /events");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("read timeout");
    stream
        .write_all(b"GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n")
        .expect("write /events request");
    stream.flush().expect("flush");

    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        match stream.read(&mut byte) {
            Ok(0) => panic!("/events closed before sending a response head"),
            Ok(_) => head.push(byte[0]),
            Err(error) => panic!("reading /events response head: {error}"),
        }
    }
    let head = String::from_utf8_lossy(&head).to_string();
    assert!(
        head.contains("200 OK"),
        "/events did not return 200: {head}"
    );
    assert!(
        head.to_ascii_lowercase().contains("text/event-stream"),
        "/events is not an SSE stream: {head}"
    );
    stream
}

/// Minimal one-shot HTTP/1.1 GET. Returns None if core is not accepting yet.
fn request(port: u16, path: &str) -> Option<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    Some(response)
}
