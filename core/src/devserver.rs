//! Runs a workspace's own dev server so its output can be shown in PLAY.
//!
//! Two constraints drive the design:
//!
//! 1. Vite binds `localhost` by default, which on macOS resolves to `::1`
//!    only — a readiness poll against `127.0.0.1` would hang forever. The host
//!    and port are always passed explicitly.
//! 2. `npm run dev` leaves an orphaned `node vite` behind when the npm parent
//!    is killed. The local binary is executed directly wherever possible.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::workspace::Workspace;

/// Ports reserved for workspace dev servers. 5199 is CaliCode's own client and
/// 8765 is core, so neither is reachable here.
const PORT_RANGE: std::ops::Range<u16> = 5300..5400;
const MAX_SERVERS: usize = 3;
const LOG_CAPACITY: usize = 2000;
const READY_TIMEOUT_MS: u64 = 60_000;
const POLL_INTERVAL_MS: u64 = 250;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Starting,
    Ready,
    Crashed,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::Starting => "starting",
            Status::Ready => "ready",
            Status::Crashed => "crashed",
        }
    }
}

pub struct DevServer {
    pub workspace_id: String,
    pub port: u16,
    pub status: Arc<Mutex<Status>>,
    pub logs: Arc<Mutex<VecDeque<String>>>,
    child: Child,
}

impl DevServer {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

pub type Servers = HashMap<String, DevServer>;

fn free_port() -> Result<u16> {
    for port in PORT_RANGE {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    anyhow::bail!("no free port in {}..{}", PORT_RANGE.start, PORT_RANGE.end)
}

/// Resolves a script *name* to a command. A raw command string is never
/// accepted: `agent_chat` can reach core tools, so taking one would hand the
/// model arbitrary code execution.
fn resolve_command(root: &Path, script: &str, port: u16) -> Result<Command> {
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("package.json")).context("workspace has no package.json")?,
    )?;
    manifest
        .get("scripts")
        .and_then(|s| s.get(script))
        .and_then(Value::as_str)
        .with_context(|| format!("package.json has no '{script}' script"))?;

    let port_args = ["--host", "127.0.0.1", "--port", &port.to_string(), "--strictPort"]
        .map(str::to_string);

    let local_vite = root.join("node_modules/.bin/vite");
    let mut command = if local_vite.exists() {
        let mut c = Command::new(&local_vite);
        c.args(port_args);
        c
    } else {
        let mut c = Command::new("npm");
        c.arg("run").arg(script).arg("--");
        c.args(port_args);
        c
    };

    command.current_dir(root);
    // Scrub the environment so CALI_*_API_KEY and friends never reach a child.
    command.env_clear();
    for key in ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SHELL"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.env("NODE_ENV", "development");
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.kill_on_drop(true);
    Ok(command)
}

/// Streams one of the child's pipes into the ring buffer and onto the SSE bus.
fn drain<R>(
    reader: R,
    stream: &'static str,
    workspace_id: &str,
    logs: Arc<Mutex<VecDeque<String>>>,
    bus: tokio::sync::broadcast::Sender<Value>,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let id = workspace_id.to_string();
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(mut buffer) = logs.lock() {
                if buffer.len() >= LOG_CAPACITY {
                    buffer.pop_front();
                }
                buffer.push_back(format!("[{stream}] {line}"));
            }
            let _ = bus.send(json!({
                "type": "devserver.log", "workspaceId": id, "stream": stream, "text": line,
            }));
        }
    });
}

pub async fn start(
    servers: &mut Servers,
    workspace: &Workspace,
    script: &str,
    bus: tokio::sync::broadcast::Sender<Value>,
) -> Result<Value> {
    if servers.contains_key(&workspace.id) {
        anyhow::bail!("a dev server is already running for {}", workspace.name);
    }
    if servers.len() >= MAX_SERVERS {
        anyhow::bail!("at most {MAX_SERVERS} dev servers may run at once");
    }

    let port = free_port()?;
    let mut command = resolve_command(&workspace.root, script, port)?;
    let mut child = command.spawn().context("failed to start the dev server")?;

    let logs = Arc::new(Mutex::new(VecDeque::with_capacity(LOG_CAPACITY)));
    let status = Arc::new(Mutex::new(Status::Starting));

    if let Some(stdout) = child.stdout.take() {
        drain(stdout, "stdout", &workspace.id, Arc::clone(&logs), bus.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        drain(stderr, "stderr", &workspace.id, Arc::clone(&logs), bus.clone());
    }

    // Poll for a real HTTP response. Vite prints "ready in NNms" before it can
    // actually serve, so the stdout banner is not a readiness signal.
    {
        let status = Arc::clone(&status);
        let bus = bus.clone();
        let id = workspace.id.clone();
        let url = format!("http://127.0.0.1:{port}/");
        tokio::spawn(async move {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(READY_TIMEOUT_MS);
            let client = reqwest::Client::new();
            loop {
                if tokio::time::Instant::now() > deadline {
                    if let Ok(mut slot) = status.lock() {
                        *slot = Status::Crashed;
                    }
                    let _ = bus.send(json!({
                        "type": "devserver.status", "workspaceId": id, "status": "crashed",
                        "error": "timed out waiting for the dev server",
                    }));
                    return;
                }
                if client.get(&url).send().await.map(|r| r.status().is_success()).unwrap_or(false) {
                    if let Ok(mut slot) = status.lock() {
                        *slot = Status::Ready;
                    }
                    let _ = bus.send(json!({
                        "type": "devserver.status", "workspaceId": id, "status": "ready", "url": url,
                    }));
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
            }
        });
    }

    let server = DevServer { workspace_id: workspace.id.clone(), port, status, logs, child };
    let response = json!({
        "workspaceId": workspace.id, "status": "starting", "port": port, "url": server.url(),
    });
    servers.insert(workspace.id.clone(), server);
    Ok(response)
}

pub async fn stop(servers: &mut Servers, id: &str) -> Result<Value> {
    match servers.remove(id) {
        Some(mut server) => {
            let _ = server.child.kill().await;
            Ok(json!({ "workspaceId": id, "stopped": true }))
        }
        None => Ok(json!({ "workspaceId": id, "stopped": false })),
    }
}

pub fn status(servers: &Servers, id: &str) -> Value {
    match servers.get(id) {
        Some(server) => {
            let state = server.status.lock().map(|s| *s).unwrap_or(Status::Crashed);
            json!({
                "workspaceId": server.workspace_id,
                "status": state.as_str(),
                "port": server.port,
                "url": server.url(),
            })
        }
        None => json!({ "workspaceId": id, "status": "stopped" }),
    }
}

pub fn logs(servers: &Servers, id: &str, limit: usize) -> Value {
    let lines: Vec<String> = servers
        .get(id)
        .and_then(|server| server.logs.lock().ok().map(|buffer| {
            buffer.iter().rev().take(limit).rev().cloned().collect()
        }))
        .unwrap_or_default();
    json!({ "workspaceId": id, "lines": lines })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_with(scripts: &str) -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package.json"), scripts).unwrap();
        let root = dir.path().canonicalize().unwrap();
        let workspace = Workspace { id: "ws-test".into(), name: "test".into(), root };
        (dir, workspace)
    }

    #[test]
    fn resolve_command_requires_a_declared_script() {
        let (_dir, workspace) = workspace_with(r#"{"scripts":{"dev":"vite"}}"#);
        assert!(resolve_command(&workspace.root, "dev", 5300).is_ok());
        // An undeclared name must not become a command — agent_chat can reach
        // core tools, so accepting one would be remote code execution.
        assert!(resolve_command(&workspace.root, "rm -rf /", 5300).is_err());
        assert!(resolve_command(&workspace.root, "nonexistent", 5300).is_err());
    }

    #[test]
    fn resolve_command_pins_host_and_port() {
        let (_dir, workspace) = workspace_with(r#"{"scripts":{"dev":"vite"}}"#);
        let command = resolve_command(&workspace.root, "dev", 5321).unwrap();
        let args: Vec<String> = command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        // Vite defaults to localhost, which resolves to ::1 only on macOS, so
        // a 127.0.0.1 readiness poll would never succeed without these.
        assert!(args.contains(&"--host".to_string()));
        assert!(args.contains(&"127.0.0.1".to_string()));
        assert!(args.contains(&"5321".to_string()));
        assert!(args.contains(&"--strictPort".to_string()));
    }

    #[test]
    fn resolve_command_scrubs_secrets_from_the_environment() {
        let (_dir, workspace) = workspace_with(r#"{"scripts":{"dev":"vite"}}"#);
        std::env::set_var("CALI_OPENAI_API_KEY", "sk-should-not-leak");
        let command = resolve_command(&workspace.root, "dev", 5300).unwrap();
        let leaked = command
            .as_std()
            .get_envs()
            .any(|(k, _)| k.to_string_lossy().starts_with("CALI_"));
        std::env::remove_var("CALI_OPENAI_API_KEY");
        assert!(!leaked, "API keys must not reach a spawned dev server");
    }

    #[test]
    fn free_port_is_in_the_reserved_range() {
        let port = free_port().unwrap();
        assert!(PORT_RANGE.contains(&port));
        assert_ne!(port, 5199, "must not collide with the CaliCode client");
        assert_ne!(port, 8765, "must not collide with core");
    }

    #[test]
    fn status_reports_stopped_for_unknown_workspaces() {
        let servers = Servers::new();
        assert_eq!(status(&servers, "ws-missing")["status"], "stopped");
    }
}
