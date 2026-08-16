//! MCP client: user-configured servers contribute tools to agent sessions.
//!
//! Two transports:
//! - **stdio** (default): JSON-RPC 2.0 over the child's stdin/stdout, one
//!   JSON object per line (the MCP stdio framing).
//! - **http**: MCP streamable HTTP — each JSON-RPC message is POSTed to the
//!   configured `url`; the `Mcp-Session-Id` header returned by `initialize`
//!   is echoed on every later request. Responses arrive as `application/json`
//!   or as a `text/event-stream` body carrying the response event; no
//!   standing SSE subscription is opened (v1 only needs `tools/list` +
//!   `tools/call`).
//!
//! Protocol subset implemented (v1): `initialize` →
//! `notifications/initialized` → `tools/list` (paginated, cap 500) at spawn;
//! `tools/call` per tool invocation. Server-initiated requests (sampling,
//! roots) are answered with `-32601 method not found`; server notifications
//! are read and dropped.
//!
//! Tool names are namespaced `mcp__<serverId>__<toolName>` so they can never
//! collide with core or browser tools; `tool_register` reserves the `mcp__`
//! prefix on the browser side. Tools from servers without `trust: true` are
//! treated as destructive by the permission model. Per-server
//! `tools: {include, exclude}` filters (fnmatch globs over the server's own
//! tool names) are enforced both when building tool defs and on every call.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex, RwLock};
use tokio::time::{timeout, Duration};

use crate::config::{McpServerConfig, McpToolFilter};
use crate::sandbox;
use crate::tools::{ToolDef, ToolKind};

const INIT_TIMEOUT: Duration = Duration::from_secs(10);
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
const SHUTDOWN_WAIT: Duration = Duration::from_secs(2);
/// A misbehaving server cannot flood the prompt with unlimited tools.
const MAX_TOOLS_PER_SERVER: usize = 500;
pub const MCP_PREFIX: &str = "mcp__";
const PROTOCOL_VERSION: &str = "2025-06-18";
const SESSION_HEADER: &str = "Mcp-Session-Id";

pub fn is_mcp_name(name: &str) -> bool {
    name.starts_with(MCP_PREFIX)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    /// Name as the server declared it.
    pub remote_name: String,
    /// `mcp__<id>__<clamped-name>`; what the model sees.
    pub namespaced: String,
    pub description: String,
    /// The server's `inputSchema`, passed through untouched. Wrapped into an
    /// empty object schema at `tool_defs` time when it is not object-typed.
    pub input_schema: Value,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum McpStatus {
    /// The count field is `toolCount`, not `tools`: this enum is flattened
    /// into [`McpServerReport`], which already owns the `tools` key.
    Running {
        #[serde(rename = "toolCount")]
        tool_count: usize,
    },
    Failed {
        error: String,
    },
    Disabled,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerReport {
    pub id: String,
    pub transport: String,
    pub command: String,
    pub url: String,
    pub trust: bool,
    #[serde(flatten)]
    pub status: McpStatus,
    /// Empty unless running; already narrowed by the server's tool filter.
    pub tools: Vec<McpToolInfo>,
    /// Declared by the project's `.cali/config.yaml` rather than by the user.
    #[serde(rename = "projectScoped")]
    pub project_scoped: bool,
    /// A project-scoped server the user has not approved: reported so the UI
    /// can offer an approve action, but disabled and never spawned.
    #[serde(rename = "pendingConsent")]
    pub pending_consent: bool,
}

/// Minimal fnmatch-style glob: `*` (any run), `?` (any one char), `[...]`
/// character classes with `!`/`^` negation and `a-z` ranges. Case-sensitive.
/// An unterminated class never matches.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star_pi, mut star_ti) = (usize::MAX, 0usize);
    while ti < t.len() {
        let mut advanced = false;
        if pi < p.len() {
            match p[pi] {
                '*' => {
                    star_pi = pi;
                    star_ti = ti;
                    pi += 1;
                    continue;
                }
                '?' => {
                    pi += 1;
                    ti += 1;
                    advanced = true;
                }
                '[' => {
                    if let Some((matched, next_pi)) = match_class(&p, pi, t[ti]) {
                        if matched {
                            pi = next_pi;
                            ti += 1;
                            advanced = true;
                        }
                    }
                }
                c => {
                    if c == t[ti] {
                        pi += 1;
                        ti += 1;
                        advanced = true;
                    }
                }
            }
        }
        if advanced {
            continue;
        }
        // Mismatch: backtrack to the last `*`, letting it swallow one more
        // char; without one the match fails.
        if star_pi == usize::MAX {
            return false;
        }
        pi = star_pi + 1;
        star_ti += 1;
        ti = star_ti;
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Match `c` against the class starting at `p[start]` (which is `[`).
/// Returns `(matched, index after the closing bracket)`, or None when the
/// class never closes.
fn match_class(p: &[char], start: usize, c: char) -> Option<(bool, usize)> {
    let mut i = start + 1;
    let mut negate = false;
    if i < p.len() && (p[i] == '!' || p[i] == '^') {
        negate = true;
        i += 1;
    }
    let mut matched = false;
    let mut first = true;
    while i < p.len() {
        if p[i] == ']' && !first {
            return Some((matched != negate, i + 1));
        }
        first = false;
        if i + 2 < p.len() && p[i + 1] == '-' && p[i + 2] != ']' {
            if p[i] <= c && c <= p[i + 2] {
                matched = true;
            }
            i += 3;
        } else {
            if p[i] == c {
                matched = true;
            }
            i += 1;
        }
    }
    None
}

/// Per-server tool filter. A non-empty `include` is an allowlist and wins on
/// conflict with `exclude`; with `include` empty, everything not matching
/// `exclude` passes. Matched against the server's own (remote) tool name.
pub fn tool_filter_allows(filter: &McpToolFilter, remote_name: &str) -> bool {
    if !filter.include.is_empty() {
        return filter
            .include
            .iter()
            .any(|pattern| glob_match(pattern, remote_name));
    }
    !filter
        .exclude
        .iter()
        .any(|pattern| glob_match(pattern, remote_name))
}

/// One live connection to an MCP server, over either transport.
pub struct McpClient {
    server_id: String,
    cfg: McpServerConfig,
    transport: Transport,
    /// Fixed after spawn + tools/list in v1 (no listChanged subscription).
    /// Unfiltered; the tool filter is applied at the manager surface.
    pub tools: Vec<McpToolInfo>,
}

enum Transport {
    Stdio(StdioTransport),
    Http(HttpTransport),
}

impl McpClient {
    /// Connect per `cfg.transport`, run the initialize handshake and fetch
    /// the tool list. Any failure tears the connection down and returns Err.
    pub async fn start(cfg: McpServerConfig) -> Result<Arc<Self>> {
        let transport = match cfg.transport.as_str() {
            "http" => Transport::Http(HttpTransport::new(&cfg)?),
            _ => Transport::Stdio(StdioTransport::spawn(&cfg)?),
        };
        let mut client = Self {
            server_id: cfg.id.clone(),
            cfg,
            transport,
            tools: Vec::new(),
        };
        match client.handshake().await {
            Ok(tools) => {
                client.tools = tools;
                Ok(Arc::new(client))
            }
            Err(error) => {
                client.shutdown().await;
                Err(error)
            }
        }
    }

    async fn handshake(&self) -> Result<Vec<McpToolInfo>> {
        let init = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": "cali-core", "version": env!("CARGO_PKG_VERSION") }
                }),
                INIT_TIMEOUT,
            )
            .await?;
        let echoed = init
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or("");
        if echoed != PROTOCOL_VERSION {
            // Accept any echo; a version skew is diagnostic, not fatal.
            tracing::debug!(server = %self.server_id, version = %echoed, "mcp protocol version differs");
        }
        self.notify("notifications/initialized", json!({})).await?;
        self.list_tools().await
    }

    async fn list_tools(&self) -> Result<Vec<McpToolInfo>> {
        let mut tools: Vec<McpToolInfo> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = match &cursor {
                Some(cursor) => json!({ "cursor": cursor }),
                None => json!({}),
            };
            let result = self.request("tools/list", params, LIST_TIMEOUT).await?;
            for tool in result["tools"].as_array().cloned().unwrap_or_default() {
                let Some(remote_name) = tool.get("name").and_then(Value::as_str) else {
                    tracing::warn!(server = %self.server_id, "mcp tool without a name skipped");
                    continue;
                };
                let info = McpToolInfo {
                    remote_name: remote_name.to_string(),
                    namespaced: namespaced_name(&self.server_id, remote_name),
                    description: tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    input_schema: tool
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                };
                if let Some(existing) = tools.iter_mut().find(|t| t.remote_name == info.remote_name)
                {
                    tracing::warn!(server = %self.server_id, tool = %info.remote_name, "duplicate mcp tool name; last wins");
                    *existing = info;
                } else {
                    tools.push(info);
                }
            }
            if tools.len() >= MAX_TOOLS_PER_SERVER {
                tracing::warn!(server = %self.server_id, "mcp server declared over {MAX_TOOLS_PER_SERVER} tools; truncating");
                tools.truncate(MAX_TOOLS_PER_SERVER);
                break;
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(String::from);
            if cursor.is_none() {
                break;
            }
        }
        Ok(tools)
    }

    async fn request(&self, method: &str, params: Value, t: Duration) -> Result<Value> {
        match &self.transport {
            Transport::Stdio(stdio) => stdio.request(method, params, t).await,
            Transport::Http(http) => http.request(method, params, t).await,
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        match &self.transport {
            Transport::Stdio(stdio) => stdio.notify(method, params).await,
            Transport::Http(http) => http.notify(method, params).await,
        }
    }

    /// `tools/call`. Flattens `result.content` text parts into one string;
    /// non-text parts become `[<type> content omitted]` lines. `isError: true`
    /// becomes an Err carrying the flattened text.
    pub async fn call_tool(&self, remote_name: &str, arguments: Value) -> Result<Value> {
        let result = self
            .request(
                "tools/call",
                json!({ "name": remote_name, "arguments": arguments }),
                Duration::from_secs(self.cfg.timeout_secs.max(1)),
            )
            .await?;
        let text = flatten_content(result.get("content"));
        if result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            if text.is_empty() {
                bail!("mcp tool {remote_name} reported an error");
            }
            bail!("{text}");
        }
        Ok(json!({ "content": text }))
    }

    /// Best effort teardown. Stdio: close stdin (EOF), give the child 2s to
    /// exit, then kill. Http: DELETE the session at the server.
    pub async fn shutdown(&self) {
        match &self.transport {
            Transport::Stdio(stdio) => stdio.shutdown().await,
            Transport::Http(http) => http.shutdown().await,
        }
    }

    /// True once the connection is unusable. Stdio: the child has exited
    /// (stdout EOF observed, or reaped). Http is connectionless — never dead;
    /// per-call errors surface directly instead of triggering a restart.
    pub async fn is_dead(&self) -> bool {
        match &self.transport {
            Transport::Stdio(stdio) => stdio.is_dead().await,
            Transport::Http(_) => false,
        }
    }

    /// The server's tools narrowed by its configured filter.
    fn filtered_tools(&self) -> impl Iterator<Item = &McpToolInfo> {
        self.tools
            .iter()
            .filter(|tool| tool_filter_allows(&self.cfg.tools, &tool.remote_name))
    }
}

/// Stdio transport state: the spawned child and its JSON-RPC plumbing.
struct StdioTransport {
    server_id: String,
    /// `Option` so `shutdown` can drop the pipe (EOF to the child) while the
    /// reader task still holds a clone of the `Arc`.
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Mutex<Child>,
    next_id: AtomicI64,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    /// Set by the reader task at stdout EOF — a faster and more reliable
    /// signal than `try_wait`, which can lag the actual exit.
    dead: Arc<AtomicBool>,
}

impl StdioTransport {
    /// Spawn the child and start the stdout/stderr reader tasks.
    fn spawn(cfg: &McpServerConfig) -> Result<Self> {
        let mut command = build_command(cfg);
        let mut child = command
            .spawn()
            .with_context(|| format!("failed to spawn mcp server '{}': {}", cfg.id, cfg.command))?;
        if let Some(pid) = child.id() {
            crate::spawn_ledger::global().register(
                pid,
                crate::spawn_ledger::SpawnKind::Mcp,
                format!("mcp server ({})", cfg.id),
            );
        }
        let stdin_pipe = child.stdin.take().context("mcp child has no stdin")?;
        let stdout = child.stdout.take().context("mcp child has no stdout")?;
        let stderr = child.stderr.take().context("mcp child has no stderr")?;

        let stdin = Arc::new(Mutex::new(Some(stdin_pipe)));
        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let dead = Arc::new(AtomicBool::new(false));

        {
            let server_id = cfg.id.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::warn!(server = %server_id, "mcp stderr: {line}");
                }
            });
        }
        tokio::spawn(reader_loop(
            stdout,
            pending.clone(),
            stdin.clone(),
            dead.clone(),
            cfg.id.clone(),
        ));

        Ok(Self {
            server_id: cfg.id.clone(),
            stdin,
            child: Mutex::new(child),
            next_id: AtomicI64::new(1),
            pending,
            dead,
        })
    }

    async fn request(&self, method: &str, params: Value, t: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(error) = self.write_line(&message).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        let response = match timeout(t, rx).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => bail!("mcp server '{}' closed the connection", self.server_id),
            Err(_) => {
                // Same ghost-sender fix as agent approvals: a timed-out entry
                // must leave the pending map or a late reply answers nobody.
                self.pending.lock().await.remove(&id);
                bail!(
                    "mcp request '{method}' to '{}' timed out after {}s",
                    self.server_id,
                    t.as_secs()
                );
            }
        };
        rpc_result(response, &self.server_id)
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.write_line(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await
    }

    async fn write_line(&self, message: &Value) -> Result<()> {
        let mut guard = self.stdin.lock().await;
        let writer = guard
            .as_mut()
            .with_context(|| format!("mcp server '{}' stdin is closed", self.server_id))?;
        writer
            .write_all(serde_json::to_string(message)?.as_bytes())
            .await?;
        writer.write_all(b"\n").await?;
        writer.flush().await?;
        Ok(())
    }

    async fn shutdown(&self) {
        self.stdin.lock().await.take();
        let mut child = self.child.lock().await;
        if timeout(SHUTDOWN_WAIT, child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
    }

    async fn is_dead(&self) -> bool {
        if self.dead.load(Ordering::SeqCst) {
            return true;
        }
        matches!(self.child.lock().await.try_wait(), Ok(Some(_)))
    }
}

/// Refuse a URL that resolves onto the local machine or a private network.
///
/// Applied only to project-scoped (repo-supplied) servers. Resolution happens
/// here rather than on the string so `evil.example.com A 127.0.0.1` is caught
/// too; a host that fails to resolve is refused rather than passed through,
/// since a name that resolves later is exactly the interesting case.
fn reject_private_url(url: &str, server_id: &str) -> Result<()> {
    use std::net::{IpAddr, ToSocketAddrs};

    let parsed = reqwest::Url::parse(url)
        .with_context(|| format!("mcp server '{server_id}' has an unparseable url"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => bail!("mcp server '{server_id}': unsupported url scheme '{scheme}'"),
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("mcp server '{server_id}' has a url with no host"))?;
    let port = parsed.port_or_known_default().unwrap_or(80);
    let addrs: Vec<IpAddr> = (host, port)
        .to_socket_addrs()
        .with_context(|| {
            format!("mcp server '{server_id}': cannot resolve '{host}' declared by the project")
        })?
        .map(|addr| addr.ip())
        .collect();
    if addrs.is_empty() {
        bail!("mcp server '{server_id}': '{host}' resolved to no addresses");
    }
    for addr in addrs {
        let blocked = match addr {
            IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_broadcast()
                    || v4.is_unspecified()
                    // 100.64.0.0/10 (CGNAT) and 169.254.169.254 (metadata)
                    // are the two that bite in practice; the first is
                    // covered here, the second by is_link_local above.
                    || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
            }
            IpAddr::V6(v6) => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    // Unique-local fc00::/7 and link-local fe80::/10.
                    || (v6.segments()[0] & 0xfe00) == 0xfc00
                    || (v6.segments()[0] & 0xffc0) == 0xfe80
                    || v6.to_ipv4_mapped().is_some_and(|v4| {
                        v4.is_loopback() || v4.is_private() || v4.is_link_local()
                    })
            }
        };
        if blocked {
            bail!(
                "mcp server '{server_id}': the project's url points at the private address \
                 {addr}; project config may not reach the local network"
            );
        }
    }
    Ok(())
}

/// MCP streamable HTTP transport: every message is a POST to `url`; the
/// session id issued by `initialize` rides along as a header. v1 opens no
/// standing SSE stream — `tools/list`/`tools/call` responses come back on
/// the POST itself, as plain JSON or as an SSE-encoded body.
struct HttpTransport {
    server_id: String,
    url: String,
    http: reqwest::Client,
    /// `Mcp-Session-Id` from the initialize response, echoed on every later
    /// request (and DELETEd at shutdown).
    session: RwLock<Option<String>>,
    next_id: AtomicI64,
}

impl HttpTransport {
    fn new(cfg: &McpServerConfig) -> Result<Self> {
        let url = cfg.url.trim().to_string();
        if url.is_empty() {
            bail!("mcp server '{}' uses http transport but has no url", cfg.id);
        }
        if cfg.project_scoped {
            // The URL came out of a checked-out repository. A global entry
            // pointing at 127.0.0.1 is the normal way to run a local MCP
            // server and stays allowed; letting a repo do it would turn
            // "open this folder" into a scanner for loopback services and
            // cloud metadata endpoints.
            reject_private_url(&url, &cfg.id)?;
        }
        Ok(Self {
            server_id: cfg.id.clone(),
            url,
            // Redirects are not followed: a permitted public URL must not be
            // able to bounce the request onto a private address, which would
            // walk straight around the check above.
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .context("building the mcp http client")?,
            session: RwLock::new(None),
            next_id: AtomicI64::new(1),
        })
    }

    async fn post(&self, body: &Value, t: Duration) -> Result<reqwest::Response> {
        let mut request = self
            .http
            .post(&self.url)
            .timeout(t)
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", PROTOCOL_VERSION)
            .json(body);
        if let Some(session) = self.session.read().await.clone() {
            request = request.header(SESSION_HEADER, session);
        }
        request
            .send()
            .await
            .with_context(|| format!("mcp http request to '{}' failed", self.server_id))
    }

    async fn request(&self, method: &str, params: Value, t: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let response = self.post(&body, t).await?;
        if method == "initialize" {
            if let Some(session) = response
                .headers()
                .get(SESSION_HEADER)
                .and_then(|value| value.to_str().ok())
            {
                *self.session.write().await = Some(session.to_string());
            }
        }
        let status = response.status();
        let event_stream = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            let snippet: String = text.chars().take(200).collect();
            bail!(
                "mcp server '{}' returned http {status}: {snippet}",
                self.server_id
            );
        }
        let message = if event_stream {
            sse_response(&text, id).with_context(|| {
                format!(
                    "mcp server '{}' sse body carried no response for id {id}",
                    self.server_id
                )
            })?
        } else {
            serde_json::from_str(&text).with_context(|| {
                format!("mcp server '{}' returned malformed json", self.server_id)
            })?
        };
        rpc_result(message, &self.server_id)
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        let body = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let response = self.post(&body, INIT_TIMEOUT).await?;
        let status = response.status();
        if !status.is_success() {
            bail!(
                "mcp server '{}' rejected notification '{method}': http {status}",
                self.server_id
            );
        }
        Ok(())
    }

    /// Best effort session teardown per the streamable HTTP spec.
    async fn shutdown(&self) {
        let Some(session) = self.session.write().await.take() else {
            return;
        };
        let _ = self
            .http
            .delete(&self.url)
            .timeout(SHUTDOWN_WAIT)
            .header(SESSION_HEADER, session)
            .send()
            .await;
    }
}

/// Extract the response event for `id` from an SSE body: `data:` lines are
/// accumulated per event (blank line = boundary) and parsed as JSON-RPC.
fn sse_response(body: &str, id: i64) -> Option<Value> {
    let mut data = String::new();
    let check = |data: &mut String| -> Option<Value> {
        if data.is_empty() {
            return None;
        }
        let parsed = serde_json::from_str::<Value>(data).ok();
        data.clear();
        parsed.filter(|message| message.get("id").and_then(Value::as_i64) == Some(id))
    };
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        } else if line.trim().is_empty() {
            if let Some(message) = check(&mut data) {
                return Some(message);
            }
        }
    }
    check(&mut data)
}

/// Shared JSON-RPC envelope handling: `error` → Err, otherwise `result`.
fn rpc_result(response: Value, server_id: &str) -> Result<Value> {
    if let Some(error) = response.get("error") {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        bail!("mcp server '{server_id}' error {code}: {message}");
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

/// Build the child command with a scrubbed environment: `env_clear()` plus a
/// safe baseline and the server's declared `env` (same pattern as
/// `devserver::resolve_command`), so `CALI_*_API_KEY` and other parent
/// secrets never reach an MCP server. Declared vars win over the baseline.
///
/// The filesystem is confined the same way a dev server's is, but the network
/// deliberately is **not**. An MCP server is usually a client for some remote
/// API — that is the entire reason it exists — so denying egress here would
/// not harden anything, it would just make every useful server fail to work.
/// The asymmetry is intentional: this is third-party code we let onto the
/// network on purpose, and the boundary that matters is the one around the
/// user's files.
///
/// A server has no workspace of its own (they are configured globally, before
/// any project is open), so it gets [`sandbox::ambient_policy`]: the caches
/// and `~/.cali`. One that persists state elsewhere needs an entry in
/// `sandbox.writable_extra`.
fn build_command(cfg: &McpServerConfig) -> Command {
    let policy = sandbox::ambient_policy(sandbox::Network::Full);
    let (program, args) = sandbox::confine(&policy, &cfg.command, &cfg.args);
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.env_clear();
    for key in ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SHELL"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.envs(&cfg.env);
    command
}

async fn reader_loop(
    stdout: tokio::process::ChildStdout,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    dead: Arc<AtomicBool>,
    server_id: String,
) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            tracing::debug!(server = %server_id, "skipping malformed mcp json line");
            continue;
        };
        if message.get("method").is_some() {
            let id = message.get("id").cloned().unwrap_or(Value::Null);
            if id.is_null() {
                // Notification (logging, progress, ...): read and dropped.
                tracing::debug!(server = %server_id, method = %message["method"], "dropping mcp notification");
                continue;
            }
            // Server->client request (sampling/roots): unsupported, answer
            // -32601 so well-behaved servers degrade gracefully.
            let response = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": "method not found" }
            });
            let mut guard = stdin.lock().await;
            if let Some(writer) = guard.as_mut() {
                let _ = writer.write_all(format!("{response}\n").as_bytes()).await;
                let _ = writer.flush().await;
            }
            continue;
        }
        if let Some(id) = message.get("id").and_then(Value::as_i64) {
            if let Some(tx) = pending.lock().await.remove(&id) {
                let _ = tx.send(message);
            }
        }
    }
    // EOF: the server exited. Fail every in-flight request instead of letting
    // callers hang until their timeout.
    dead.store(true, Ordering::SeqCst);
    let mut guard = pending.lock().await;
    for (_, tx) in guard.drain() {
        let _ = tx.send(json!({
            "jsonrpc": "2.0",
            "error": { "code": -32000, "message": "mcp server exited" }
        }));
    }
}

fn flatten_content(content: Option<&Value>) -> String {
    let Some(parts) = content.and_then(Value::as_array) else {
        return String::new();
    };
    let mut lines: Vec<String> = Vec::new();
    for part in parts {
        let kind = part
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if kind == "text" {
            lines.push(
                part.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            );
        } else {
            lines.push(format!("[{kind} content omitted]"));
        }
    }
    lines.join("\n")
}

enum Slot {
    Running(Arc<McpClient>),
    Failed { cfg: McpServerConfig, error: String },
    Disabled(McpServerConfig),
}

fn slot_cfg(slot: &Slot) -> &McpServerConfig {
    match slot {
        Slot::Running(client) => &client.cfg,
        Slot::Failed { cfg, .. } => cfg,
        Slot::Disabled(cfg) => cfg,
    }
}

/// Held in `AppState`. No lock is held across a child await except inside
/// `call()`, where the client `Arc` is cloned out of the map first.
#[derive(Default)]
pub struct McpManager {
    slots: RwLock<HashMap<String, Slot>>,
    /// One lock per server id: concurrent callers that both observe a dead
    /// server serialize here, so the loser reuses the winner's fresh client
    /// instead of spawning the child a second time. `apply_one` holds the
    /// same lock across its slot swap, so an enable/disable toggle cannot
    /// interleave with a restart (and a disable always wins over one).
    restart_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Base path of the project whose scope was applied last, so approving
    /// that project's MCP servers needs no path from the caller — the UI can
    /// approve exactly what it was just shown.
    project_scope_base: RwLock<Option<std::path::PathBuf>>,
}

impl McpManager {
    /// Remember which project's overrides are currently applied.
    pub async fn set_project_scope_base(&self, base: &std::path::Path) {
        *self.project_scope_base.write().await = Some(base.to_path_buf());
    }

    /// The project whose overrides are currently applied, if any.
    pub async fn project_scope_base(&self) -> Option<std::path::PathBuf> {
        self.project_scope_base.read().await.clone()
    }

    /// Spawn every enabled server concurrently; record failures as
    /// `Slot::Failed`. Never returns Err — boot must not depend on MCP health.
    /// Replaces the whole slot map, so it doubles as the reload primitive.
    pub async fn start_all(&self, configs: &[McpServerConfig]) {
        let mut slots: HashMap<String, Slot> = HashMap::new();
        for cfg in configs.iter().filter(|cfg| !cfg.enabled) {
            slots.insert(cfg.id.clone(), Slot::Disabled(cfg.clone()));
        }
        let enabled: Vec<McpServerConfig> =
            configs.iter().filter(|cfg| cfg.enabled).cloned().collect();
        let started = futures::future::join_all(enabled.into_iter().map(|cfg| async move {
            let result = McpClient::start(cfg.clone()).await;
            (cfg, result)
        }))
        .await;
        for (cfg, result) in started {
            match result {
                Ok(client) => {
                    tracing::info!(id = %cfg.id, tools = client.tools.len(), "mcp server started");
                    slots.insert(cfg.id.clone(), Slot::Running(client));
                }
                Err(error) => {
                    tracing::warn!(id = %cfg.id, %error, "mcp server failed to start");
                    slots.insert(
                        cfg.id.clone(),
                        Slot::Failed {
                            cfg,
                            error: error.to_string(),
                        },
                    );
                }
            }
        }
        *self.slots.write().await = slots;
    }

    /// Snapshot of namespaced `ToolDef`s from running slots (narrowed by each
    /// server's tool filter), for merging into the `registered` map at chat
    /// start.
    pub async fn tool_defs(&self) -> HashMap<String, ToolDef> {
        let slots = self.slots.read().await;
        let mut defs = HashMap::new();
        for slot in slots.values() {
            let Slot::Running(client) = slot else {
                continue;
            };
            for info in client.filtered_tools() {
                defs.insert(
                    info.namespaced.clone(),
                    ToolDef {
                        name: info.namespaced.clone(),
                        description: clamp_chars(
                            &format!("[MCP:{}] {}", client.server_id, info.description),
                            MAX_TOOL_DESCRIPTION_CHARS,
                        ),
                        parameters: bound_tool_schema(object_schema(&info.input_schema)),
                        kind: ToolKind::Mcp,
                        // Unused for MCP: `is_destructive` answers from the
                        // server's own trust flag before it ever looks here.
                        // Set closed anyway so the field never becomes a
                        // second, quieter source of truth.
                        access: crate::tools::Access::Guarded,
                    },
                );
            }
        }
        defs
    }

    /// Execute a namespaced tool with the model's (already-parsed) arguments.
    /// A tool the server's filter hides is indistinguishable from an unknown
    /// tool. A server observed dead is restarted once before the call; a
    /// second failure surfaces as Err (which the agent loop turns into an
    /// error tool result).
    pub async fn call(&self, namespaced: &str, arguments: &Value) -> Result<Value> {
        let target = {
            let slots = self.slots.read().await;
            slots.values().find_map(|slot| match slot {
                Slot::Running(client) => client
                    .filtered_tools()
                    .find(|tool| tool.namespaced == namespaced)
                    .map(|tool| (client.clone(), tool.remote_name.clone())),
                _ => None,
            })
        };
        let (client, remote_name) =
            target.with_context(|| format!("unknown mcp tool {namespaced}"))?;
        let client = if client.is_dead().await {
            self.restart_serialized(client.cfg.clone()).await?
        } else {
            client
        };
        client.call_tool(&remote_name, arguments.clone()).await
    }

    /// Restart `cfg`'s server, serialized per server id. The first caller to
    /// observe the server dead performs the spawn; concurrent observers wait
    /// on the same lock, re-check the slot, and reuse the winner's client
    /// rather than double-spawning the child.
    async fn restart_serialized(&self, cfg: McpServerConfig) -> Result<Arc<McpClient>> {
        let lock = {
            let mut locks = self.restart_locks.lock().await;
            locks.entry(cfg.id.clone()).or_default().clone()
        };
        let _guard = lock.lock().await;
        // Re-check under the lock: a concurrent caller may already have
        // restarted the server while we waited — and a concurrent disable
        // (or removal) is terminal: a caller still holding the old client
        // must never revive a server the user just turned off.
        let existing = {
            let slots = self.slots.read().await;
            match slots.get(&cfg.id) {
                Some(Slot::Running(client)) => Some(client.clone()),
                Some(Slot::Failed { .. }) => None,
                Some(Slot::Disabled(_)) | None => {
                    bail!("mcp server '{}' is disabled; not restarting", cfg.id)
                }
            }
        };
        if let Some(client) = existing {
            if !client.is_dead().await {
                return Ok(client);
            }
        }
        tracing::warn!(id = %cfg.id, "mcp server exited; restarting once");
        self.restart(cfg).await
    }

    async fn restart(&self, cfg: McpServerConfig) -> Result<Arc<McpClient>> {
        match McpClient::start(cfg.clone()).await {
            Ok(client) => {
                self.slots
                    .write()
                    .await
                    .insert(cfg.id.clone(), Slot::Running(client.clone()));
                Ok(client)
            }
            Err(error) => {
                let message = error.to_string();
                self.slots.write().await.insert(
                    cfg.id.clone(),
                    Slot::Failed {
                        cfg,
                        error: message,
                    },
                );
                Err(error.context("mcp server restart failed"))
            }
        }
    }

    /// True when the server owning `namespaced` is configured `trust: true`
    /// (used by the destructive-tool gate). Unknown tools are untrusted.
    pub async fn is_trusted(&self, namespaced: &str) -> bool {
        let slots = self.slots.read().await;
        slots.values().any(|slot| match slot {
            Slot::Running(client) => {
                client.cfg.trust
                    && client
                        .tools
                        .iter()
                        .any(|tool| tool.namespaced == namespaced)
            }
            _ => false,
        })
    }

    /// Shutdown everything, then start from the given configs. Returns fresh
    /// reports for the RPC reply.
    pub async fn reload(&self, configs: &[McpServerConfig]) -> Vec<McpServerReport> {
        self.shutdown_all().await;
        self.start_all(configs).await;
        self.status().await
    }

    /// Re-apply a single server's config in place: stop whatever slot holds
    /// its id, then start / mark disabled per `cfg.enabled`. For the
    /// `mcp_set_enabled` RPC, so toggling one server does not restart the
    /// others.
    pub async fn apply_one(&self, cfg: &McpServerConfig) {
        // Hold the per-server restart lock for the whole transition so a
        // concurrent dead-client restart cannot interleave with the swap
        // and orphan a child it just spawned (or revive a disabled server).
        let lock = {
            let mut locks = self.restart_locks.lock().await;
            locks.entry(cfg.id.clone()).or_default().clone()
        };
        let _guard = lock.lock().await;
        // Single-insert swap: the slot flips to Disabled atomically under one
        // write lock — there is no window where the id is missing from the map.
        let previous = self
            .slots
            .write()
            .await
            .insert(cfg.id.clone(), Slot::Disabled(cfg.clone()));
        if let Some(Slot::Running(client)) = previous {
            client.shutdown().await;
        }
        if !cfg.enabled {
            return;
        }
        let slot = match McpClient::start(cfg.clone()).await {
            Ok(client) => Slot::Running(client),
            Err(error) => Slot::Failed {
                cfg: cfg.clone(),
                error: error.to_string(),
            },
        };
        self.slots.write().await.insert(cfg.id.clone(), slot);
    }

    /// Remove a server's slot entirely (project scope shrank). Serialized
    /// with restarts so a racing dead-client restart cannot resurrect it.
    async fn remove_one(&self, id: &str) {
        let lock = {
            let mut locks = self.restart_locks.lock().await;
            locks.entry(id.to_string()).or_default().clone()
        };
        let _guard = lock.lock().await;
        let previous = self.slots.write().await.remove(id);
        if let Some(Slot::Running(client)) = previous {
            client.shutdown().await;
        }
    }

    /// Reconcile the manager against a full desired server list — the merged
    /// global+project set on project open, or the plain global set when the
    /// project closes. Servers whose config is unchanged keep running
    /// untouched; changed or new ids are (re)applied; ids absent from
    /// `servers` are shut down and removed. Callers produce `servers` via
    /// `config::merge_mcp_servers`, so the list arrives validated.
    pub async fn apply_project_scope(&self, servers: &[McpServerConfig]) -> Vec<McpServerReport> {
        let current: HashMap<String, McpServerConfig> = {
            let slots = self.slots.read().await;
            slots
                .iter()
                .map(|(id, slot)| (id.clone(), slot_cfg(slot).clone()))
                .collect()
        };
        for id in current.keys() {
            if !servers.iter().any(|server| &server.id == id) {
                self.remove_one(id).await;
            }
        }
        for cfg in servers {
            if current.get(&cfg.id) == Some(cfg) {
                continue; // Unchanged: leave the running client alone.
            }
            self.apply_one(cfg).await;
        }
        self.status().await
    }

    pub async fn status(&self) -> Vec<McpServerReport> {
        let slots = self.slots.read().await;
        let mut reports: Vec<McpServerReport> = slots
            .values()
            .map(|slot| {
                let cfg = slot_cfg(slot);
                let (status, tools) = match slot {
                    Slot::Running(client) => {
                        let tools: Vec<McpToolInfo> = client.filtered_tools().cloned().collect();
                        (
                            McpStatus::Running {
                                tool_count: tools.len(),
                            },
                            tools,
                        )
                    }
                    Slot::Failed { error, .. } => (
                        McpStatus::Failed {
                            error: error.clone(),
                        },
                        Vec::new(),
                    ),
                    Slot::Disabled(_) => (McpStatus::Disabled, Vec::new()),
                };
                McpServerReport {
                    id: cfg.id.clone(),
                    transport: cfg.transport.clone(),
                    command: cfg.command.clone(),
                    url: cfg.url.clone(),
                    trust: cfg.trust,
                    status,
                    tools,
                    project_scoped: cfg.project_scoped,
                    pending_consent: cfg.pending_consent,
                }
            })
            .collect();
        reports.sort_by(|a, b| a.id.cmp(&b.id));
        reports
    }

    /// Graceful-exit hook, called from main's shutdown path.
    pub async fn shutdown_all(&self) {
        let slots = std::mem::take(&mut *self.slots.write().await);
        for slot in slots.into_values() {
            if let Slot::Running(client) = slot {
                client.shutdown().await;
            }
        }
    }
}

/// Providers require an object-typed parameters schema; anything else is
/// replaced with an empty object schema.
fn object_schema(schema: &Value) -> Value {
    if schema.get("type").and_then(Value::as_str) == Some("object") {
        schema.clone()
    } else {
        json!({ "type": "object", "properties": {} })
    }
}

/// Longest serialized schema kept for one MCP tool.
///
/// A third-party server decides how big its schemas are, and this one does not
/// pay for that decision once — a tool schema rides in *every* request for the
/// life of the session, so an over-generous server is a per-turn tax. 4KB is
/// far more than any hand-written schema needs and still bounds the worst case
/// at `MAX_TOOLS_PER_SERVER`.
const MAX_TOOL_SCHEMA_BYTES: usize = 4096;
/// Longest description kept for one MCP tool, for the same reason.
const MAX_TOOL_DESCRIPTION_CHARS: usize = 600;
/// Longest description kept for a single property while trimming.
const MAX_PROPERTY_DESCRIPTION_CHARS: usize = 160;

fn clamp_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{kept}…")
}

/// Recursively shorten the prose inside a schema, leaving its shape intact.
fn trim_schema_prose(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            // Neither is needed to *call* the tool, and both are where servers
            // put paragraphs.
            fields.remove("examples");
            fields.remove("$comment");
            if let Some(Value::String(text)) = fields.get_mut("description") {
                *text = clamp_chars(text, MAX_PROPERTY_DESCRIPTION_CHARS);
            }
            for nested in fields.values_mut() {
                trim_schema_prose(nested);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(trim_schema_prose),
        _ => {}
    }
}

/// Bound one MCP tool's schema without making it uncallable.
///
/// Order matters: prose goes first because it is the part that costs tokens and
/// carries no contract. Only if that is not enough does the shape get reduced
/// to names and types — still a valid schema the model can fill in, and it says
/// so, rather than a truncated fragment the provider would reject.
fn bound_tool_schema(schema: Value) -> Value {
    if schema.to_string().len() <= MAX_TOOL_SCHEMA_BYTES {
        return schema;
    }
    let mut trimmed = schema;
    trim_schema_prose(&mut trimmed);
    if trimmed.to_string().len() <= MAX_TOOL_SCHEMA_BYTES {
        return trimmed;
    }

    let properties = trimmed
        .get("properties")
        .and_then(Value::as_object)
        .map(|props| {
            props
                .iter()
                .map(|(name, spec)| {
                    let kind = spec.get("type").cloned().unwrap_or(json!("string"));
                    (name.clone(), json!({ "type": kind }))
                })
                .collect::<serde_json::Map<_, _>>()
        })
        .unwrap_or_default();
    let mut reduced = json!({
        "type": "object",
        "properties": properties,
        "description": "Schema reduced to names and types: the server's own \
                        description of this tool was too large to carry every turn.",
    });
    if let Some(required) = trimmed.get("required") {
        reduced["required"] = required.clone();
    }
    reduced
}

/// `"mcp__" + id + "__" + sanitized remote name`, clamped to 64 chars total
/// (the provider function-name limit `tool_register` already assumes).
/// Sanitize: chars outside `[A-Za-z0-9_-]` become `_`. When clamping
/// truncates, the last 4 chars are replaced with a hex of fnv1a(remote) so
/// names stay unique within a server.
pub fn namespaced_name(server_id: &str, remote: &str) -> String {
    let sanitized: String = remote
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let full = format!("{MCP_PREFIX}{server_id}__{sanitized}");
    if full.len() <= 64 {
        return full;
    }
    let hash = fnv1a(remote.as_bytes());
    let mut clamped: String = full.chars().take(60).collect();
    clamped.push_str(&format!("{:04x}", hash & 0xffff));
    clamped
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn python3_available() -> bool {
        std::process::Command::new("python3")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    /// A scripted MCP server: answers initialize / tools list / tools call
    /// over stdin, with tools that echo, error, hang, and exit.
    const FAKE_SERVER: &str = r#"
import sys, json, os

log = os.environ.get("MCP_SPAWN_LOG")
if log:
    with open(log, "a") as f:
        f.write("spawn\n")

TOOLS = [
    {"name": "echo", "description": "Echo back", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}},
    {"name": "fail", "description": "Always errors", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "sleep", "description": "Never replies", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "die", "description": "Exits the process", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "weird/name!", "description": "Odd chars", "inputSchema": {"not": "an object schema"}},
    {"name": "env", "description": "Read env vars", "inputSchema": {"type": "object", "properties": {"names": {"type": "array"}}}},
]

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        out = {"jsonrpc": "2.0", "id": msg["id"], "result": {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "fake", "version": "0"}}}
    elif method == "notifications/initialized":
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/message", "params": {"level": "info", "data": "hello"}}) + "\n")
        sys.stdout.flush()
        continue
    elif method == "tools/list":
        out = {"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": TOOLS}}
    elif method == "tools/call":
        name = msg["params"]["name"]
        if name == "echo":
            text = msg["params"].get("arguments", {}).get("text", "")
            out = {"jsonrpc": "2.0", "id": msg["id"], "result": {"content": [{"type": "text", "text": "echo: " + text}, {"type": "image", "data": "zz"}]}}
        elif name == "fail":
            out = {"jsonrpc": "2.0", "id": msg["id"], "result": {"content": [{"type": "text", "text": "boom"}], "isError": True}}
        elif name == "sleep":
            continue
        elif name == "die":
            sys.exit(0)
        elif name == "env":
            names = msg["params"].get("arguments", {}).get("names", [])
            values = {n: os.environ.get(n) for n in names}
            out = {"jsonrpc": "2.0", "id": msg["id"], "result": {"content": [{"type": "text", "text": json.dumps(values)}]}}
        else:
            out = {"jsonrpc": "2.0", "id": msg["id"], "result": {"content": [{"type": "text", "text": "ok"}]}}
    else:
        out = {"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32601, "message": "nope"}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
"#;

    fn fake_cfg(dir: &std::path::Path, timeout_secs: u64) -> McpServerConfig {
        let script = dir.join("fake_mcp.py");
        std::fs::write(&script, FAKE_SERVER).unwrap();
        McpServerConfig {
            id: "fake".into(),
            command: "python3".into(),
            args: vec![script.display().to_string()],
            timeout_secs,
            ..Default::default()
        }
    }

    #[test]
    fn namespaced_name_sanitizes_and_prefixes() {
        assert_eq!(
            namespaced_name("blender", "get_scene_info"),
            "mcp__blender__get_scene_info"
        );
        assert_eq!(
            namespaced_name("srv", "weird/name!"),
            "mcp__srv__weird_name_"
        );
        assert!(is_mcp_name("mcp__srv__x"));
        assert!(!is_mcp_name("file_write"));
    }

    #[test]
    fn namespaced_name_clamps_to_64_with_unique_suffix() {
        let long_a = format!("{}_variant_a", "x".repeat(80));
        let long_b = format!("{}_variant_b", "x".repeat(80));
        let a = namespaced_name("server", &long_a);
        let b = namespaced_name("server", &long_b);
        assert_eq!(a.len(), 64);
        assert_eq!(b.len(), 64);
        assert_ne!(a, b, "clamped names must stay unique per remote name");
        assert!(a.starts_with("mcp__server__"));
        // Deterministic: same input, same name.
        assert_eq!(a, namespaced_name("server", &long_a));
    }

    #[test]
    fn flatten_content_handles_text_and_other_parts() {
        let content = json!([
            { "type": "text", "text": "hello" },
            { "type": "image", "data": "xx" },
            { "type": "text", "text": "world" }
        ]);
        assert_eq!(
            flatten_content(Some(&content)),
            "hello\n[image content omitted]\nworld"
        );
        assert_eq!(flatten_content(None), "");
    }

    #[test]
    fn a_modest_schema_is_left_exactly_alone() {
        // The common case must not be touched at all: an unnecessary rewrite
        // of a small schema would change the tool array byte-for-byte and cost
        // the prompt cache for nothing.
        let schema = json!({
            "type": "object",
            "properties": { "path": { "type": "string", "description": "file to read" } },
            "required": ["path"],
        });
        assert_eq!(bound_tool_schema(schema.clone()), schema);
    }

    #[test]
    fn an_oversized_schema_loses_its_prose_before_its_shape() {
        // Prose is where servers put paragraphs and is not part of the
        // contract; the properties are, so they survive.
        let mut properties = serde_json::Map::new();
        for i in 0..40 {
            properties.insert(
                format!("field_{i}"),
                json!({
                    "type": "string",
                    "description": "x".repeat(300),
                    "examples": ["y".repeat(200)],
                }),
            );
        }
        let schema = json!({ "type": "object", "properties": properties, "required": ["field_0"] });
        assert!(schema.to_string().len() > MAX_TOOL_SCHEMA_BYTES);

        let bounded = bound_tool_schema(schema);
        assert!(
            bounded.to_string().len() <= MAX_TOOL_SCHEMA_BYTES,
            "still {} bytes",
            bounded.to_string().len()
        );
        // Every field is still callable, and still typed.
        let props = bounded["properties"].as_object().unwrap();
        assert_eq!(props.len(), 40);
        assert_eq!(props["field_7"]["type"], json!("string"));
        assert_eq!(bounded["required"], json!(["field_0"]));
        // The parts that only cost tokens are gone.
        assert!(!bounded.to_string().contains("examples"));
    }

    #[test]
    fn a_schema_too_large_even_without_prose_keeps_names_and_types() {
        // Reduced, not truncated: a cut-off fragment would be invalid JSON
        // schema and the provider would reject the whole request.
        let mut properties = serde_json::Map::new();
        for i in 0..600 {
            properties.insert(
                format!("really_long_field_name_number_{i}"),
                json!({ "type": "integer" }),
            );
        }
        let schema = json!({ "type": "object", "properties": properties });
        let bounded = bound_tool_schema(schema);
        assert_eq!(bounded["type"], json!("object"));
        assert!(bounded["properties"].is_object());
        assert!(bounded["description"].as_str().unwrap().contains("reduced"));
        // Still parseable as a schema, which a truncation would not be.
        assert!(serde_json::to_string(&bounded).is_ok());
    }

    #[test]
    fn a_runaway_tool_description_is_clamped() {
        assert_eq!(clamp_chars("short", MAX_TOOL_DESCRIPTION_CHARS), "short");
        let long = "d".repeat(MAX_TOOL_DESCRIPTION_CHARS * 2);
        let clamped = clamp_chars(&long, MAX_TOOL_DESCRIPTION_CHARS);
        assert_eq!(clamped.chars().count(), MAX_TOOL_DESCRIPTION_CHARS + 1);
        assert!(clamped.ends_with('…'));
    }

    #[test]
    fn object_schema_wraps_non_object_schemas() {
        let object = json!({ "type": "object", "properties": { "a": { "type": "string" } } });
        assert_eq!(object_schema(&object), object);
        assert_eq!(
            object_schema(&json!({ "not": "object" })),
            json!({ "type": "object", "properties": {} })
        );
    }

    #[test]
    fn glob_match_covers_fnmatch_forms() {
        assert!(glob_match("get_*", "get_scene_info"));
        assert!(glob_match("*", "anything"));
        assert!(glob_match("*", ""));
        assert!(glob_match("get_?", "get_a"));
        assert!(!glob_match("get_?", "get_ab"));
        assert!(glob_match("a*b*c", "aXXbYYc"));
        assert!(!glob_match("a*b*c", "aXXbYY"));
        assert!(glob_match("exact", "exact"));
        assert!(!glob_match("exact", "exactly"));
        assert!(glob_match("[gs]et_*", "get_x"));
        assert!(glob_match("[gs]et_*", "set_x"));
        assert!(!glob_match("[gs]et_*", "let_x"));
        assert!(glob_match("tool_[0-9]", "tool_7"));
        assert!(!glob_match("tool_[0-9]", "tool_x"));
        assert!(glob_match("tool_[!0-9]", "tool_x"));
        assert!(!glob_match("tool_[!0-9]", "tool_7"));
        // Unterminated class never matches.
        assert!(!glob_match("tool_[0-9", "tool_7"));
        // Case-sensitive.
        assert!(!glob_match("Get_*", "get_x"));
    }

    #[test]
    fn tool_filter_matrix() {
        let filter = |include: &[&str], exclude: &[&str]| McpToolFilter {
            include: include.iter().map(|s| s.to_string()).collect(),
            exclude: exclude.iter().map(|s| s.to_string()).collect(),
        };
        // Empty filter = everything allowed.
        assert!(tool_filter_allows(&filter(&[], &[]), "anything"));
        // Include-only: allowlist.
        let inc = filter(&["get_*"], &[]);
        assert!(tool_filter_allows(&inc, "get_scene"));
        assert!(!tool_filter_allows(&inc, "set_scene"));
        // Exclude-only: blocklist.
        let exc = filter(&[], &["delete_*"]);
        assert!(tool_filter_allows(&exc, "get_scene"));
        assert!(!tool_filter_allows(&exc, "delete_all"));
        // Conflict: include wins.
        let both = filter(&["get_*"], &["get_secret"]);
        assert!(tool_filter_allows(&both, "get_secret"));
        assert!(tool_filter_allows(&both, "get_scene"));
        assert!(!tool_filter_allows(&both, "other"));
    }

    #[tokio::test]
    async fn handshake_lists_tools_and_calls_flatten_content() {
        if !python3_available() {
            eprintln!("skipping: python3 not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let client = McpClient::start(fake_cfg(dir.path(), 30)).await.unwrap();
        assert_eq!(client.tools.len(), 6);
        assert!(client
            .tools
            .iter()
            .any(|tool| tool.namespaced == "mcp__fake__echo"));

        let result = client
            .call_tool("echo", json!({ "text": "hi" }))
            .await
            .unwrap();
        assert_eq!(result["content"], "echo: hi\n[image content omitted]");

        let error = client
            .call_tool("fail", json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("boom"), "{error}");
        client.shutdown().await;
    }

    #[tokio::test]
    async fn call_timeout_leaves_the_server_usable() {
        if !python3_available() {
            eprintln!("skipping: python3 not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let client = McpClient::start(fake_cfg(dir.path(), 1)).await.unwrap();
        let error = client
            .call_tool("sleep", json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("timed out"), "{error}");
        // Child left running: the next call still works.
        let result = client
            .call_tool("echo", json!({ "text": "after" }))
            .await
            .unwrap();
        assert!(result["content"].as_str().unwrap().contains("echo: after"));
        client.shutdown().await;
    }

    #[test]
    fn build_command_scrubs_secrets_and_keeps_declared_env() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CALI_OPENAI_API_KEY", "sk-should-not-leak");
        let mut cfg = fake_cfg(dir.path(), 30);
        cfg.env
            .insert("MCP_DECLARED".into(), "declared-value".into());
        let command = build_command(&cfg);
        std::env::remove_var("CALI_OPENAI_API_KEY");
        let envs: Vec<(String, Option<String>)> = command
            .as_std()
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().to_string(),
                    v.map(|v| v.to_string_lossy().to_string()),
                )
            })
            .collect();
        assert!(
            !envs.iter().any(|(k, _)| k.starts_with("CALI_")),
            "API keys must not reach a spawned mcp server"
        );
        assert!(envs
            .iter()
            .any(|(k, v)| k == "MCP_DECLARED" && v.as_deref() == Some("declared-value")));
        // Baseline PATH survives so bare commands like `python3` resolve.
        assert!(envs.iter().any(|(k, _)| k == "PATH"));
    }

    /// The deliberate asymmetry with `devserver`: an MCP server's filesystem
    /// is confined, its network is not. Most of them exist to call a remote
    /// API, so a deny would break them rather than harden them.
    #[test]
    #[cfg(target_os = "macos")]
    fn build_command_confines_the_filesystem_but_not_the_network() {
        if !sandbox::settings().enabled {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let cfg = fake_cfg(dir.path(), 30);
        let command = build_command(&cfg);
        let std = command.as_std();
        assert_eq!(std.get_program(), sandbox::SANDBOX_EXEC);
        let args: Vec<String> = std
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args[1].contains("(allow network*)"));
        assert!(args.iter().any(|a| a.starts_with("WRITABLE_ROOT_0=")));
        // The command and its arguments survive intact after `--`.
        let separator = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[separator + 1], cfg.command);
        assert_eq!(args[separator + 2..], cfg.args[..]);
    }

    /// End-to-end proof of the env scrub: the spawned child itself reports
    /// what it can see. A parent-only secret must be invisible; the server's
    /// declared env and the PATH baseline must be visible.
    #[tokio::test]
    async fn spawned_server_cannot_see_parent_secrets_but_sees_declared_env() {
        if !python3_available() {
            eprintln!("skipping: python3 not available");
            return;
        }
        std::env::set_var("CALI_TEST_SECRET", "sk-should-not-leak");
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = fake_cfg(dir.path(), 30);
        cfg.env
            .insert("MCP_DECLARED".into(), "declared-value".into());
        let client = McpClient::start(cfg).await.unwrap();
        let result = client
            .call_tool(
                "env",
                json!({ "names": ["CALI_TEST_SECRET", "MCP_DECLARED", "PATH"] }),
            )
            .await
            .unwrap();
        std::env::remove_var("CALI_TEST_SECRET");
        let values: Value = serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
        assert!(
            values["CALI_TEST_SECRET"].is_null(),
            "parent secret leaked into the mcp child: {values}"
        );
        assert_eq!(values["MCP_DECLARED"], "declared-value");
        assert!(
            values["PATH"].as_str().is_some_and(|p| !p.is_empty()),
            "baseline PATH missing from the mcp child: {values}"
        );
        client.shutdown().await;
    }

    #[tokio::test]
    async fn manager_reports_failures_and_serves_tool_defs() {
        if !python3_available() {
            eprintln!("skipping: python3 not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let good = fake_cfg(dir.path(), 30);
        let bad = McpServerConfig {
            id: "broken".into(),
            command: "/nonexistent/definitely-not-a-binary".into(),
            ..Default::default()
        };
        let off = McpServerConfig {
            id: "off".into(),
            command: "python3".into(),
            enabled: false,
            ..Default::default()
        };
        let manager = McpManager::default();
        manager.start_all(&[good, bad, off]).await;

        let reports = manager.status().await;
        assert_eq!(reports.len(), 3);
        let by_id = |id: &str| reports.iter().find(|r| r.id == id).unwrap();
        assert!(matches!(
            by_id("fake").status,
            McpStatus::Running { tool_count: 6 }
        ));
        assert!(matches!(by_id("broken").status, McpStatus::Failed { .. }));
        assert!(matches!(by_id("off").status, McpStatus::Disabled));

        let defs = manager.tool_defs().await;
        assert_eq!(defs.len(), 6);
        let echo = defs.get("mcp__fake__echo").unwrap();
        assert_eq!(echo.kind, ToolKind::Mcp);
        assert!(echo.description.starts_with("[MCP:fake]"));
        // Non-object inputSchema arrives wrapped.
        let weird = defs.get("mcp__fake__weird_name_").unwrap();
        assert_eq!(
            weird.parameters,
            json!({ "type": "object", "properties": {} })
        );

        // Status serialization: flattened status tag plus toolCount, and the
        // report-level tools array survives (no key collision).
        let serialized = serde_json::to_value(by_id("fake")).unwrap();
        assert_eq!(serialized["status"], "running");
        assert_eq!(serialized["toolCount"], 6);
        assert_eq!(serialized["tools"].as_array().unwrap().len(), 6);
        assert_eq!(serialized["transport"], "stdio");
        let failed = serde_json::to_value(by_id("broken")).unwrap();
        assert_eq!(failed["status"], "failed");
        assert!(failed["error"].as_str().unwrap().len() > 1);

        manager.shutdown_all().await;
    }

    #[tokio::test]
    async fn tool_filter_narrows_defs_and_blocks_calls() {
        if !python3_available() {
            eprintln!("skipping: python3 not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = fake_cfg(dir.path(), 30);
        cfg.tools = McpToolFilter {
            include: vec!["e*".into()],
            exclude: Vec::new(),
        };
        let manager = McpManager::default();
        manager.start_all(std::slice::from_ref(&cfg)).await;

        // Only echo + env survive the include filter.
        let defs = manager.tool_defs().await;
        assert_eq!(defs.len(), 2);
        assert!(defs.contains_key("mcp__fake__echo"));
        assert!(defs.contains_key("mcp__fake__env"));

        // Status reflects the narrowed surface.
        let reports = manager.status().await;
        assert!(matches!(
            reports[0].status,
            McpStatus::Running { tool_count: 2 }
        ));
        assert_eq!(reports[0].tools.len(), 2);

        // Included tool callable, filtered tool behaves as unknown.
        let result = manager
            .call("mcp__fake__echo", &json!({ "text": "in" }))
            .await
            .unwrap();
        assert!(result["content"].as_str().unwrap().contains("echo: in"));
        let error = manager
            .call("mcp__fake__fail", &json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("unknown mcp tool"), "{error}");
        manager.shutdown_all().await;
    }

    #[tokio::test]
    async fn manager_restarts_a_dead_server_once() {
        if !python3_available() {
            eprintln!("skipping: python3 not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let manager = McpManager::default();
        manager.start_all(&[fake_cfg(dir.path(), 5)]).await;

        // Kill it: the in-flight call fails fast (EOF resolves pending).
        let error = manager
            .call("mcp__fake__die", &json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("exited") || error.contains("closed"),
            "{error}"
        );

        // Next call sees the dead server, restarts once, and succeeds.
        let result = manager
            .call("mcp__fake__echo", &json!({ "text": "back" }))
            .await
            .unwrap();
        assert!(result["content"].as_str().unwrap().contains("echo: back"));

        assert!(manager
            .call("mcp__fake__missing", &json!({}))
            .await
            .is_err());
        manager.shutdown_all().await;
    }

    #[tokio::test]
    async fn concurrent_calls_on_dead_server_spawn_one_restart() {
        if !python3_available() {
            eprintln!("skipping: python3 not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = fake_cfg(dir.path(), 5);
        let spawn_log = dir.path().join("spawns.log");
        cfg.env
            .insert("MCP_SPAWN_LOG".into(), spawn_log.display().to_string());
        let manager = Arc::new(McpManager::default());
        manager.start_all(std::slice::from_ref(&cfg)).await;

        // Kill the child, then race several calls at the dead server. All of
        // them must succeed, and the restart must spawn exactly one child:
        // the winner restarts, the losers reuse its client.
        let _ = manager.call("mcp__fake__die", &json!({})).await;
        let tasks: Vec<_> = (0..4)
            .map(|i| {
                let manager = manager.clone();
                tokio::spawn(async move {
                    manager
                        .call("mcp__fake__echo", &json!({ "text": format!("c{i}") }))
                        .await
                })
            })
            .collect();
        for task in tasks {
            let result = task.await.unwrap().unwrap();
            assert!(result["content"].as_str().unwrap().starts_with("echo: c"));
        }

        let spawns = std::fs::read_to_string(&spawn_log).unwrap();
        assert_eq!(
            spawns.lines().count(),
            2,
            "expected the boot spawn plus exactly one restart, got: {spawns:?}"
        );
        manager.shutdown_all().await;
    }

    #[tokio::test]
    async fn trust_flag_flows_through_is_trusted() {
        if !python3_available() {
            eprintln!("skipping: python3 not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = fake_cfg(dir.path(), 5);
        cfg.trust = true;
        let manager = McpManager::default();
        manager.start_all(std::slice::from_ref(&cfg)).await;
        assert!(manager.is_trusted("mcp__fake__echo").await);
        assert!(!manager.is_trusted("mcp__other__echo").await);
        manager.shutdown_all().await;

        cfg.trust = false;
        manager.start_all(&[cfg]).await;
        assert!(!manager.is_trusted("mcp__fake__echo").await);
        manager.shutdown_all().await;
    }

    #[tokio::test]
    async fn concurrent_disable_wins_over_dead_client_restart() {
        if !python3_available() {
            eprintln!("skipping: python3 not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = fake_cfg(dir.path(), 5);
        let spawn_log = dir.path().join("spawns.log");
        cfg.env
            .insert("MCP_SPAWN_LOG".into(), spawn_log.display().to_string());
        let manager = Arc::new(McpManager::default());
        manager.start_all(std::slice::from_ref(&cfg)).await;
        let _ = manager.call("mcp__fake__die", &json!({})).await;

        // Force the racy interleaving deterministically: hold the per-server
        // restart lock so the disable and the dead-client restart both queue
        // behind it, disable first. The call's lookup has already captured
        // the old (dead) client by the time the disable lands; its restart
        // re-check must then see Disabled and refuse to revive the server.
        let lock = {
            let mut locks = manager.restart_locks.lock().await;
            locks.entry(cfg.id.clone()).or_default().clone()
        };
        let guard = lock.lock().await;

        let disable_task = {
            let manager = manager.clone();
            let mut disabled = cfg.clone();
            disabled.enabled = false;
            tokio::spawn(async move { manager.apply_one(&disabled).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        let call_task = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .call("mcp__fake__echo", &json!({ "text": "zombie" }))
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        // Release: tokio mutexes are FIFO, so the disable runs first, then
        // the restart re-check.
        drop(guard);

        disable_task.await.unwrap();
        let error = call_task.await.unwrap().unwrap_err().to_string();
        assert!(error.contains("disabled"), "{error}");
        assert!(matches!(
            manager.status().await[0].status,
            McpStatus::Disabled
        ));
        let spawns = std::fs::read_to_string(&spawn_log).unwrap();
        assert_eq!(
            spawns.lines().count(),
            1,
            "a disabled server must never be respawned, got: {spawns:?}"
        );
        manager.shutdown_all().await;
    }

    #[tokio::test]
    async fn apply_one_toggles_a_single_server() {
        if !python3_available() {
            eprintln!("skipping: python3 not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = fake_cfg(dir.path(), 5);
        let manager = McpManager::default();
        manager.start_all(std::slice::from_ref(&cfg)).await;
        assert_eq!(manager.tool_defs().await.len(), 6);

        cfg.enabled = false;
        manager.apply_one(&cfg).await;
        assert!(manager.tool_defs().await.is_empty());
        assert!(matches!(
            manager.status().await[0].status,
            McpStatus::Disabled
        ));

        cfg.enabled = true;
        manager.apply_one(&cfg).await;
        assert_eq!(manager.tool_defs().await.len(), 6);
        manager.shutdown_all().await;
    }

    #[tokio::test]
    async fn apply_project_scope_reconciles_and_restores() {
        if !python3_available() {
            eprintln!("skipping: python3 not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut global = fake_cfg(dir.path(), 5);
        let spawn_log = dir.path().join("spawns.log");
        global
            .env
            .insert("MCP_SPAWN_LOG".into(), spawn_log.display().to_string());
        let manager = McpManager::default();
        manager.start_all(std::slice::from_ref(&global)).await;
        assert_eq!(manager.tool_defs().await.len(), 6);

        // Project scope: global server disabled (stub merge), plus a
        // project-only server that fails to spawn.
        let mut disabled = global.clone();
        disabled.enabled = false;
        let project_only = McpServerConfig {
            id: "proj".into(),
            command: "/nonexistent/not-a-binary".into(),
            ..Default::default()
        };
        let merged = crate::config::merge_mcp_servers(
            std::slice::from_ref(&global),
            &[disabled, project_only],
        );
        let reports = manager.apply_project_scope(&merged).await;
        assert_eq!(reports.len(), 2);
        let by_id = |reports: &[McpServerReport], id: &str| {
            reports
                .iter()
                .find(|r| r.id == id)
                .map(|r| r.status.clone())
                .unwrap()
        };
        assert!(matches!(by_id(&reports, "fake"), McpStatus::Disabled));
        assert!(matches!(by_id(&reports, "proj"), McpStatus::Failed { .. }));
        assert!(manager.tool_defs().await.is_empty());

        // Back to global scope: project server removed, global re-enabled.
        let reports = manager
            .apply_project_scope(std::slice::from_ref(&global))
            .await;
        assert_eq!(reports.len(), 1);
        assert!(matches!(by_id(&reports, "fake"), McpStatus::Running { .. }));
        assert_eq!(manager.tool_defs().await.len(), 6);

        // Unchanged config on a second apply leaves the client running
        // untouched (no extra spawn beyond boot + re-enable).
        manager
            .apply_project_scope(std::slice::from_ref(&global))
            .await;
        let spawns = std::fs::read_to_string(&spawn_log).unwrap();
        assert_eq!(
            spawns.lines().count(),
            2,
            "unchanged server must not be respawned, got: {spawns:?}"
        );
        manager.shutdown_all().await;
    }

    // ---- http transport ----

    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::post;
    use axum::Router;

    #[derive(Default)]
    struct FakeHttpState {
        /// Respond to post-initialize requests as SSE bodies instead of
        /// plain JSON.
        sse: bool,
        /// Session ids DELETEd by the client.
        deleted: Mutex<Vec<String>>,
    }

    const FAKE_SESSION: &str = "sess-42";

    async fn fake_http_handler(
        State(state): State<Arc<FakeHttpState>>,
        headers: HeaderMap,
        body: String,
    ) -> axum::response::Response {
        let msg: Value = match serde_json::from_str(&body) {
            Ok(msg) => msg,
            Err(_) => return (StatusCode::BAD_REQUEST, "bad json").into_response(),
        };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        if method == "initialize" {
            let out = json!({ "jsonrpc": "2.0", "id": id, "result": {
                "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                "serverInfo": { "name": "fake-http", "version": "0" }
            }});
            let mut response = axum::Json(out).into_response();
            response
                .headers_mut()
                .insert(SESSION_HEADER, FAKE_SESSION.parse().unwrap());
            return response;
        }
        // Everything after initialize must echo the session header.
        if headers
            .get(SESSION_HEADER)
            .and_then(|value| value.to_str().ok())
            != Some(FAKE_SESSION)
        {
            return (StatusCode::BAD_REQUEST, "missing session").into_response();
        }
        if id.is_null() {
            // Notification.
            return StatusCode::ACCEPTED.into_response();
        }
        let out = match method {
            "tools/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [
                { "name": "add", "description": "Add numbers", "inputSchema": { "type": "object", "properties": { "a": { "type": "number" }, "b": { "type": "number" } } } },
                { "name": "fail", "description": "Always errors", "inputSchema": { "type": "object", "properties": {} } }
            ]}}),
            "tools/call" => {
                let name = msg["params"]["name"].as_str().unwrap_or("");
                match name {
                    "add" => {
                        let a = msg["params"]["arguments"]["a"].as_f64().unwrap_or(0.0);
                        let b = msg["params"]["arguments"]["b"].as_f64().unwrap_or(0.0);
                        json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [
                            { "type": "text", "text": format!("sum: {}", a + b) }
                        ]}})
                    }
                    "fail" => json!({ "jsonrpc": "2.0", "id": id, "result": {
                        "content": [{ "type": "text", "text": "http boom" }], "isError": true
                    }}),
                    _ => {
                        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": "no such tool" } })
                    }
                }
            }
            _ => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "nope" } })
            }
        };
        if state.sse {
            let body = format!("event: message\ndata: {out}\n\n");
            return (
                [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                body,
            )
                .into_response();
        }
        axum::Json(out).into_response()
    }

    async fn fake_http_delete(
        State(state): State<Arc<FakeHttpState>>,
        headers: HeaderMap,
    ) -> StatusCode {
        if let Some(session) = headers
            .get(SESSION_HEADER)
            .and_then(|value| value.to_str().ok())
        {
            state.deleted.lock().await.push(session.to_string());
        }
        StatusCode::NO_CONTENT
    }

    /// Serve the fake MCP streamable HTTP endpoint on an ephemeral port.
    async fn spawn_fake_http(
        sse: bool,
    ) -> (String, Arc<FakeHttpState>, tokio::task::JoinHandle<()>) {
        let state = Arc::new(FakeHttpState {
            sse,
            ..Default::default()
        });
        let app = Router::new()
            .route("/mcp", post(fake_http_handler).delete(fake_http_delete))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}/mcp"), state, handle)
    }

    fn http_cfg(url: &str) -> McpServerConfig {
        McpServerConfig {
            id: "remote".into(),
            transport: "http".into(),
            url: url.into(),
            timeout_secs: 10,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn project_scoped_http_url_cannot_reach_the_private_network() {
        // A repo-supplied http server is the SSRF case: opening a folder must
        // not let it probe loopback services or the cloud metadata endpoint.
        for url in [
            "http://127.0.0.1:8080/mcp",
            "http://localhost:9000/mcp",
            "http://169.254.169.254/latest/meta-data",
            "http://192.168.1.5/mcp",
            "http://[::1]:8080/mcp",
        ] {
            let mut cfg = http_cfg(url);
            cfg.project_scoped = true;
            let text = match McpClient::start(cfg).await {
                Ok(_) => panic!("{url} must be refused for a project server"),
                Err(error) => error.to_string(),
            };
            assert!(
                text.contains("private address") || text.contains("cannot resolve"),
                "unexpected refusal for {url}: {text}"
            );
        }
    }

    #[tokio::test]
    async fn a_user_declared_http_server_may_still_use_loopback() {
        // The mirror image: running an MCP server on 127.0.0.1 is the normal
        // local setup, and the user's own config is trusted intent.
        let (url, _state, server) = spawn_fake_http(false).await;
        let cfg = http_cfg(&url);
        assert!(!cfg.project_scoped);
        let client = McpClient::start(cfg).await.unwrap();
        assert!(!client.tools.is_empty());
        drop(server);
    }

    #[tokio::test]
    async fn http_client_handshakes_calls_and_deletes_session() {
        let (url, state, server) = spawn_fake_http(false).await;
        let client = McpClient::start(http_cfg(&url)).await.unwrap();
        assert_eq!(client.tools.len(), 2);
        assert!(client
            .tools
            .iter()
            .any(|tool| tool.namespaced == "mcp__remote__add"));

        // The session header must have been echoed (the fake 400s without
        // it), and calls flow end to end.
        let result = client
            .call_tool("add", json!({ "a": 2, "b": 40 }))
            .await
            .unwrap();
        assert_eq!(result["content"], "sum: 42");

        let error = client
            .call_tool("fail", json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("http boom"), "{error}");

        assert!(!client.is_dead().await);
        client.shutdown().await;
        assert_eq!(*state.deleted.lock().await, vec![FAKE_SESSION.to_string()]);
        server.abort();
    }

    #[tokio::test]
    async fn http_client_parses_sse_encoded_responses() {
        let (url, _state, server) = spawn_fake_http(true).await;
        let client = McpClient::start(http_cfg(&url)).await.unwrap();
        assert_eq!(client.tools.len(), 2);
        let result = client
            .call_tool("add", json!({ "a": 1, "b": 2 }))
            .await
            .unwrap();
        assert_eq!(result["content"], "sum: 3");
        client.shutdown().await;
        server.abort();
    }

    #[tokio::test]
    async fn http_client_start_fails_cleanly_when_unreachable() {
        // Nothing listens here; start must return Err, not hang.
        let error = McpClient::start(http_cfg("http://127.0.0.1:9/mcp"))
            .await
            .err()
            .expect("unreachable http server must fail startup")
            .to_string();
        assert!(!error.is_empty());
    }

    #[tokio::test]
    async fn manager_runs_http_servers_alongside_stdio() {
        let (url, _state, server) = spawn_fake_http(false).await;
        let mut cfg = http_cfg(&url);
        cfg.tools = McpToolFilter {
            include: Vec::new(),
            exclude: vec!["fail".into()],
        };
        let manager = McpManager::default();
        manager.start_all(std::slice::from_ref(&cfg)).await;

        let defs = manager.tool_defs().await;
        assert_eq!(defs.len(), 1, "exclude filter applies to http servers too");
        assert!(defs.contains_key("mcp__remote__add"));

        let result = manager
            .call("mcp__remote__add", &json!({ "a": 5, "b": 5 }))
            .await
            .unwrap();
        assert_eq!(result["content"], "sum: 10");
        assert!(manager.call("mcp__remote__fail", &json!({})).await.is_err());

        let reports = manager.status().await;
        assert_eq!(reports[0].transport, "http");
        assert_eq!(reports[0].url, url);
        manager.shutdown_all().await;
        server.abort();
    }

    #[test]
    fn sse_response_extracts_matching_event() {
        let body =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n";
        let message = sse_response(body, 1).unwrap();
        assert_eq!(message["result"]["ok"], true);
        // Wrong id → None.
        assert!(sse_response(body, 2).is_none());
        // Multiple events: the matching one wins.
        let multi = "data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":1}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":8,\"result\":2}\n\n";
        assert_eq!(sse_response(multi, 8).unwrap()["result"], 2);
        // Multi-line data accumulates.
        let split = "data: {\"jsonrpc\":\"2.0\",\ndata: \"id\":3,\"result\":9}\n\n";
        assert_eq!(sse_response(split, 3).unwrap()["result"], 9);
        // No trailing blank line still parses.
        let tail = "data: {\"jsonrpc\":\"2.0\",\"id\":4,\"result\":5}";
        assert_eq!(sse_response(tail, 4).unwrap()["result"], 5);
        assert!(sse_response("", 1).is_none());
        assert!(sse_response(": comment only\n\n", 1).is_none());
    }
}
