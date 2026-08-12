# Blueprint: SKILLS + MCP extensibility for CaliCode

Status: plan (not implemented)
Scope: user-authored skill files loaded into the agent system prompt on demand, plus an
MCP client (stdio transport) in the Rust core that lets user-configured MCP servers
contribute tools to agent sessions, plus a minimal settings UI to list/enable both.

Grounding facts this plan builds on (verified against source):

- `AppState` (core/src/main.rs:44) holds `config: Arc<RwLock<AppConfig>>`, `tools:
  Arc<RwLock<HashMap<String, ToolDef>>>` (browser tools only), `agents: AgentManager`,
  `bus`, `shutdown: Arc<watch::Sender<bool>>`.
- `AgentManager::chat(state, registered, session_id, messages, options)` receives the
  browser-tool map as a parameter; `build_tools` (agent.rs:272) merges
  `core_tool_defs()` + `registered`. So MCP tools can be merged into `registered` at
  chat start without touching the loop's shape.
- `execute_tool_call` (agent.rs:278) resolves core-by-name first, then browser, and
  gates through `requires_approval(mode, name)`.
- `ToolDef { name, description, parameters, kind }` with `ToolKind::{Core, Browser}`
  (tools.rs:64-78); `kind` is `#[serde(skip)]` so it never crosses the wire.
- Config lives at `~/.cali/config.yaml` (`config::DEFAULT_CONFIG_PATH`, config.rs:5),
  YAML via serde_yaml (already in Cargo.toml). `AppConfig` is `#[serde(default)]`, so
  new fields are backward compatible.
- System prompt is injected only at session birth (agent.rs:57, messages-empty guard);
  the single assembly point is `default_system_prompt` (rpc.rs:519).
- Browser tool names are validated in `tool_register` (rpc.rs:364): ≤64 chars,
  `[A-Za-z0-9_-]`, core names reserved.
- Project file base resolution (`game_file_base`, tools.rs:24-43): workspaceRoot if
  attached, else `<projects_root>/<slug>`.
- Client settings UI already exists: `client/src/components/workspace/SettingsDialog.tsx`
  (providers/models). RPC helper: `rpc<T>(method, params)` in `client/src/lib/rpc.ts`.

---

## Part 0 — Design decisions (read first)

1. **Skills are progressive-disclosure, not bulk-injected.** The system prompt gets a
   compact index (name + one-line description per enabled skill). The agent pulls a
   full skill body via a new core tool `skill_load`. This keeps `default_system_prompt`
   from bloating (it already dumps the whole project JSON) and matches how the
   injection point works: the prompt exists only at session birth, so bodies loaded
   later must arrive as tool results, which they do.
2. **MCP tools live in their own manager, not in `state.tools`.** `tool_register` does
   whole-set *replacement* of `state.tools` on every editor (re)connect; parking MCP
   tools there means every tab refresh wipes them. Instead `AppState` gains
   `mcp: Arc<McpManager>`, and the `agent_chat` / `subagent_spawn` handlers build the
   `registered` snapshot as `browser_tools ∪ mcp_tool_defs` before calling
   `AgentManager::chat`. Dispatch distinguishes by `ToolKind`.
3. **Namespacing: `mcp__<serverId>__<toolName>`.** Double underscore separators, server
   id validated to `[a-z0-9-]` (max 24 chars) at config load. The `mcp__` prefix is
   reserved in `tool_register` so a browser tab cannot spoof an MCP tool. Names are
   clamped to the 64-char provider limit (details in §3.4).
4. **Config file: extend the existing `~/.cali/config.yaml`** rather than invent a new
   `~/.cali/config` file — one config surface, one save path, `#[serde(default)]`
   keeps old configs loading. (The user-facing docs can still say "~/.cali/config".)
5. **Permission model: MCP tools are destructive by default.** `is_destructive` returns
   true for any `mcp__*` name unless the server is marked `trust: true` in config. So
   under `supervised` and `auto-accept-edits` every MCP call is approval-gated;
   `full-access` bypasses as today. Subagents run full-access (existing behavior) and
   therefore call MCP tools unguarded — acceptable because spawning the subagent is
   itself gated under `auto-accept-edits`.
6. **Skill enable/disable state lives in config, not in the skill files.** Toggling
   from the UI must not rewrite user-authored markdown. Config holds a
   `skills.disabled` list of `"<scope>:<name>"` keys.
7. **Sync lifecycle:** MCP servers are spawned at core boot and on explicit
   `mcp_reload`; tool lists are fetched once at spawn (no `listChanged` subscription in
   v1). A dead server's tools return error tool-results; one restart is attempted per
   call before giving up.

---

## Part 1 — Config format (`~/.cali/config.yaml`)

New top-level keys on `AppConfig`:

```yaml
# existing keys: model, providers, projects_dir, workspaces ...

mcp_servers:
  - id: blender            # [a-z0-9-], 1..24 chars, unique; becomes tool prefix
    transport: stdio       # only "stdio" in v1; field exists for future http/sse
    command: uvx
    args: ["blender-mcp"]
    env:                   # merged over the core's env for the child process
      BLENDER_HOST: "127.0.0.1"
    enabled: true          # default true
    trust: false           # default false; true => calls skip is_destructive gating
    timeout_secs: 120      # default 120; per tools/call timeout

skills:
  disabled:
    - "global:unreal-naming"     # "<scope>:<name>", scope = global | project
    - "project:legacy-blockout"
```

### 1.1 `core/src/config.rs` — MODIFY

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppConfig {
    pub model: ModelConfig,
    pub providers: Vec<ProviderPreset>,
    pub projects_dir: Option<String>,
    pub workspaces: Vec<WorkspaceEntry>,
    // NEW:
    pub mcp_servers: Vec<McpServerConfig>,
    pub skills: SkillsConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "snake_case")]
pub struct McpServerConfig {
    pub id: String,
    pub transport: String,          // "stdio"
    pub command: String,
    pub args: Vec<String>,
    pub env: std::collections::HashMap<String, String>,
    pub enabled: bool,              // Default impl: true
    pub trust: bool,                // Default impl: false
    pub timeout_secs: u64,          // Default impl: 120
}

impl Default for McpServerConfig { /* enabled: true, transport: "stdio", timeout_secs: 120, rest empty/false */ }

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct SkillsConfig {
    /// Keys of disabled skills, formatted "<scope>:<name>".
    pub disabled: Vec<String>,
}

/// Validate at load: id charset/length/uniqueness, transport == "stdio",
/// non-empty command. Invalid entries are dropped with a tracing::warn — a bad
/// hand-edited entry must not prevent the core from booting.
pub fn validate_mcp_servers(servers: Vec<McpServerConfig>) -> Vec<McpServerConfig>;
```

Call `validate_mcp_servers` wherever the config is loaded (the existing load path used
by `main.rs`). Reuse the existing config-save function that `model_provider_upsert`
uses (tools.rs ~L407/599 references it) for all writes; do not add a second writer.

---

## Part 2 — Skills

### 2.1 File format

`~/.cali/skills/<anything>.md` (global) and, per project, `<base>/.cali/skills/*.md`
where `<base>` = the project's `workspaceRoot` when attached, else
`<projects_root>/<slug>` (i.e. `~/.cali/projects/<slug>/.cali/skills`). Resolution
reuses the same rule as `game_file_base` so workspace-attached games keep skills in
the user's repo (versionable) and store-only games keep them under `~/.cali`.

```markdown
---
name: blockout-standards          # required; [A-Za-z0-9_-], ≤48 chars
description: How to build blockout geometry that passes review   # required, one line
---
Free-form markdown body. This whole body is returned by skill_load.
```

Rules:
- Frontmatter is the first `---\n ... \n---\n` block, parsed with serde_yaml.
- Files without valid frontmatter, or with a duplicate/invalid `name`, are listed
  with an `error` field (so the UI can show them) but excluded from the prompt index
  and from `skill_load`.
- Project skill shadows global skill of the same name (project wins).
- Max body size returned by `skill_load`: 64 KiB (truncate with a trailing
  `"\n[truncated]"` marker).

### 2.2 `core/src/skills.rs` — CREATE (~250 lines + tests)

```rust
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillScope { Global, Project }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub scope: SkillScope,
    pub path: String,              // absolute, for the UI
    pub enabled: bool,             // derived from SkillsConfig.disabled
    pub error: Option<String>,     // parse problem, if any
}

#[derive(Debug, Deserialize)]
struct Frontmatter { name: String, description: String }

/// `~/.cali/skills` (created lazily on first write, never on read).
pub fn global_skills_dir() -> PathBuf;

/// Project skills dir per the game_file_base rule; None when slug is None or
/// the project JSON can't be read.
pub fn project_skills_dir(projects_root: &Path, slug: &str) -> Option<PathBuf>;

/// Split frontmatter; Err on missing/invalid frontmatter or bad name charset.
pub fn parse_skill(text: &str) -> Result<(Frontmatter, /*body*/ String)>;

/// Enumerate global + (optional) project skills, project shadowing global,
/// sorted by name. Applies the disabled list. Never errors: unreadable dirs
/// yield an empty slice, unparsable files yield SkillInfo{error: Some(..)}.
pub fn list_skills(
    projects_root: &Path,
    slug: Option<&str>,
    disabled: &[String],
) -> Vec<SkillInfo>;

/// Full body of one enabled, valid skill (project scope preferred on name
/// clash). Errors: "skill not found", "skill disabled", "skill invalid: ..".
pub fn load_skill(
    projects_root: &Path,
    slug: Option<&str>,
    name: &str,
    disabled: &[String],
) -> Result<(SkillInfo, String)>;

/// Compact prompt index of enabled skills, "" when none:
///   "\n\nSkills available via the skill_load tool:\n- name: description\n..."
pub fn prompt_index(projects_root: &Path, slug: Option<&str>, disabled: &[String]) -> String;

pub fn disabled_key(scope: SkillScope, name: &str) -> String; // "global:foo"
```

Notes:
- All fs access is `std::fs` (these are tiny files, called at chat start and from a
  tool; no async needed — matches how `store.rs` works).
- `project_skills_dir` duplicates the workspace-resolution decision of
  `game_file_base`; to avoid drift, make `tools::game_file_base` `pub(crate)` and call
  it, appending `.cali/skills` for the workspace case and `.cali/skills` under the
  store dir otherwise. Skill reads go through `workspace::safe_resolve` for the
  workspace case (same symlink/traversal protection as file tools).

### 2.3 Prompt injection — MODIFY `core/src/rpc.rs`

`default_system_prompt` (rpc.rs:519) gains the disabled list and appends the index:

```rust
fn default_system_prompt(
    projects_root: &Path,
    slug: Option<&str>,
    skills_disabled: &[String],
) -> String {
    let mut prompt = /* existing identity + project JSON */;
    prompt.push_str(&skills::prompt_index(projects_root, slug, skills_disabled));
    prompt
}
```

Call sites: `agent_chat` (rpc.rs:426-435) reads `state.config.read().await.skills.disabled.clone()`
before building the prompt (clone-then-drop the guard — the config lock must not be
held across `chat().await`, per the starvation note at agent.rs:94).

Subagents: `spawn_subagent` (tools.rs:361-397) appends the same
`skills::prompt_index(&state.projects_root, project_slug, &disabled)` to its hardcoded
role prompt, so subagents can also `skill_load`.

### 2.4 Skill tools — MODIFY `core/src/tools.rs`

Add to `core_tool_defs()` (two new entries, total 20):

```rust
ToolDef {
    name: "skill_list",
    description: "List available skills (name, description, scope) for this project.",
    parameters: json_schema!{ "slug": { "type": "string", "description": "project slug", optional } },
    kind: ToolKind::Core,
},
ToolDef {
    name: "skill_load",
    description: "Load the full instructions of a skill by name. Use when a listed skill is relevant to the current task.",
    parameters: json_schema!{ required: ["name"], "name": {"type":"string"}, "slug": {"type":"string", optional} },
    kind: ToolKind::Core,
},
```

`execute_core_tool` match arms:

```rust
"skill_list" => {
    let disabled = state.config.read().await.skills.disabled.clone();
    Ok(json!({ "skills": skills::list_skills(&state.projects_root, slug_opt, &disabled) }))
}
"skill_load" => {
    let disabled = state.config.read().await.skills.disabled.clone();
    let (info, body) = skills::load_skill(&state.projects_root, slug_opt, name, &disabled)?;
    Ok(json!({ "name": info.name, "scope": info.scope, "instructions": body }))
}
```

Both are read-only → NOT added to `is_destructive` (agent.rs:371): they run without
approval even in supervised mode? No — `requires_approval` for `"supervised"` is
always-ask today. Leave that as-is (supervised means supervised); they pass freely in
`auto`, `auto-accept-edits`, `full-access`.

### 2.5 Skill RPC methods — MODIFY `core/src/rpc.rs` `dispatch`

```text
"skill_list"        params: { projectSlug?: string }
                    → { skills: SkillInfo[] }
"skill_read"        params: { projectSlug?: string, name: string }
                    → { name, scope, path, instructions }   (ignores disabled — UI preview)
"skill_set_enabled" params: { scope: "global"|"project", name: string, enabled: bool }
                    → { disabled: string[] }
```

`skill_set_enabled` takes the config **write** lock (same pattern as `model_switch`,
tools.rs:347-355), mutates `skills.disabled` (insert/remove `disabled_key`), persists
via the existing config-save path, drops the lock. Errors: name not found is NOT an
error (idempotent toggle by key).

---

## Part 3 — MCP client (stdio)

### 3.1 Protocol summary implemented in v1

JSON-RPC 2.0 over the child's stdin/stdout, newline-delimited messages (one JSON
object per line — the MCP stdio framing). Handshake:

1. → `initialize` request: `{ protocolVersion: "2025-06-18", capabilities: {},
   clientInfo: { name: "cali-core", version: env!("CARGO_PKG_VERSION") } }`
2. ← result (accept any `protocolVersion` echo; log mismatch, don't fail)
3. → `notifications/initialized` notification
4. → `tools/list` request (no pagination follow-up in v1; if `nextCursor` is present,
   loop until absent, cap 500 tools/server)
5. Later, per call: → `tools/call { name, arguments }` ← `{ content: [...], isError? }`

Notifications from the server (`notifications/message`, `logging`, progress) are read
and dropped (traced at debug). Requests *from* the server (sampling/roots) get an
immediate JSON-RPC error `-32601 method not found` so well-behaved servers degrade.

### 3.2 `core/src/mcp.rs` — CREATE (~450 lines + tests)

```rust
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex, RwLock};
use tokio::time::{timeout, Duration};

use crate::config::McpServerConfig;
use crate::tools::{ToolDef, ToolKind};

const INIT_TIMEOUT: Duration = Duration::from_secs(10);
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
pub const MCP_PREFIX: &str = "mcp__";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub remote_name: String,       // name as the server declared it
    pub namespaced: String,        // mcp__<id>__<clamped-name>
    pub description: String,
    pub input_schema: Value,       // server's inputSchema, passed through
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum McpStatus {
    Running { tools: usize },
    Failed { error: String },
    Disabled,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerReport {
    pub id: String,
    pub command: String,
    pub trust: bool,
    #[serde(flatten)]
    pub status: McpStatus,
    pub tools: Vec<McpToolInfo>,   // empty unless Running
}

/// One live stdio connection.
pub struct McpClient {
    server_id: String,
    cfg: McpServerConfig,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    next_id: AtomicI64,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    pub tools: Vec<McpToolInfo>,   // fixed after spawn+list in v1
}

impl McpClient {
    /// spawn child (kill_on_drop(true), Stdio::piped x3, env merged over parent
    /// env), start the reader task (stdout lines → pending map; stderr lines →
    /// tracing::warn target "mcp::<id>"), run initialize + initialized +
    /// tools/list. Any failure kills the child and returns Err.
    pub async fn start(cfg: McpServerConfig) -> Result<Arc<Self>>;

    async fn request(&self, method: &str, params: Value, t: Duration) -> Result<Value>;
    async fn notify(&self, method: &str, params: Value) -> Result<()>;

    /// tools/call. Flattens result.content text parts into one string; non-text
    /// parts become "[<type> content omitted]" lines. isError:true => Err(text).
    pub async fn call_tool(&self, remote_name: &str, arguments: Value) -> Result<Value>;

    /// Best effort: close stdin, wait 2s, kill.
    pub async fn shutdown(&self);

    /// True if the child has exited (poll try_wait).
    pub async fn is_dead(&self) -> bool;
}

enum Slot { Running(Arc<McpClient>), Failed { cfg: McpServerConfig, error: String }, Disabled(McpServerConfig) }

/// Held in AppState. All methods are lock-scoped; nothing is held across a
/// child await except inside call() where the client Arc is cloned out first.
#[derive(Default)]
pub struct McpManager {
    slots: RwLock<HashMap<String, Slot>>,
}

impl McpManager {
    /// Spawn every enabled server concurrently (join_all); record failures as
    /// Slot::Failed. Never returns Err — boot must not depend on MCP health.
    pub async fn start_all(&self, configs: &[McpServerConfig]);

    /// Snapshot of namespaced ToolDefs from Running slots, for merging into
    /// the `registered` map at chat start.
    pub async fn tool_defs(&self) -> HashMap<String, ToolDef>;

    /// Execute a namespaced tool. `arguments` is the raw JSON string from the
    /// model. Restarts a dead server once, then errors.
    pub async fn call(&self, namespaced: &str, arguments: &str) -> Result<Value>;

    /// True when the owning server has trust: true (used by is_destructive).
    pub async fn is_trusted(&self, namespaced: &str) -> bool;

    /// Shutdown all, re-read configs, start_all again. Returns fresh reports.
    pub async fn reload(&self, configs: &[McpServerConfig]) -> Vec<McpServerReport>;

    pub async fn status(&self) -> Vec<McpServerReport>;

    /// Graceful-exit hook, called from main's shutdown path.
    pub async fn shutdown_all(&self);
}

/// "mcp__" + id + "__" + sanitized remote name, clamped to 64 chars total.
/// Sanitize: chars outside [A-Za-z0-9_-] become '_'. If clamping truncates,
/// replace the last 4 chars with a hex of fnv1a(remote_name) to keep names
/// unique within a server.
pub fn namespaced_name(server_id: &str, remote: &str) -> String;

/// Inverse split: ("blender", "get_scene_info") from "mcp__blender__...".
/// Resolution goes through the McpToolInfo table, not string parsing, because
/// clamping is lossy — this helper is only for prefix checks.
pub fn is_mcp_name(name: &str) -> bool { name.starts_with(MCP_PREFIX) }
```

Reader task (inside `start`):

```rust
tokio::spawn(async move {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(id) = msg.get("id").and_then(Value::as_i64) {
            if msg.get("method").is_some() {
                /* server->client request: write -32601 error response to stdin */
            } else if let Some(tx) = pending.lock().await.remove(&id) {
                let _ = tx.send(msg);
            }
        } // else: notification, trace and drop
    }
    // EOF: fail all pending with a "server exited" error value
});
```

`request()` behavior: allocate id, register oneshot in `pending`, write the line under
the `stdin` mutex, await the oneshot under `timeout(t)`; on timeout remove the pending
entry (same ghost-sender fix pattern as agent.rs approvals). A JSON-RPC `error` member
in the response → `bail!("{code}: {message}")`.

### 3.3 `core/src/tools.rs` — MODIFY

```rust
#[derive(Debug, Clone, Default, PartialEq)]
pub enum ToolKind {
    #[default]
    Core,
    Browser,
    Mcp,          // resolution back to server/remote goes through McpManager
}
```

(`kind` stays `#[serde(skip)]`; `Mcp` carries no payload — `McpManager::call` owns the
namespaced→(server, remote) table, so ToolDef stays cheap and serde-inert.)

`McpManager::tool_defs()` builds:

```rust
ToolDef {
    name: info.namespaced.clone(),
    description: format!("[MCP:{server_id}] {}", info.description),
    parameters: info.input_schema.clone(),   // if not an object schema, wrap: {"type":"object","properties":{}}
    kind: ToolKind::Mcp,
}
```

### 3.4 Name rules (normative)

- server id: `[a-z0-9-]{1,24}`, unique — enforced by `validate_mcp_servers`.
- namespaced tool: `mcp__<id>__<san(remote)>`, total ≤64 chars (OpenAI function-name
  limit; the existing `tool_register` validator already assumes 64).
- Collisions after clamping within one server: fnv1a hex suffix (see §3.2); across
  servers impossible (id prefix); a duplicate remote name from a misbehaving server:
  last wins + `tracing::warn`.
- `tool_register` (rpc.rs:364): add `mcp__` to the reserved-prefix rejection alongside
  core names, so browser tools can't shadow MCP tools:

```rust
if name.starts_with(mcp::MCP_PREFIX) { rejected.push(name); continue; }
```

### 3.5 Wiring into the agent — MODIFY `core/src/agent.rs`, `core/src/rpc.rs`, `core/src/main.rs`

`main.rs`:

```rust
pub struct AppState {
    /* existing */
    pub mcp: Arc<mcp::McpManager>,
}
// boot, after config load:
let mcp = Arc::new(mcp::McpManager::default());
mcp.start_all(&config_snapshot.mcp_servers).await;   // non-fatal
// shutdown path (where `shutdown` watch flips): state.mcp.shutdown_all().await;
```

`rpc.rs` `agent_chat` handler (and the `"subagent_spawn"` RPC arm at L77): build the
merged snapshot before calling into the manager:

```rust
let mut registered = state.tools.read().await.clone();
registered.extend(state.mcp.tool_defs().await);      // MCP wins over a (rejected-anyway) clash
state.agents.chat(state, &registered, ..).await
```

`tools.rs::spawn_subagent` already clones a `registered` map from `state.tools`
(L364-ish); change it to the same merged build so subagents see MCP tools too.

`agent.rs::execute_tool_call` — dispatch by kind instead of the current
core-name-first/else-browser structure:

```rust
let def = /* resolve: core_tool_defs() by name, else registered.get(name) */;
match def.kind {
    ToolKind::Core => execute_core_tool(&def, &call.arguments, state, &state.projects_root).await,
    ToolKind::Browser => /* existing oneshot + agent.tool_request round-trip */,
    ToolKind::Mcp => state.mcp.call(&def.name, &call.arguments).await,
}
```

No timeout wrapper needed around `mcp.call` — the per-server `timeout_secs` is applied
inside `McpClient::request`. Errors already become `{"error": "..."}` tool results and
the loop continues (agent.rs:133-169 behavior, unchanged).

`agent.rs` permission fns:

```rust
fn is_destructive(state_mcp_trust: bool, name: &str) -> bool   // signature change is
// awkward (fn is free/static today); instead:
```

Concrete approach: `requires_approval` currently takes `(mode, name)`. Change both to
methods on nothing — keep them free functions but add an `mcp_trusted: bool` argument
computed by the caller (`execute_tool_call` does
`let trusted = def.kind == ToolKind::Mcp && state.mcp.is_trusted(&def.name).await;`):

```rust
fn is_destructive(name: &str, mcp_trusted: bool) -> bool {
    if name.starts_with("mcp__") { return !mcp_trusted; }
    /* existing list */
}
fn requires_approval(mode: &str, name: &str, mcp_trusted: bool) -> bool { /* same shape */ }
```

`"auto"` mode: MCP tools follow `is_destructive` (i.e., untrusted MCP asks) — add
`|| (name.starts_with("mcp__") && !mcp_trusted)` to the auto arm.

### 3.6 MCP RPC methods — MODIFY `core/src/rpc.rs` `dispatch`

```text
"mcp_list"         params: {}                     → { servers: McpServerReport[] }
"mcp_reload"       params: {}                     → { servers: McpServerReport[] }
                   (re-reads state.config, shutdown_all + start_all)
"mcp_set_enabled"  params: { id: string, enabled: bool }
                   → { servers: McpServerReport[] }
                   (config write lock → flip enabled → persist → drop lock →
                    reload just that slot: shutdown if disabling, start if enabling)
```

Adding/editing server definitions is **out of scope for the v1 UI** — users edit
`~/.cali/config.yaml` and hit Reload. (A later `mcp_upsert` mirrors
`model_provider_upsert`.)

### 3.7 Error handling matrix (MCP)

| Failure | Behavior |
|---|---|
| Spawn fails (bad command) | `Slot::Failed{error}`; boot continues; visible in `mcp_list`; tools absent |
| initialize/tools list timeout (10s) | kill child, `Slot::Failed` |
| Server crashes mid-session | reader task EOF → all pending calls resolve with "server exited"; next `call()` sees `is_dead`, restarts once; second failure → Err |
| tools/call timeout (`timeout_secs`) | pending entry removed, Err("mcp tool timed out after Ns"); child left running |
| `isError: true` result | Err with flattened content text |
| Malformed JSON line from server | skipped, traced |
| Non-object inputSchema | wrapped in empty object schema (provider requires object) |
| >500 tools from one server | truncated with warn |
| Config invalid entry | dropped at load with warn, others still start |

---

## Part 4 — Client UI

### 4.1 `client/src/lib/extensions.ts` — CREATE (~90 lines)

```ts
import { rpc } from "./rpc";

export interface SkillInfo {
  name: string;
  description: string;
  scope: "global" | "project";
  path: string;
  enabled: boolean;
  error?: string | null;
}

export interface McpToolInfo { remoteName: string; namespaced: string; description: string; }

export interface McpServerReport {
  id: string;
  command: string;
  trust: boolean;
  status: "running" | "failed" | "disabled";
  error?: string;
  tools: McpToolInfo[];
}

export async function listSkills(projectSlug?: string): Promise<SkillInfo[]> {
  const r = await rpc<{ skills: SkillInfo[] }>("skill_list", projectSlug ? { projectSlug } : {});
  return r.skills;
}

export async function setSkillEnabled(
  scope: "global" | "project", name: string, enabled: boolean,
): Promise<void> {
  await rpc("skill_set_enabled", { scope, name, enabled });
}

export async function readSkill(name: string, projectSlug?: string):
  Promise<{ name: string; instructions: string; path: string }> {
  return rpc("skill_read", { name, projectSlug });
}

export async function listMcpServers(): Promise<McpServerReport[]> {
  const r = await rpc<{ servers: McpServerReport[] }>("mcp_list");
  return r.servers;
}

export async function setMcpEnabled(id: string, enabled: boolean): Promise<McpServerReport[]> {
  const r = await rpc<{ servers: McpServerReport[] }>("mcp_set_enabled", { id, enabled });
  return r.servers;
}

export async function reloadMcp(): Promise<McpServerReport[]> {
  const r = await rpc<{ servers: McpServerReport[] }>("mcp_reload");
  return r.servers;
}
```

### 4.2 `client/src/components/workspace/SettingsDialog.tsx` — MODIFY

Add a tab strip inside the existing dialog: `Providers | Skills | MCP` (local
`useState<"providers"|"skills"|"mcp">`, existing provider form becomes the
`providers` panel body). New prop:

```ts
export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modelList: ModelList | null;
  onChanged: () => void | Promise<void>;
  projectSlug?: string;          // NEW — for project-scoped skills
}
```

App.tsx passes `projectSlug={project.slug}` at the existing SettingsDialog call site.

### 4.3 `client/src/components/workspace/SkillsSection.tsx` — CREATE (~120 lines)

```ts
export interface SkillsSectionProps { projectSlug?: string }
export function SkillsSection({ projectSlug }: SkillsSectionProps): JSX.Element
```

- On mount / on projectSlug change: `listSkills(projectSlug)`.
- Row per skill: name, scope badge (GLOBAL/PROJECT), description, checkbox toggle →
  `setSkillEnabled` then refetch; rows with `error` render the message in the
  destructive color, toggle disabled.
- Empty state: the two watched paths, verbatim, so users know where to drop files.
- Note under the list: "Changes apply to new agent sessions." (prompt index is
  injected only at session birth — do not pretend otherwise).

### 4.4 `client/src/components/workspace/McpSection.tsx` — CREATE (~140 lines)

```ts
export function McpSection(): JSX.Element
```

- `listMcpServers()` on mount; RELOAD button → `reloadMcp()`.
- Row per server: status dot (running=green / failed=red with error tooltip /
  disabled=grey), id, command, tool count, expandable tool list (namespaced +
  description), enable/disable switch → `setMcpEnabled`.
- Footer hint: "Servers are configured in ~/.cali/config.yaml under mcp_servers."

### 4.5 Tests to add (client)

- `client/src/components/workspace/SkillsSection.test.tsx` — render with mocked rpc:
  lists, toggles (asserts `skill_set_enabled` payload), error row disabled.
- `client/src/components/workspace/McpSection.test.tsx` — status rendering, reload,
  toggle payloads.
- Extend `SettingsDialog` tests (none exist today; add
  `SettingsDialog.test.tsx` covering tab switching keeps provider form state).

---

## Part 5 — Core tests

`core/src/skills.rs` `#[cfg(test)]`:
- frontmatter: valid / missing / bad-name charset / body preserved.
- precedence: project shadows global; disabled key filters; disabled project skill
  does not un-shadow the global one (document the choice: the name is disabled, both
  scopes hidden — simpler mental model).
- `prompt_index` empty → `""`; truncation at 64 KiB in `load_skill`.
- workspace-attached project resolves under workspaceRoot (tempdir + fake project
  JSON, pattern already used in tools.rs tests ~L599/659).

`core/src/mcp.rs` `#[cfg(test)]`:
- `namespaced_name`: sanitize, 64-clamp, hash-suffix uniqueness.
- End-to-end against a scripted fake server:
  `Command::new("sh").arg("-c")` running a small inline `python3 - <<'EOF'` (or a
  `tests/fixtures/fake_mcp.py`) that answers initialize/tools list/tools call from
  stdin — asserts handshake order, tool call flattening, isError → Err, timeout path
  (server that never replies), crash path (server exits after initialize).
- `validate_mcp_servers`: bad id dropped, duplicate id dropped, defaults filled.

`core/src/agent.rs` tests: `requires_approval` matrix including
`("auto-accept-edits", "mcp__x__y", trusted=false) == true` and trusted==false-gate
bypass with `trusted=true`; `tool_register` rejects `mcp__` names.

---

## Part 6 — Build order (each step compiles + tests green before the next)

1. **config.rs**: `McpServerConfig`, `SkillsConfig`, `validate_mcp_servers`,
   defaults + round-trip serde tests. Nothing consumes them yet. (`cargo test`)
2. **skills.rs**: full module + unit tests. Make `tools::game_file_base` `pub(crate)`.
3. **Skills surfaces**: rpc `skill_list`/`skill_read`/`skill_set_enabled`;
   `default_system_prompt` index injection; `skill_list`/`skill_load` core tools;
   subagent prompt append. (`cargo test`, then manual: drop a skill file, new
   session, ask the agent to list skills.)
4. **mcp.rs**: `McpClient` + `McpManager` + namespacing + fake-server tests. Not yet
   wired into AppState. This is the long pole — land it isolated.
5. **Wiring**: `AppState.mcp`, boot `start_all`, shutdown hook, merged `registered`
   snapshot in `agent_chat` + `subagent_spawn` (both the RPC arm and
   `tools::spawn_subagent`), `ToolKind::Mcp` + dispatch arm in `execute_tool_call`,
   `is_destructive`/`requires_approval` trust argument, `tool_register` `mcp__`
   prefix reservation. (`cargo test`; manual: configure `uvx blender-mcp` or the
   fixture server, watch tools appear in a chat.)
6. **MCP RPC**: `mcp_list` / `mcp_reload` / `mcp_set_enabled`.
7. **Client**: `lib/extensions.ts` → `SkillsSection` → `McpSection` → SettingsDialog
   tabs + App.tsx `projectSlug` prop. (`npm test`, e2e smoke in
   `client/e2e/features.spec.ts`: settings dialog shows the two new tabs.)
8. **Docs**: README section "Extending CaliCode" documenting the skill file format
   and the `mcp_servers` config block.

Rollback safety: steps 1–4 are inert without step 5; step 5 is a single commit that
can be reverted independently of the UI.

## Out of scope for v1 (explicitly deferred)

- MCP transports other than stdio (http/sse) — `transport` field reserves the slot.
- MCP resources/prompts/sampling/roots; `notifications/tools/list_changed` re-fetch.
- Skill frontmatter extras (allowed-tools, model hints, auto-trigger keywords).
- UI for creating/editing skills or MCP server entries (file/config edited by hand).
- Per-session skill/MCP opt-out; refreshing the prompt index mid-session (blocked on
  the messages-empty injection guard, agent.rs:57 — a "refresh system prompt"
  mechanism is its own plan).
