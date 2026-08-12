# GRAPH ENGINEER — Implementation Blueprint

CaliCode's orchestration brain: the top agent decomposes a goal into a DAG of tasks,
fans each node out to a subagent, monitors every completion against acceptance
criteria, and gates the result behind a context-free CRITIC/JUDGE that scores 0-100
against a named AAA reference and re-queues the builder with a punch list until the
score crosses threshold — "until it's AAA or utterly perfect."

Product requirement (verbatim in spirit): *"fan out sub agent with subagent ->
monitor step by step, agent's progress with an existing template or user's goal.
judge it until it's AAA or utterly perfect."*

---

## 0. Architecture at a glance

```
user goal ─→ top agent (new system prompt)
                │ graph_plan(goal, template?)        ← core tool
                ▼
        TaskGraph JSON  (~/.cali/graphs/<id>.json, mirrored on the SSE bus)
                │ graph_run(graphId)
                ▼
        GraphEngine (core/src/graph.rs)
          for each READY node (deps all PASSED):
            1. RUN      → tools::spawn_subagent (existing machinery, enriched)
            2. MONITOR  → one-shot model::chat verdict vs node.acceptance
            3. if node.kind == Judge:
                 JUDGE  → fresh critic subagent, no builder context,
                          score 0-100 vs node.reference
                          score < threshold → re-queue builder deps with punch list
          repeat until all PASSED / attempts cap / cancel
                │  graph.* events (same broadcast bus)
                ▼
        client GraphPanel (nodes/edges/status/score, live)
```

Everything reuses existing plumbing: `spawn_subagent` for execution, the broadcast
bus for progress, `model::chat` for monitor/judge one-shots, `~/.cali` for
persistence, `tool_register`ed browser tools for scene evidence.

---

## 1. Core: `core/src/graph.rs` (NEW, ~700 lines)

### 1.1 Data model

```rust
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

pub const GRAPH_SCHEMA_VERSION: u32 = 1;
pub const MAX_NODES: usize = 24;
pub const MAX_ATTEMPTS_PER_NODE: u32 = 5;      // builder re-queues before FAILED
pub const DEFAULT_JUDGE_THRESHOLD: u32 = 90;   // "AAA" bar
pub const PERFECT_THRESHOLD: u32 = 100;        // "utterly perfect" mode
pub const DEFAULT_NODE_MAX_TURNS: usize = 8;
pub const MONITOR_MAX_TOKENS_HINT: &str = "Reply ONLY with JSON.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NodeKind {
    /// Does work: builds scenes/scripts/assets via a subagent.
    Build,
    /// Fresh-context critic: scores dep outputs 0-100 vs a named reference,
    /// rejects (re-queues builders with a punch list) until threshold met.
    Judge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NodeStatus {
    Pending,    // deps not yet satisfied
    Ready,      // schedulable
    Running,    // subagent in flight
    Monitoring, // monitor verdict in flight
    Passed,     // accepted (monitor pass, and judge pass if kind == Judge)
    Rejected,   // monitor/judge failed; will re-run (attempts < cap)
    Failed,     // attempts exhausted or hard error; graph blocks
    Skipped,    // upstream Failed
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GraphStatus { Planning, Running, Complete, Blocked, Cancelled }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,                 // slug-like, unique in graph
    pub title: String,
    pub kind: NodeKind,
    pub role: String,               // planner|coder|artist|tester|critic|...
    pub instructions: String,       // task body handed to the subagent
    pub acceptance: Vec<String>,    // MONITOR criteria (template or goal-derived)
    #[serde(default)]
    pub reference: Option<String>,  // Judge only: named AAA reference ("DOOM Eternal arena flow")
    #[serde(default)]
    pub threshold: Option<u32>,     // Judge only: pass score, default DEFAULT_JUDGE_THRESHOLD
    #[serde(default = "default_node_turns")]
    pub max_turns: usize,
    #[serde(default)]
    pub deps: Vec<String>,          // node ids; empty = root
    // ---- runtime state (persisted so the client can render progress) ----
    #[serde(default)]
    pub status: NodeStatus,         // default Pending
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub score: Option<u32>,         // last judge score
    #[serde(default)]
    pub punch_list: Vec<String>,    // outstanding fixes from monitor/judge
    #[serde(default)]
    pub last_report: Option<String>,// subagent reply (truncated to 4 KB on save)
    #[serde(default)]
    pub session_id: Option<String>, // child AgentSession id (client stream filter key)
}

fn default_node_turns() -> usize { DEFAULT_NODE_MAX_TURNS }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGraph {
    pub schema_version: u32,
    pub graph_id: String,           // "graph-<hex nanos>" (reuse image3d::short_id pattern)
    pub goal: String,
    #[serde(default)]
    pub template: Option<String>,   // template id it was instantiated from
    #[serde(default)]
    pub project_slug: Option<String>,
    pub nodes: Vec<GraphNode>,
    pub status: GraphStatus,
    pub created_at: String,         // RFC3339
    pub updated_at: String,
    #[serde(default)]
    pub owner_session: Option<String>, // top-agent session that planned it
}
```

Design choices, called out:

- **MONITOR is an engine phase, not a node kind.** Requirement 2 says "after each
  node completes, a monitor step compares output against acceptance criteria" —
  making it a phase means every node gets monitored for free and the DAG stays
  small. Requirement 3's CRITIC/JUDGE *is* a node kind because it has deps, a
  reference, and re-queue semantics.
- **Runtime state lives inside the persisted graph.** One JSON file is the single
  source of truth; every mutation re-saves and re-broadcasts, so the client render
  is a pure function of the last `graph.updated` payload.
- **`session_id` per node** lets the client demultiplex the shared SSE bus
  (deltas/tool events are only distinguishable by sessionId — see AgentPanel note
  in §6).

### 1.2 Validation + scheduling (pure functions, unit-testable)

```rust
/// Structural validation: id uniqueness, dep resolution, acyclicity (Kahn),
/// node cap, judge nodes carry reference + at least one Build dep,
/// role/id charset ([a-z0-9-], <= 48 chars).
pub fn validate(graph: &TaskGraph) -> Result<()>;

/// Nodes whose deps are all Passed and whose status is Pending|Ready|Rejected.
/// Deterministic order: topological layer, then declaration order.
pub fn ready_nodes(graph: &TaskGraph) -> Vec<String>;

/// Recompute Pending→Ready / mark Skipped below a Failed node. Called after
/// every state transition.
pub fn settle(graph: &mut TaskGraph);

/// True when every node is Passed (Complete) — or when nothing is Ready/Running
/// and something is Failed (Blocked).
pub fn terminal(graph: &TaskGraph) -> Option<GraphStatus>;
```

### 1.3 Persistence (`~/.cali/graphs/`)

Mirror `sessions.rs` exactly (tmp-file + rename atomic write, `clean_id` traversal
guard, newest-first summaries):

```rust
pub fn graphs_root(sessions_root: &Path) -> PathBuf;      // sessions_root/../graphs
pub fn save(root: &Path, graph: &TaskGraph) -> Result<()>;         // atomic
pub fn load(root: &Path, graph_id: &str) -> Result<TaskGraph>;
pub fn list(root: &Path, slug: Option<&str>) -> Result<Vec<Value>>; // summaries
pub fn delete(root: &Path, graph_id: &str) -> Result<()>;           // idempotent
```

Summary shape: `{graphId, goal, template, projectSlug, status, nodeCounts: {passed, running, failed, total}, updatedAt}`.

### 1.4 GraphManager (registered on AppState)

```rust
#[derive(Clone)]
pub struct GraphManager {
    /// graph_id -> cancel flag for in-flight runs. Engine checks between
    /// nodes and between attempts; subagent turns themselves are not
    /// interruptible (same limitation as subagent_spawn today).
    running: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl GraphManager {
    pub fn new() -> Self;
    pub async fn begin(&self, graph_id: &str) -> Result<Arc<AtomicBool>>; // bail if already running
    pub async fn end(&self, graph_id: &str);
    pub async fn cancel(&self, graph_id: &str) -> bool;                   // true if it was running
    pub async fn is_running(&self, graph_id: &str) -> bool;
}
```

`main.rs` change:

```rust
pub struct AppState {
    // ...existing fields...
    pub graphs: graph::GraphManager,   // NEW
}
```

### 1.5 Engine

```rust
/// Entry point behind the `graph_run` tool/RPC. Runs the whole graph to a
/// terminal state SYNCHRONOUSLY (mirrors spawn_subagent's recursion contract:
/// the caller's tool call awaits the full run; progress streams on the bus).
/// Returns the final graph JSON plus a rollup:
/// { graphId, status, passed, failed, totalAttempts, nodes: [...] }.
pub async fn run(state: &AppState, graph_id: &str) -> Result<Value>;

/// One node attempt: compose instructions (base + project context + punch
/// list), spawn the subagent, capture its report.
async fn run_node(state: &AppState, graph: &mut TaskGraph, node_id: &str) -> Result<()>;

/// MONITOR: single tool-less model::chat call. Returns pass/notes.
async fn monitor_node(state: &AppState, node: &GraphNode, report: &str)
    -> Result<MonitorVerdict>;

/// JUDGE: fresh critic subagent with NO builder context. Gathers its own
/// evidence via browser tools, scores 0-100 vs node.reference, returns a
/// punch list on failure.
async fn judge_node(state: &AppState, graph: &TaskGraph, node_id: &str)
    -> Result<JudgeVerdict>;

#[derive(Debug, Deserialize)]
pub struct MonitorVerdict { pub pass: bool, #[serde(default)] pub notes: Vec<String> }

#[derive(Debug, Deserialize)]
pub struct JudgeVerdict {
    pub score: u32,
    #[serde(default)]
    pub punch_list: Vec<String>,
    #[serde(default)]
    pub summary: String,
}

/// Robust JSON extraction from model prose (first {...} block; fenced or bare).
fn extract_json(text: &str) -> Option<Value>;

/// Emit a bus event and re-save the graph. `phase` in
/// created|node_started|node_monitor|node_passed|node_rejected|judge_verdict|
/// completed|blocked|cancelled.
fn broadcast(state: &AppState, root: &Path, graph: &TaskGraph, phase: &str, extra: Value);
```

**`run` control flow** (the heart of the requirement):

```
begin(graph_id) or bail "graph already running"
graph.status = Running; broadcast "created"
loop {
    if cancel_flag { status = Cancelled; break }
    settle(&mut graph);
    if let Some(t) = terminal(&graph) { status = t; break }
    let ready = ready_nodes(&graph);
    if ready.is_empty() { status = Blocked; break }   // deadlock guard
    let id = ready[0].clone();                        // sequential v1 (see §8)
    node.status = Running; node.attempts += 1; broadcast "node_started";

    match node.kind {
        Build => {
            run_node(...).await;                      // spawn_subagent
            node.status = Monitoring; broadcast "node_monitor";
            let v = monitor_node(...).await?;
            if v.pass { node.status = Passed; node.punch_list.clear(); broadcast "node_passed"; }
            else {
                node.punch_list = v.notes;
                node.status = if node.attempts >= MAX_ATTEMPTS_PER_NODE
                              { Failed } else { Rejected };  // Rejected re-enters ready set
                broadcast "node_rejected";
            }
        }
        Judge => {
            let v = judge_node(...).await?;
            node.score = Some(v.score);
            let threshold = node.threshold.unwrap_or(DEFAULT_JUDGE_THRESHOLD);
            broadcast "judge_verdict" { score, threshold, punchList };
            if v.score >= threshold { node.status = Passed; }
            else if node.attempts >= MAX_ATTEMPTS_PER_NODE { node.status = Failed; }
            else {
                // THE "until it's AAA" LOOP:
                // re-open every Build dep, hand it the judge's punch list,
                // reset the judge itself so it re-scores after the rework.
                node.status = Pending;
                for dep in &node.deps.clone() {
                    let d = node_mut(&mut graph, dep);
                    if d.kind == NodeKind::Build {
                        d.status = NodeStatus::Rejected;      // schedulable again
                        d.punch_list = v.punch_list.clone();  // builder sees exactly why
                    }
                }
                broadcast "node_rejected";
            }
        }
    }
}
graph.status = status; broadcast terminal phase; end(graph_id); save
```

**`run_node` instruction composition** (fixes "subagents get no project context"):

```
{node.instructions}

Project: {slug} — {entity_count} entities, {asset_count} assets, {test_count} tests.
Acceptance criteria you must satisfy:
- {acceptance[0]}
- ...
{if punch_list non-empty:}
A reviewer REJECTED the previous attempt. Fix every item, then re-verify:
- {punch_list[0]}
- ...
Finish with a concise report of what you changed and how you verified it.
```

Dispatch: `tools::spawn_subagent(state, &json!({ "role": node.role, "instructions": composed, "maxTurns": node.max_turns, "projectSlug": graph.project_slug, "system": node_system_prompt(node) }))` — see §3 for the `system` extension. Record `result["sessionId"]` into `node.session_id`, `result["reply"]` into `node.last_report`.

**`monitor_node` prompt** (tool-less `model::chat(&config, &msgs, None, None)`):

```
system: You are the MONITOR in CaliCode's graph engine. Compare a worker's
report against acceptance criteria. Be strict: a criterion counts only if the
report shows concrete evidence (files written, entities created, tests passing,
frames captured). Reply ONLY with JSON:
{"pass": true|false, "notes": ["unmet criterion or missing evidence", ...]}

user: GOAL: {graph.goal}
NODE: {node.title}
ACCEPTANCE CRITERIA:
{numbered criteria}
WORKER REPORT:
{report, truncated to 8 KB}
```

Parse with `extract_json`; unparseable → treat as fail with note "monitor verdict unparseable" (fail closed, never fail open).

**`judge_node`** — fresh subagent, zero builder context (requirement 3):

- Role `"critic"`, `maxTurns: 6`, same `projectSlug`, and a dedicated system prompt
  (passed through the new `system` arg):

```
You are a JUDGE with no knowledge of how this was built, and no stake in it
passing. Reference bar: {node.reference}. Inspect the actual result yourself:
use editor_scene_inspect, editor_run_pie, editor_capture_frame, editor_run_tests,
file_read. Do not trust any claims — verify. Then output ONLY JSON:
{"score": 0-100, "summary": "...", "punch_list": ["specific, actionable fix", ...]}
Scoring: 90+ means it would pass review at a AAA studio next to {reference};
100 means utterly perfect — you can name nothing to improve. Empty punch_list
is only permitted at 100.
```

- Its `instructions` = the acceptance criteria of the judge node + titles/reports
  of the Build deps' *deliverables* (what to look at, never how it was made).
- Parse the reply with `extract_json`; unparseable → score 0, punch list
  `["judge verdict unparseable — re-run"]` (fail closed).
- Evidence honesty note: `model::chat` is text-only today, so `editor_capture_frame`
  gives the judge a dataUrl it cannot *see*; scoring leans on
  `editor_scene_inspect` JSON, `editor_run_tests`, and `image3d_review`'s dHash
  fidelity. True pixel judging is follow-up F1 (§8).

### 1.6 Planning helpers (used by the `graph_plan` tool)

```rust
/// Build a TaskGraph either from an explicit node list (top agent authored)
/// or by instantiating a template with {{goal}}/{{slug}} interpolation.
/// Always validates; always appends a terminal Judge node if the plan has none
/// (the loop MUST end at a judge — that is the product requirement).
pub fn plan(
    goal: &str,
    project_slug: Option<&str>,
    template_id: Option<&str>,
    explicit_nodes: Option<&Value>,
    owner_session: Option<&str>,
) -> Result<TaskGraph>;
```

### 1.7 Bus events (client contract)

Every event carries the full graph snapshot so the client never needs to diff:

```json
{ "type": "graph.updated", "graphId": "...", "phase": "node_started",
  "nodeId": "blockout", "extra": { "score": 74, "threshold": 90 },
  "graph": { ...full TaskGraph... } }
```

Phases: `created | node_started | node_monitor | node_passed | node_rejected |
judge_verdict | completed | blocked | cancelled`. One event type keeps AgentPanel
wiring trivial.

---

## 2. Templates: `core/templates/*.json` (NEW data files)

Embedded at compile time, user-overridable on disk:

```rust
// in graph.rs
const BUILTIN_TEMPLATES: &[(&str, &str)] = &[
    ("aaa-fps", include_str!("../templates/aaa-fps.json")),
    ("polished-asset", include_str!("../templates/polished-asset.json")),
];

/// Disk override at ~/.cali/templates/<id>.json wins over the builtin.
pub fn load_template(sessions_root: &Path, id: &str) -> Result<GraphTemplate>;
pub fn list_templates(sessions_root: &Path) -> Vec<Value>; // {id, name, description, nodeCount}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub default_threshold: Option<u32>,
    pub nodes: Vec<TemplateNode>,   // same fields as GraphNode minus runtime state
}
```

`core/templates/aaa-fps.json` (ship this file):

```json
{
  "id": "aaa-fps",
  "name": "AAA FPS",
  "description": "First-person shooter vertical slice judged against a named AAA reference.",
  "defaultThreshold": 90,
  "nodes": [
    { "id": "design", "title": "Design doc", "kind": "build", "role": "planner",
      "instructions": "Write the design for: {{goal}}. Define player movement (speed, jump, air control), one weapon (fire rate, damage, feel), one enemy archetype, one arena layout, and the win/lose condition. Save it with file_write as design.md.",
      "acceptance": ["design.md exists in the project", "movement, weapon, enemy, arena, win/lose all specified with concrete numbers"] , "deps": [] },
    { "id": "blockout", "title": "Arena blockout", "kind": "build", "role": "coder",
      "instructions": "Build the arena from design.md as entities: floor, cover, spawn points, landmarks. Use editor_object_add / editor_update_transform. Distinct silhouettes, readable sightlines.",
      "acceptance": ["arena entities exist and are named", "player spawn and at least 4 cover pieces placed", "editor_capture_frame taken"], "deps": ["design"] },
    { "id": "player", "title": "Player controller", "kind": "build", "role": "coder",
      "instructions": "Implement player movement + camera per design.md as entity scripts (editor_script_write). Verify with editor_run_pie for 120 frames and capture a frame.",
      "acceptance": ["player entity moves under script control in PIE", "no script errors in logs", "frame captured during motion"], "deps": ["design", "blockout"] },
    { "id": "combat", "title": "Weapon + enemy", "kind": "build", "role": "coder",
      "instructions": "Implement the weapon and the enemy archetype per design.md: fire, hit, enemy reacts, death removes it. Add a test with editor_test_add proving a shot kills an enemy.",
      "acceptance": ["shooting works in PIE", "enemy dies and is removed", "editor_run_tests passes the combat test"], "deps": ["player"] },
    { "id": "polish", "title": "Feel + readability pass", "kind": "build", "role": "artist",
      "instructions": "Materials, lighting entities, scale, contrast: make the arena read like a shipped FPS screenshot. Adjust entity materials (color/metalness/roughness), add lights, retake captures.",
      "acceptance": ["every entity has deliberate material values", "at least one light entity beyond defaults", "fresh captures taken"], "deps": ["blockout", "combat"] },
    { "id": "judge", "title": "AAA verdict", "kind": "judge", "role": "critic",
      "reference": "DOOM (2016) arena combat slice",
      "threshold": 90,
      "instructions": "Score the playable slice for: movement feel, combat loop clarity, arena readability, visual cohesion, test coverage.",
      "acceptance": ["PIE runs clean", "combat test green", "scene visually cohesive vs reference"],
      "deps": ["player", "combat", "polish"] }
  ]
}
```

`core/templates/polished-asset.json`: 4 nodes — `spec` (planner: author a real
componentTree, not the placeholder), `build` (coder: image3d_validate +
image3d_generate + promote), `refine` (artist: material/silhouette pass, drive
image3d_review through PASS_ORDER), `judge` (critic, reference "Fortnite prop
quality bar", threshold 90). Same shape; body omitted here for brevity — author it
alongside aaa-fps.json in step 2 of the build order.

---

## 3. Core: `core/src/tools.rs` modifications

### 3.1 `spawn_subagent` — accept `system` and thread context (MODIFY, L361-397)

```rust
pub async fn spawn_subagent(state: &AppState, args: &Value) -> Result<Value> {
    // existing: role, instructions, maxTurns (default 6), projectSlug
    // NEW optional arg: system — full override of the hardcoded role blurb.
    //   When absent, keep today's format string EXCEPT append a compact project
    //   digest when projectSlug is present (entity/asset/test counts + names),
    //   fixing "subagents get no project context".
    // permission_mode stays "full-access" (unchanged, documented hazard §8).
}
```

Backward compatible: the AgentPanel Subagent widget passes no `system` and behaves
as before (plus the digest).

### 3.2 New core tool defs (append to `core_tool_defs()`, L80-200)

```rust
ToolDef { name: "graph_plan",
  description: "Decompose a goal into a task graph (DAG). Provide either template \
    (e.g. 'aaa-fps') or nodes (array of {id,title,kind:'build'|'judge',role,\
    instructions,acceptance[],deps[],reference?,threshold?,maxTurns?}). A terminal \
    judge node is added if missing. Returns the validated graph.",
  parameters: schema{ goal: string (req), slug: string?, template: string?, nodes: array? },
  kind: ToolKind::Core }

ToolDef { name: "graph_run",
  description: "Execute a planned graph to completion: each ready node runs as a \
    subagent, a monitor checks it against its acceptance criteria, judge nodes \
    score 0-100 vs their AAA reference and re-queue builders with a punch list \
    until the threshold is met. Streams graph.updated events; returns the final \
    graph + rollup. Long-running.",
  parameters: schema{ graphId: string (req) }, kind: Core }

ToolDef { name: "graph_status",
  description: "Read a graph's current state (nodes, statuses, scores, punch lists).",
  parameters: schema{ graphId: string (req) }, kind: Core }

ToolDef { name: "graph_list",
  description: "List saved graphs, optionally filtered by project slug.",
  parameters: schema{ slug: string? }, kind: Core }

ToolDef { name: "graph_cancel",
  description: "Cancel a running graph after the current node finishes.",
  parameters: schema{ graphId: string (req) }, kind: Core }

ToolDef { name: "template_list",
  description: "List goal templates (id, name, description) usable with graph_plan.",
  parameters: schema{}, kind: Core }
```

### 3.3 `execute_core_tool` arms (giant match, L213-359)

```rust
"graph_plan"    => graph::plan_tool(state, args).await,     // plan + save + broadcast "created"
"graph_run"     => graph::run(state, req_str(args, "graphId")?).await,
"graph_status"  => graph::status(state, args),
"graph_list"    => graph::list_tool(state, args),
"graph_cancel"  => graph::cancel_tool(state, args).await,
"template_list" => Ok(json!({ "templates": graph::list_templates(&state.sessions_root) })),
```

### 3.4 Permission classification (`core/src/agent.rs` L371-382)

Add to `is_destructive`: `"graph_run"`, `"graph_cancel"` (a run mutates the project
through its subagents; the spawn approval in `auto-accept-edits` then gates the
whole run in one prompt — individual child nodes stay full-access exactly like
`subagent_spawn` today). `graph_plan`/`graph_status`/`graph_list`/`template_list`
are read-shaped: not destructive.

---

## 4. Core: `core/src/rpc.rs` modifications

### 4.1 Dispatch entries (in `dispatch`, alongside `subagent_spawn` at L77)

```rust
"graph_plan"    => graph::plan_tool(&state, &params).await,
"graph_run"     => graph::run(&state, req_str(&params, "graphId")?).await,
"graph_status"  => graph::status(&state, &params),
"graph_list"    => graph::list_tool(&state, &params),
"graph_cancel"  => graph::cancel_tool(&state, &params).await,
"template_list" => Ok(json!({ "templates": graph::list_templates(&state.sessions_root) })),
```

Client and agent share the exact same surface (the established `subagent_spawn`
convention).

### 4.2 `default_system_prompt` — full rewrite (L519-530)

New signature (needs sessions_root for template list):

```rust
fn default_system_prompt(state: &AppState, slug: &str) -> String
// call site in agent_chat (L426-435) passes &state instead of &state.projects_root
```

Changes vs today:
1. Replaces the raw full-project-JSON dump with a **compact digest** (counts +
   names + workspaceRoot flag) — the whole-JSON dump inlines base64 assets and
   blows the context.
2. Teaches the decompose → fan out → monitor → judge → iterate loop.
3. Lists the full tool catalog (core + note that `editor_*` browser tools vary by
   what the client registered — enumerate live from `state.tools`).
4. Documents the **skills mechanism**: `CALICODE.md` + `skills/*.md` in the game
   folder are read at prompt-build time; `CALICODE.md` content is inlined,
   skill filenames are listed for on-demand `file_read`. (Resolution via the
   existing `resolve_game_file`, so workspace-attached games read from the user's
   folder.)
5. Lists available templates from `list_templates`.

Helper additions in rpc.rs:

```rust
fn project_digest(projects_root: &Path, slug: &str) -> String;      // counts + names, <= 2 KB
fn skills_block(projects_root: &Path, slug: &str) -> String;        // CALICODE.md inline + skills/ listing
fn browser_tools_block(tools: &HashMap<String, ToolDef>) -> String; // live registered names
```

### 4.3 THE COMPLETE NEW SYSTEM PROMPT TEXT

Rust `format!` template; `{...}` slots are interpolated, everything else is
literal. This is the exact text to ship:

```text
You are the CaliCode GRAPH ENGINEER — the orchestration brain of a game-creation
workbench. You build real, playable 3D scenes, scripts, assets, and tests, and
you do not stop at "works": you iterate until the result would pass review at a
AAA studio.

## Project
{project_digest}

## How you work: decompose -> fan out -> monitor -> judge -> iterate
For any goal bigger than one obvious edit, do NOT do everything yourself in one
long turn. Run the loop:

1. DECOMPOSE — call graph_plan with the user's goal. Prefer a template when one
   fits (template_list shows: {template_ids}); otherwise author the nodes
   yourself: small, verifiable tasks with explicit acceptance criteria and
   dependency edges. Every plan ends in a judge node with a named AAA reference
   (e.g. "DOOM (2016) arena combat slice") and a threshold (90 = AAA bar,
   100 = utterly perfect).
2. FAN OUT — call graph_run. Each ready node runs as a fresh subagent with the
   right role (planner, coder, artist, tester, critic) and only its own task —
   focused context beats one overloaded transcript.
3. MONITOR — after every node, an automatic monitor compares the worker's report
   against that node's acceptance criteria and rejects claims without evidence.
   Write acceptance criteria that demand evidence: files written, entities
   present, tests green, frames captured.
4. JUDGE — the judge node is a fresh critic that never sees how things were
   built. It inspects the live scene itself and scores 0-100 against the named
   reference. Below threshold it issues a punch list and the builders re-run.
5. ITERATE — rejection is the system working. The graph loops builders -> judge
   until the score crosses the threshold or attempts are exhausted. If a graph
   ends blocked, read graph_status, fix the stuck node's plan, and re-run.

For small direct edits (rename an entity, tweak one material) just use tools
directly — the graph is for goals, not keystrokes.

## Tools
Project/state: project_list, project_open, project_checkpoint, project_revert,
  file_read, file_write, file_list
Assets: asset_import_file, asset_hash_dedupe, asset_usage, asset_export_gltf,
  image3d_ingest, image3d_validate
Testing: test_baseline_save, test_baseline_compare
Models: model_list, model_switch
Orchestration: graph_plan, graph_run, graph_status, graph_list, graph_cancel,
  template_list, subagent_spawn (single one-off worker; prefer graphs for
  multi-step goals)
Editor (browser-registered, live scene access — the set depends on the open
editor): {browser_tools}

Verification is non-negotiable: after scene or script changes, run
editor_run_pie and editor_capture_frame; after gameplay changes, add or run
tests (editor_test_add, editor_run_tests); checkpoint (project_checkpoint)
before risky multi-step changes so project_revert can rescue you.

## Skills
Project-specific knowledge lives in the game folder. {skills_block}
Read the relevant skill file with file_read BEFORE working in its area, and
follow it over your defaults. When you learn something durable about this
project, offer to record it in CALICODE.md.

## Quality bar
"Done" means: it runs in PIE without errors, tests pass, the scene reads
clearly in a captured frame, and the judge scored it at or above threshold
against its reference. If you cannot name the reference you are matching, ask
the user for one. Never present unverified work as finished; say exactly what
was verified and how.

Be concise in chat. Put your effort into the work, not the narration.
```

Slot semantics:
- `{project_digest}`: e.g. `slug "space-arena" — 14 entities (player, arena-floor,
  ...), 6 assets (3 cali, 2 image, 1 procedural), 4 tests, workspace: none.`
- `{template_ids}`: comma-joined from `list_templates` (e.g. `aaa-fps, polished-asset`).
- `{browser_tools}`: comma-joined live names from `state.tools` (read lock,
  cloned, dropped before any await), or the literal
  `none registered — no editor is connected; scene tools unavailable this session`.
- `{skills_block}`: either
  `CALICODE.md:\n{inlined content, truncated 4 KB}\nSkill files: skills/enemy-ai.md, skills/level-style.md`
  or `No CALICODE.md or skills/ found — conventions are unset.`

Injection caveat (unchanged mechanics, agent.rs L57): the prompt lands only when
the core session is fresh. That is acceptable because the client replays history
and resumed-after-restart sessions create fresh core sessions anyway.

---

## 5. Client: `client/src/lib/graph.ts` (NEW, ~120 lines)

```ts
export type NodeKind = "build" | "judge";
export type NodeStatus = "pending" | "ready" | "running" | "monitoring"
  | "passed" | "rejected" | "failed" | "skipped";
export type GraphStatus = "planning" | "running" | "complete" | "blocked" | "cancelled";

export interface GraphNode {
  id: string; title: string; kind: NodeKind; role: string;
  instructions: string; acceptance: string[];
  reference?: string | null; threshold?: number | null;
  maxTurns: number; deps: string[];
  status: NodeStatus; attempts: number; score?: number | null;
  punchList: string[]; lastReport?: string | null; sessionId?: string | null;
}

export interface TaskGraph {
  schemaVersion: number; graphId: string; goal: string;
  template?: string | null; projectSlug?: string | null;
  nodes: GraphNode[]; status: GraphStatus;
  createdAt: string; updatedAt: string;
}

export interface GraphEvent {           // payload of type === "graph.updated"
  graphId: string; phase: string; nodeId?: string;
  extra?: Record<string, unknown>; graph: TaskGraph;
}

export function planGraph(args: { goal: string; slug?: string; template?: string;
  nodes?: unknown[] }): Promise<TaskGraph>;                  // rpc("graph_plan")
export function runGraph(graphId: string): Promise<unknown>; // rpc("graph_run") — resolves at terminal state
export function graphStatus(graphId: string): Promise<TaskGraph>;
export function listGraphs(slug?: string): Promise<GraphSummary[]>;
export function cancelGraph(graphId: string): Promise<void>;
export function listTemplates(): Promise<{ id: string; name: string; description: string }[]>;

/** Topological layering for render: returns node ids grouped by depth. */
export function layoutLayers(graph: TaskGraph): string[][];
```

---

## 6. Client: `client/src/components/editor/GraphPanel.tsx` (NEW, ~260 lines)

```ts
export function GraphPanel({ graph, onCancel, onRerun, onSelectNode }: {
  graph: TaskGraph;
  onCancel: (graphId: string) => void;
  onRerun: (graphId: string) => void;          // graph_run again on blocked graphs
  onSelectNode?: (node: GraphNode) => void;    // opens punch list / report drawer
}): JSX.Element;
```

Render (reuse SceneGraphCanvas's proven patterns — SVG bezier edges, absolute-
positioned cards):
- Columns = `layoutLayers(graph)`; edges drawn from each node to its deps with the
  same bezier path math as SceneGraphCanvas.tsx.
- Node card: title, role chip, status pill (color map: pending gray, ready
  slate, running pulse-blue, monitoring amber, passed green, rejected orange,
  failed red, skipped dim), attempts counter `x{n}` when > 1, judge nodes show
  `score/threshold` badge and the reference name.
- Click → drawer showing acceptance criteria, punch list, and `lastReport`.
- Header: goal (truncated), overall status, STOP button (`cancelGraph`), RE-RUN
  when blocked.
- Container `overflow-x: auto`; pure presentational component — all state comes
  in via props from AgentPanel.

**Mount point — AgentPanel (chat-centric, no new tab needed):**

`client/src/components/editor/AgentPanel.tsx` modifications:
1. New state `const [activeGraph, setActiveGraph] = useState<TaskGraph | null>(null)`.
2. In the existing SSE useEffect (L154-202) add:
   `case "graph.updated": setActiveGraph(ev.graph); break;` — full-snapshot events
   make this one line.
3. Render `<GraphPanel graph={activeGraph} .../>` pinned above the transcript when
   `activeGraph && activeGraph.status !== "complete"` (collapsible; completed
   graphs collapse to a one-line "score 93/90 PASSED" chip).
4. **Delta demux fix (required, not optional):** `agent.delta` currently appends to
   the transcript regardless of sessionId. With a graph fanning out subagents this
   becomes soup. Change the delta handler: if `ev.sessionId !== sessionId` and it
   matches some `activeGraph.nodes[].sessionId`, route it to a per-node live
   ticker inside that node's card (keep last ~200 chars) instead of the
   transcript. Unknown foreign sessionIds are dropped.
5. New slash commands in `lib/slashCommands.ts` + context (L500-514):
   - `/graph <goal>` → `planGraph({goal, slug, template: undefined})` then
     `runGraph(graphId)` (fire and let events drive the panel; the promise
     resolution appends a final summary bubble).
   - `/graph-template <id> <goal>` → same with template.
   - `/graph-stop` → `cancelGraph(activeGraph.graphId)`.

No `useBrowserTools.ts` changes are required for the engine itself (graph tools
are core tools), but the judge depends on the already-registered `editor_scene_inspect`,
`editor_run_pie`, `editor_capture_frame`, `editor_run_tests` — present today.

---

## 7. Build order (each step compiles + tests green before the next)

1. **`core/src/graph.rs` — model + pure logic.** Types (§1.1), `validate`,
   `ready_nodes`, `settle`, `terminal`, persistence (§1.3), `extract_json`.
   Unit tests: cycle rejection, diamond deps, Rejected re-entry, Skipped
   propagation, judge-without-reference rejection, JSON extraction from fenced
   and bare prose. `mod graph;` in main.rs.
2. **Templates.** `core/templates/aaa-fps.json`, `core/templates/polished-asset.json`,
   `GraphTemplate`, `load_template` (+ disk override), `list_templates`,
   interpolation, `plan` (§1.6). Tests: instantiation produces a valid graph;
   auto-appended terminal judge.
3. **`spawn_subagent` extension** (tools.rs §3.1): `system` arg + project digest.
   Test: absent `system` keeps legacy prompt shape.
4. **Engine** (§1.5): `GraphManager`, `run`, `run_node`, `monitor_node`,
   `judge_node`, `broadcast`. AppState gains `graphs` (main.rs). Integration
   test with a stub model (feature-gated or trait-injected chat fn): 2-node
   graph passes; judge rejects once then passes; cancel mid-run.
5. **Tool surface** (§3.2-3.4): 6 new ToolDefs, `execute_core_tool` arms,
   `is_destructive` additions. Test: defs serialize to valid OpenAI schema;
   `graph_run` requires approval in auto-accept-edits.
6. **RPC dispatch** (§4.1). Curl-level test: plan → status → run → status.
7. **`default_system_prompt` rewrite** (§4.2-4.3): digest/skills/browser-tools
   helpers + the new text. Test: prompt under 8 KB for a large project; skills
   block falls back cleanly; no raw project JSON in output.
8. **`client/src/lib/graph.ts`** (§5) + `layoutLayers` unit test.
9. **`GraphPanel.tsx` + AgentPanel wiring + slash commands** (§6), including the
   delta demux fix. e2e: `/graph` renders panel, node statuses advance, STOP works.
10. **Polish:** GamesSidebar recent-graphs list (via `graph_list`), collapse-chip
    for completed graphs, docs/README note.

Rust steps 1-7 are landable before any client work; the client degrades
gracefully (events simply unhandled) until step 9.

---

## 8. Known hazards + explicit follow-ups

- **F1 — Judge cannot see pixels.** `model::chat` is text-only; captured frames
  reach the judge as dataUrls it cannot view (same flaw as image3d_review's
  vision call, which never attaches the image). Follow-up: extend model.rs to
  accept OpenAI image content parts, then let judge/monitor attach the latest
  capture. Until then the judge scores structure + tests + dHash fidelity;
  thresholds calibrate to that.
- **Synchronous fan-out.** Nodes run sequentially (subagent recursion is
  synchronous). A whole graph occupies one long `graph_run` await. v2:
  spawn independent ready nodes as parallel tasks — requires making subagent
  runs detachable and the bus per-node backpressure-safe.
- **Full-access children.** Graph nodes inherit `spawn_subagent`'s hardcoded
  full-access. The single approval on `graph_run` (auto-accept-edits) is the
  consent boundary; document it in the UI ("running a graph grants its workers
  full access"). v2: thread the parent's permission mode through.
- **Context growth.** Rejected builders re-run as *fresh* sessions with the punch
  list — deliberately not resumed transcripts, so attempts don't compound
  context. `last_report` truncation (4 KB) keeps graph JSON and prompts bounded.
- **300s browser-tool timeout** applies inside judge/builder nodes exactly as
  today; long PIE runs must stay under it.
- **Session eviction (MAX_SESSIONS=32).** A large graph creates one core session
  per attempt; idle ones are evictable, so no cap issue, but node `session_id`
  values in old graphs may be dangling — the client must not assume they resume.

---

## 9. File census

| Action | Path |
| --- | --- |
| CREATE | `core/src/graph.rs` |
| CREATE | `core/templates/aaa-fps.json` |
| CREATE | `core/templates/polished-asset.json` |
| CREATE | `client/src/lib/graph.ts` |
| CREATE | `client/src/components/editor/GraphPanel.tsx` |
| MODIFY | `core/src/main.rs` (mod graph; AppState.graphs) |
| MODIFY | `core/src/tools.rs` (spawn_subagent `system` arg; 6 ToolDefs; dispatch arms) |
| MODIFY | `core/src/agent.rs` (is_destructive: graph_run, graph_cancel) |
| MODIFY | `core/src/rpc.rs` (6 dispatch entries; default_system_prompt rewrite + helpers) |
| MODIFY | `client/src/components/editor/AgentPanel.tsx` (graph events, GraphPanel mount, delta demux, slash commands) |
| MODIFY | `client/src/lib/slashCommands.ts` (/graph, /graph-template, /graph-stop) |
