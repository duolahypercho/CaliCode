//! GRAPH ENGINEER — CaliCode's orchestration brain.
//!
//! The top agent decomposes a goal into a DAG of tasks (`TaskGraph`), fans
//! ready Build nodes out to subagents in waves of up to `MAX_PARALLEL_NODES`
//! (judges always run alone), monitors every completion against acceptance
//! criteria, and gates the result behind a context-free CRITIC/JUDGE that
//! scores 0-100 against a named AAA reference and re-queues the builders with
//! a punch list until the score crosses threshold — "until it's AAA or utterly
//! perfect."
//!
//! Layout of this module:
//! - data model (`TaskGraph`, `GraphNode`, kinds/statuses)
//! - pure validation + scheduling (`validate`, `ready_nodes`, `settle`,
//!   `terminal`) — unit-testable with no I/O
//! - persistence under `~/.cali/graphs/` (atomic tmp+rename, traversal guard)
//! - templates (`~/.cali/templates/` overrides compiled-in defaults)
//! - `GraphManager` (cancel flags for in-flight runs, lives on `AppState`)
//! - the engine (`run`) plus the monitor and judge phases
//! - tool/RPC wrappers (`plan_tool`, `status`, `list_tool`, `cancel_tool`)

use anyhow::{Context, Result};
use base64::Engine;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::AppState;

pub const GRAPH_SCHEMA_VERSION: u32 = 1;
pub const MAX_NODES: usize = 24;
/// Builder re-queues before a node hard-fails.
pub const MAX_ATTEMPTS_PER_NODE: u32 = 5;
/// "AAA" bar.
pub const DEFAULT_JUDGE_THRESHOLD: u32 = 90;
/// "Utterly perfect" mode.
pub const PERFECT_THRESHOLD: u32 = 100;
pub const DEFAULT_NODE_MAX_TURNS: usize = 8;
/// Integration workers have to inspect every dependency, exercise the live
/// game, collect chronological evidence, and report. Eight turns repeatedly
/// stranded them on the final verification call, so keep a bounded floor
/// without changing the global 30-turn agent cap.
const INTEGRATION_MIN_TURNS: usize = 16;
/// Ready Build nodes executed concurrently per wave. Judge nodes never share
/// a wave — a judge always runs alone.
pub const MAX_PARALLEL_NODES: usize = 3;
/// Longest node id / role accepted by `validate`.
const MAX_SLUG_CHARS: usize = 48;
/// `last_report` is truncated to this when stored, so graph JSON and the
/// prompts built from it stay bounded.
const REPORT_SAVE_LIMIT: usize = 16 * 1024;
/// The monitor sees at most this much of a worker report.
const MONITOR_REPORT_LIMIT: usize = 16 * 1024;
/// Each Build dep's report shown to the judge is capped at this.
const JUDGE_DEP_REPORT_LIMIT: usize = 1024;
/// Turn budget for the fresh-context critic subagent.
const JUDGE_MAX_TURNS: usize = 6;
/// Per-attempt tool attestations are a bounded supplement to the worker's
/// prose. They contain summaries only; large console/test payloads never enter
/// the graph state or monitor prompt.
const MAX_ATTESTED_TOOL_CALLS: usize = 64;
const MAX_ATTESTED_ARGUMENT_BYTES: usize = 16 * 1024;
const MAX_ATTESTED_IDS: usize = 128;
const MAX_ATTESTED_ERROR_CHARS: usize = 512;
const MAX_ATTESTED_SOURCE_CHARS: usize = 4 * 1024;
const MAX_ATTESTED_SCENE_ITEMS: usize = 32;
const MONITOR_ATTESTATION_LIMIT: usize = 32 * 1024;
/// Maximum number of editor captures retained for one node attempt.
const MAX_CAPTURE_FRAMES: usize = crate::video_analysis::MAX_FRAMES;
/// A single screenshot must remain bounded before it is decoded.
const MAX_CAPTURE_DATA_URL_BYTES: usize = 8 * 1024 * 1024;
/// Aggregate data URL memory retained by one listener.
const MAX_CAPTURE_DATA_URL_TOTAL_BYTES: usize = crate::video_analysis::MAX_INPUT_BYTES;
/// Persisted evidence paths are deliberately short and relative.
const MAX_EVIDENCE_PATH_CHARS: usize = 512;
/// Per-attempt cap on individual `editor_persist_capture` events the
/// listener will retain. Mirrors `MAX_CAPTURE_FRAMES` so a worker cannot
/// game one path past the other without bumping the cap.
const MAX_PERSISTED_CAPTURES: usize = crate::video_analysis::MAX_FRAMES;
/// Aggregate bytes retained by one listener across all persisted capture
/// events. Counts the on-disk payload sizes reported in each event, not the
/// metadata overhead — a 4MB capture pushes the listener closer to the cap
/// the same way a 4MB data URL does.
const MAX_PERSISTED_BYTES: usize = crate::video_analysis::MAX_INPUT_BYTES;
/// Suffixes the listener treats as secret-named paths so an attacker who
/// can drive `editor_persist_capture` cannot smuggle captured evidence
/// into a path the model would not be allowed to read. Mirrors the
/// patterns `capture_persist` rejects.
const PERSISTED_SECRET_SUFFIXES: &[&str] =
    &[".env", "id_rsa", "id_ed25519", ".pem", ".p12", ".keystore"];
/// Filename suffixes the listener accepts. Anything else (`.html`, `.svg`,
/// `.exe`, ...) is refused up front so the path cannot smuggle an
/// executable into the project tree.
const PERSISTED_IMAGE_SUFFIXES: &[&str] = &[".png", ".jpg", ".jpeg"];

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NodeKind {
    /// Does work: builds scenes/scripts/assets via a subagent.
    Build,
    /// Fresh-context critic: scores dep outputs 0-100 vs a named reference,
    /// rejects (re-queues builders with a punch list) until threshold met.
    Judge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum NodeStatus {
    /// Deps not yet satisfied.
    #[default]
    Pending,
    /// Schedulable.
    Ready,
    /// Subagent in flight.
    Running,
    /// Monitor verdict in flight.
    Monitoring,
    /// Accepted (monitor pass, and judge pass if kind == Judge).
    Passed,
    /// Monitor/judge failed; will re-run (attempts < cap).
    Rejected,
    /// Attempts exhausted or hard error; graph blocks.
    Failed,
    /// Upstream Failed.
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GraphStatus {
    Planning,
    Running,
    Complete,
    Blocked,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    /// Slug-like, unique in graph.
    pub id: String,
    pub title: String,
    pub kind: NodeKind,
    /// planner|coder|artist|tester|critic|...
    pub role: String,
    /// Task body handed to the subagent.
    pub instructions: String,
    /// MONITOR criteria (template or goal-derived).
    #[serde(default)]
    pub acceptance: Vec<String>,
    /// Judge only: named AAA reference ("DOOM Eternal arena flow").
    #[serde(default)]
    pub reference: Option<String>,
    /// Judge only: pass score, default DEFAULT_JUDGE_THRESHOLD.
    #[serde(default)]
    pub threshold: Option<u32>,
    #[serde(default = "default_node_turns")]
    pub max_turns: usize,
    /// Node ids; empty = root.
    #[serde(default)]
    pub deps: Vec<String>,
    // ---- runtime state (persisted so the client can render progress) ----
    #[serde(default)]
    pub status: NodeStatus,
    #[serde(default)]
    pub attempts: u32,
    /// Last judge score.
    #[serde(default)]
    pub score: Option<u32>,
    /// Outstanding fixes from monitor/judge.
    #[serde(default)]
    pub punch_list: Vec<String>,
    /// Subagent reply (truncated to REPORT_SAVE_LIMIT when stored).
    #[serde(default)]
    pub last_report: Option<String>,
    /// Child AgentSession id (client stream filter key).
    #[serde(default)]
    pub session_id: Option<String>,
    /// Safe project-relative paths to the attempt's contact sheet and manifest.
    #[serde(default)]
    pub evidence_paths: Vec<String>,
    /// Number of valid frames represented by the persisted contact sheet.
    #[serde(default)]
    pub evidence_count: usize,
    /// Attempt number that produced the current evidence metadata.
    #[serde(default)]
    pub evidence_attempt: Option<u32>,
}

fn default_node_turns() -> usize {
    DEFAULT_NODE_MAX_TURNS
}

fn is_integration_node(node: &GraphNode) -> bool {
    if node.kind != NodeKind::Build {
        return false;
    }
    let names = [node.id.as_str(), node.title.as_str(), node.role.as_str()];
    names.iter().any(|value| {
        value
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|part| {
                part.eq_ignore_ascii_case("integration") || part.eq_ignore_ascii_case("integrator")
            })
    })
}

fn effective_node_max_turns(node: &GraphNode) -> usize {
    let requested = node.max_turns.clamp(1, 30);
    if is_integration_node(node) {
        requested.max(INTEGRATION_MIN_TURNS)
    } else {
        requested
    }
}

fn normalize_node_turn_budgets(nodes: &mut [GraphNode]) {
    for node in nodes {
        node.max_turns = effective_node_max_turns(node);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGraph {
    pub schema_version: u32,
    /// "graph-<hex nanos>".
    pub graph_id: String,
    pub goal: String,
    /// Template id it was instantiated from.
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub project_slug: Option<String>,
    pub nodes: Vec<GraphNode>,
    pub status: GraphStatus,
    /// RFC3339.
    pub created_at: String,
    pub updated_at: String,
    /// Top-agent session that planned it.
    #[serde(default)]
    pub owner_session: Option<String>,
    /// Immutable worktree bound to the owner session. Browser-tool requests
    /// from graph children route through that same editor attachment.
    #[serde(default)]
    pub workspace_root: Option<String>,
    /// Request-scoped reasoning effort inherited from the coordinator.
    /// Optional for compatibility with graphs saved before effort propagation.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

fn short_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", now)
}

/// Days-since-epoch to (year, month, day); Howard Hinnant's civil_from_days.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

/// Char-boundary-safe truncation with an explicit marker.
fn truncate_chars(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[truncated]", &text[..end])
}

/// `[a-z0-9-]`, non-empty, bounded — node ids and roles.
fn valid_slug(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Normalize a planner-supplied id or role into the slug charset (`[a-z0-9-]`).
/// Empty / whitespace-only input short-circuits so callers can surface a
/// dedicated error rather than receiving a `---` placeholder.
fn slugify_for_id_role(input: &str) -> Option<String> {
    let lowered = input.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(lowered.len());
    let mut last_dash = true;
    for ch in lowered.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Pretty-render a serde failure on a planner-supplied `nodes` value so the
/// caller sees the actual field/type mismatch and not just the outer context.
/// The agent panel surfaces whatever string we hand it, so naming the field
/// and expected type is what makes the error actionable.
fn format_provider_nodes_error(value: &Value, err: &serde_json::Error) -> String {
    let mut detail = String::new();
    let line = err.line();
    let column = err.column();
    detail.push_str(&format!("serde: {err} (at line {line}, column {column})"));

    match value {
        Value::Array(items) => {
            detail.push_str(&format!("; received an array of {} item(s)", items.len()));
            if let Some(index) = offending_node_index(items, line, column) {
                let preview = truncate_chars(&items[index].to_string(), 200);
                detail.push_str(&format!("; offending item #{index}: {preview}"));
            }
        }
        Value::Object(map) => {
            detail.push_str("; received an object");
            if !map.contains_key("nodes") {
                detail.push_str(" (no `nodes` array inside)");
            } else {
                match map.get("nodes") {
                    Some(Value::Array(items)) => {
                        detail.push_str(&format!("; nodes has {} item(s)", items.len()));
                        if let Some(index) = offending_node_index(items, line, column) {
                            let preview = truncate_chars(&items[index].to_string(), 200);
                            detail.push_str(&format!("; offending item #{index}: {preview}"));
                        }
                    }
                    Some(other) => {
                        detail.push_str(&format!(
                            "; nodes must be an array, got {}",
                            json_type_name(other)
                        ));
                    }
                    None => {}
                }
            }
        }
        other => {
            detail.push_str(&format!(
                "; nodes must be an array, got {}",
                json_type_name(other)
            ));
        }
    }
    detail
}

/// Best-effort identification of the node entry that triggered a serde error
/// based on the reported line/column. Falls back to the first item so the
/// preview still points somewhere useful.
fn offending_node_index(items: &[Value], line: usize, column: usize) -> Option<usize> {
    let mut first_index = None;
    for (index, item) in items.iter().enumerate() {
        let text = item.to_string();
        if first_index.is_none() {
            first_index = Some(index);
        }
        if text.contains('\n') {
            continue;
        }
        let single_line = text.lines().next().unwrap_or("");
        if single_line.is_empty() {
            continue;
        }
        let approx_line = 1 + text.matches('\n').count();
        let approx_column = single_line.len() + 1;
        if approx_line == line && approx_column.abs_diff(column) <= 1 {
            return Some(index);
        }
    }
    if line == 1 && column <= 2 {
        return first_index;
    }
    None
}

fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Normalize common provider variants of an explicit `nodes` payload so the
/// planner can call the same tool contract regardless of the model that
/// produced the JSON. Only id, role, deps, and `kind` are coerced — those
/// are the fields whose invariant (slug charset, lowercase enum) the
/// validator enforces strictly. Other fields are passed through verbatim
/// because re-writing instructions or acceptance strings risks silently
/// changing meaning.
fn normalize_provider_nodes(value: Value) -> Value {
    let mut value = value;
    if let Value::Object(ref mut map) = value {
        let looks_like_wrapper = map.contains_key("nodes")
            && !map.contains_key("id")
            && !map.contains_key("title")
            && !map.contains_key("role")
            && !map.contains_key("instructions");
        if looks_like_wrapper {
            if let Some(nested) = map.remove("nodes") {
                value = nested;
            }
        }
    }
    let mut items = match value {
        Value::Array(items) => items,
        other => return other,
    };
    let mut out: Vec<Value> = Vec::with_capacity(items.len());
    for mut item in items.drain(..) {
        if let Value::Object(ref mut map) = item {
            if let Some(kind) = map.get_mut("kind") {
                normalize_kind_value(kind);
            }
            if let Some(id) = map.get("id").and_then(Value::as_str) {
                if let Some(slug) = slugify_for_id_role(id) {
                    map.insert("id".into(), Value::String(slug));
                }
            }
            if let Some(role) = map.get("role").and_then(Value::as_str) {
                if let Some(slug) = slugify_for_id_role(role) {
                    map.insert("role".into(), Value::String(slug));
                }
            }
            if let Some(deps) = map.get_mut("deps") {
                normalize_deps_value(deps);
            }
        }
        out.push(item);
    }
    Value::Array(out)
}

/// Lowercase + trim the `kind` field. Only plain string variants are coerced;
/// object forms (e.g. `{ "value": "build" }`) are passed through so the
/// serde error points at the actual structure the provider emitted.
fn normalize_kind_value(kind: &mut Value) {
    if let Value::String(text) = kind {
        let trimmed = text.trim().to_ascii_lowercase();
        if !trimmed.is_empty() {
            *kind = Value::String(trimmed);
        }
    }
}

/// Coerce `deps` from the `{ "id": [] }` object shape some providers emit
/// back into a flat list of id strings, then slug each entry so it matches
/// the normalized node id.
fn normalize_deps_value(deps: &mut Value) {
    if let Value::Object(map) = deps {
        let mut keys: Vec<String> = map
            .keys()
            .filter_map(|key| slugify_for_id_role(key))
            .collect();
        keys.sort();
        *deps = Value::Array(keys.into_iter().map(Value::String).collect());
        return;
    }
    if let Value::Array(items) = deps {
        let mut rewritten: Vec<Value> = Vec::with_capacity(items.len());
        for dep in items.iter() {
            if let Some(text) = dep.as_str() {
                if let Some(slug) = slugify_for_id_role(text) {
                    rewritten.push(Value::String(slug));
                    continue;
                }
            }
            rewritten.push(dep.clone());
        }
        *deps = Value::Array(rewritten);
    }
}

// Material field names that scripts cannot patch at runtime. The SCRIPT
// RUNTIME CONTRACT ("Only transforms are patchable; invalid fields are
// ignored and logged. Runtime material mutation does not exist, so use
// static `editor_object_update` material changes before PIE...") is the
// source of truth. Matching is case-insensitive.
const RUNTIME_MATERIAL_FIELDS: &[&str] = &[
    "emissiveIntensity",
    "emissive",
    "material.color",
    "material.roughness",
    "material.metalness",
    "material.opacity",
    "material.alpha",
    "material.texture",
    "material.normalMap",
    "material.shader",
    "material.emissive",
    "material.emissiveIntensity",
    "material.specular",
    "material.diffuse",
    "material.albedo",
    "material.tint",
];

// Phrases that imply the material should mutate while PIE is running.
const RUNTIME_MUTATION_PHRASES: &[&str] = &[
    "pulse",
    "pulses",
    "pulsing",
    "animate",
    "animates",
    "animating",
    "animated",
    "runtime",
    "run-time",
    "during pie",
    "during play",
    "during playtest",
    "during runtime",
    "per frame",
    "per-frame",
    "every frame",
    "every tick",
    "flicker",
    "flickers",
    "flickering",
    "oscillate",
    "oscillates",
    "oscillating",
    "interpolate",
    "interpolates",
    "interpolating",
    "lerp",
    "lerps",
    "lerping",
    "modulate",
    "modulates",
    "modulating",
    "mutate",
    "mutates",
    "mutating",
    "mutated",
    "over time",
    "while playing",
    "while running",
];

// Phrases that prove the criterion is a static authoring step (one-time
// `editor_object_update` before PIE), not a runtime material mutation.
const STATIC_AUTHORING_PHRASES: &[&str] = &[
    "editor_object_update",
    "set to",
    "is set",
    "must be set",
    "before pie",
    "before play",
    "before playtest",
    "before runtime",
    "statically",
    "is configured",
    "configured as",
    "configures",
    "authored as",
    "is authored",
    "at rest",
];

// Returns the (material field, runtime phrase) pair when the criterion
// implies a runtime material mutation. Static authoring phrases such as
// `editor_object_update` or `is set to` short-circuit, so legitimate
// editor_object_update material criteria keep flowing through. A
// criterion without either a material field or a runtime phrase never
// matches.
fn detect_runtime_material_mutation(criterion: &str) -> Option<(&'static str, &'static str)> {
    let lower = criterion.to_ascii_lowercase();
    if STATIC_AUTHORING_PHRASES
        .iter()
        .any(|hint| lower.contains(hint))
    {
        return None;
    }
    let material = RUNTIME_MATERIAL_FIELDS
        .iter()
        .find(|field| lower.contains(&field.to_ascii_lowercase()))
        .copied();
    let runtime = RUNTIME_MUTATION_PHRASES
        .iter()
        .find(|phrase| lower.contains(*phrase))
        .copied();
    match (material, runtime) {
        (Some(field), Some(phrase)) => Some((field, phrase)),
        _ => None,
    }
}

fn runtime_material_acceptance_error(nodes: &[GraphNode]) -> Option<String> {
    for (node_index, node) in nodes.iter().enumerate() {
        for (criterion_index, criterion) in node.acceptance.iter().enumerate() {
            if let Some((field, phrase)) = detect_runtime_material_mutation(criterion) {
                return Some(format!(
                    "graph node {node_index} ('{}').acceptance[{criterion_index}] asks for runtime material mutation (mentions '{field}' with runtime phrase '{phrase}'); runtime material mutation does not exist. Revise to transform feedback via `state.patch(nameOrId, {{ position?, rotation?, scale? }})`, or a static material criterion authored with `editor_object_update` before PIE.",
                    node.id
                ));
            }
        }
    }
    None
}

/// Catch provider shape mistakes with a JSON path before serde erases the
/// field name from errors such as "invalid type: map, expected a sequence".
/// Missing defaulted fields remain serde-compatible for old saved callers;
/// the public tool schema still requires acceptance and deps for new plans.
fn validate_provider_node_shapes(value: &Value) -> Result<()> {
    let items = value.as_array().ok_or_else(|| {
        anyhow::anyhow!(
            "graph_plan.nodes must be an array, got {}",
            json_type_name(value)
        )
    })?;
    for (index, item) in items.iter().enumerate() {
        let object = item.as_object().ok_or_else(|| {
            anyhow::anyhow!(
                "graph_plan.nodes[{index}] must be an object, got {}",
                json_type_name(item)
            )
        })?;
        for field in ["acceptance", "deps"] {
            let Some(value) = object.get(field) else {
                continue;
            };
            let Some(values) = value.as_array() else {
                anyhow::bail!(
                    "graph_plan.nodes[{index}].{field} must be an array of strings, got {}",
                    json_type_name(value)
                );
            };
            if let Some((value_index, invalid)) = values
                .iter()
                .enumerate()
                .find(|(_, candidate)| !candidate.is_string())
            {
                anyhow::bail!(
                    "graph_plan.nodes[{index}].{field}[{value_index}] must be a string, got {}",
                    json_type_name(invalid)
                );
            }
        }
        for field in ["id", "title", "kind", "role", "instructions", "reference"] {
            if let Some(value) = object.get(field) {
                if !value.is_string() && !value.is_null() {
                    anyhow::bail!(
                        "graph_plan.nodes[{index}].{field} must be a string, got {}",
                        json_type_name(value)
                    );
                }
            }
        }
        for field in ["threshold", "maxTurns"] {
            if let Some(value) = object.get(field) {
                if value.as_u64().is_none() && !value.is_null() {
                    anyhow::bail!(
                        "graph_plan.nodes[{index}].{field} must be a non-negative integer, got {}",
                        json_type_name(value)
                    );
                }
            }
        }
        // Fail-closed guard against acceptance criteria that demand
        // runtime material mutation. The SCRIPT RUNTIME CONTRACT (see
        // script_runtime_contract_paragraph) says only transforms are
        // patchable, so scripts cannot pulse `emissiveIntensity` or
        // otherwise animate a material field while PIE is running. The
        // planner must instead use static `editor_object_update`
        // material criteria or transform feedback via `state.patch`.
        if let Some(acceptance) = object.get("acceptance").and_then(Value::as_array) {
            for (value_index, value) in acceptance.iter().enumerate() {
                let Some(text) = value.as_str() else { continue };
                if let Some((field, phrase)) = detect_runtime_material_mutation(text) {
                    anyhow::bail!(
                        "graph_plan.nodes[{index}].acceptance[{value_index}] asks for \
                         runtime material mutation (mentions '{field}' with runtime phrase \
                         '{phrase}'); runtime material mutation does not exist. Revise to \
                         either (a) transform feedback via \
                         `state.patch(nameOrId, {{ position?, rotation?, scale? }})`, or \
                         (b) static material criteria authored with `editor_object_update` \
                         before PIE."
                    );
                }
            }
        }
    }
    Ok(())
}

/// Reject graph ids that could escape the graphs directory (defense in depth,
/// mirrors sessions::clean_id).
fn clean_graph_id(id: &str) -> Result<String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        anyhow::bail!("invalid graph id");
    }
    Ok(id.to_string())
}

/// Robust typed JSON extraction from model prose: the first balanced `{...}`
/// block (fenced or bare) that matches the requested schema. A judge often
/// quotes JSON returned by editor tools before its actual verdict, so stopping
/// at the first merely valid object can turn a later valid verdict into a false
/// rejection. String-aware brace matching keeps `{"a": "}"}` intact.
fn extract_typed_json<T: DeserializeOwned>(text: &str) -> Option<T> {
    for (start, _) in text.char_indices().filter(|(_, c)| *c == '{') {
        let mut depth = 0usize;
        let mut in_string = false;
        let mut escaped = false;
        for (offset, ch) in text[start..].char_indices() {
            if in_string {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    in_string = false;
                }
                continue;
            }
            match ch {
                '"' => in_string = true,
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        let candidate = &text[start..start + offset + ch.len_utf8()];
                        if let Ok(value) = serde_json::from_str::<T>(candidate) {
                            return Some(value);
                        }
                        break; // balanced but wrong schema; try the next '{'
                    }
                }
                _ => {}
            }
        }
    }
    None
}

/// Extract the first balanced object that is valid JSON. Verdict consumers use
/// `extract_typed_json` directly so unrelated leading objects are skipped.
#[cfg(test)]
pub fn extract_json(text: &str) -> Option<Value> {
    extract_typed_json(text)
}

// ---------------------------------------------------------------------------
// Validation + scheduling (pure)
// ---------------------------------------------------------------------------

/// Kahn's algorithm over the dep edges. Returns each node's topological depth
/// (max dep depth + 1) or an error naming the cycle members.
fn topo_depths(graph: &TaskGraph) -> Result<HashMap<String, usize>> {
    let ids: HashSet<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
    let mut indegree: HashMap<&str, usize> = HashMap::new();
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();
    for node in &graph.nodes {
        indegree.entry(node.id.as_str()).or_insert(0);
        for dep in &node.deps {
            if !ids.contains(dep.as_str()) {
                anyhow::bail!("node '{}' depends on unknown node '{}'", node.id, dep);
            }
            *indegree.entry(node.id.as_str()).or_insert(0) += 1;
            dependents.entry(dep.as_str()).or_default().push(&node.id);
        }
    }
    let mut depths: HashMap<String, usize> = HashMap::new();
    // Declaration order within a layer keeps scheduling deterministic.
    let mut queue: Vec<&str> = graph
        .nodes
        .iter()
        .filter(|n| indegree[n.id.as_str()] == 0)
        .map(|n| n.id.as_str())
        .collect();
    for id in &queue {
        depths.insert((*id).to_string(), 0);
    }
    let mut cursor = 0usize;
    while cursor < queue.len() {
        let current = queue[cursor];
        cursor += 1;
        let depth = depths[current];
        for next in dependents.get(current).cloned().unwrap_or_default() {
            let entry = depths.entry(next.to_string()).or_insert(0);
            *entry = (*entry).max(depth + 1);
            let degree = indegree.get_mut(next).expect("known node");
            *degree -= 1;
            if *degree == 0 {
                queue.push(next);
            }
        }
    }
    if depths.len() != graph.nodes.len() {
        let stuck: Vec<&str> = graph
            .nodes
            .iter()
            .map(|n| n.id.as_str())
            .filter(|id| !depths.contains_key(*id))
            .collect();
        anyhow::bail!("dependency cycle involving: {}", stuck.join(", "));
    }
    Ok(depths)
}

/// Structural validation: id uniqueness, dep resolution, acyclicity (Kahn),
/// node cap, judge nodes carry a reference plus at least one Build dep,
/// id/role charset ([a-z0-9-], <= 48 chars).
pub fn validate(graph: &TaskGraph) -> Result<()> {
    if graph.nodes.is_empty() {
        anyhow::bail!("graph has no nodes");
    }
    if graph.nodes.len() > MAX_NODES {
        anyhow::bail!("graph has {} nodes; max {}", graph.nodes.len(), MAX_NODES);
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for node in &graph.nodes {
        if !valid_slug(&node.id, MAX_SLUG_CHARS) {
            anyhow::bail!("node id '{}' must be [a-z0-9-], 1-48 chars", node.id);
        }
        if !valid_slug(&node.role, MAX_SLUG_CHARS) {
            anyhow::bail!(
                "node '{}' role '{}' must be [a-z0-9-], 1-48 chars",
                node.id,
                node.role
            );
        }
        if !seen.insert(node.id.as_str()) {
            anyhow::bail!("duplicate node id '{}'", node.id);
        }
        if node.deps.iter().any(|dep| dep == &node.id) {
            anyhow::bail!("node '{}' depends on itself", node.id);
        }
        if node.kind == NodeKind::Judge {
            if node
                .reference
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                anyhow::bail!("judge node '{}' needs a named reference", node.id);
            }
            let has_build_dep = node.deps.iter().any(|dep| {
                graph
                    .nodes
                    .iter()
                    .any(|other| &other.id == dep && other.kind == NodeKind::Build)
            });
            if !has_build_dep {
                anyhow::bail!("judge node '{}' needs at least one build dep", node.id);
            }
        }
    }
    topo_depths(graph)?;
    Ok(())
}

/// Nodes whose deps are all Passed and whose status is Pending|Ready|Rejected.
/// Deterministic order: topological layer, then declaration order.
pub fn ready_nodes(graph: &TaskGraph) -> Vec<String> {
    let Ok(depths) = topo_depths(graph) else {
        return Vec::new();
    };
    let status_of: HashMap<&str, NodeStatus> = graph
        .nodes
        .iter()
        .map(|n| (n.id.as_str(), n.status))
        .collect();
    let mut ready: Vec<(usize, usize, String)> = graph
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| {
            matches!(
                node.status,
                NodeStatus::Pending | NodeStatus::Ready | NodeStatus::Rejected
            )
                // A node a judge re-opened at the cap must not get another
                // scheduler pass; settle() escalates it to Failed.
                && (node.status != NodeStatus::Rejected
                    || node.attempts < MAX_ATTEMPTS_PER_NODE)
                && node
                .deps
                .iter()
                .all(|dep| status_of.get(dep.as_str()) == Some(&NodeStatus::Passed))
        })
        .map(|(index, node)| (depths[&node.id], index, node.id.clone()))
        .collect();
    ready.sort();
    ready.into_iter().map(|(_, _, id)| id).collect()
}

/// Recompute Pending<->Ready and mark Skipped below a Failed node. Called
/// after every state transition. Iterates to a fixpoint so skip status
/// propagates down arbitrarily deep chains. Nodes that are actively in
/// flight (Running/Monitoring) are never flipped to Skipped mid-attempt —
/// they get settled on the next pass, once their attempt resolves.
pub fn settle(graph: &mut TaskGraph) {
    loop {
        let status_of: HashMap<String, NodeStatus> = graph
            .nodes
            .iter()
            .map(|n| (n.id.clone(), n.status))
            .collect();
        let mut changed = false;
        for node in &mut graph.nodes {
            let dep_failed = node.deps.iter().any(|dep| {
                matches!(
                    status_of.get(dep),
                    Some(NodeStatus::Failed) | Some(NodeStatus::Skipped)
                )
            });
            let deps_passed = node
                .deps
                .iter()
                .all(|dep| status_of.get(dep) == Some(&NodeStatus::Passed));
            let next = match node.status {
                _ if dep_failed
                    && !matches!(
                        node.status,
                        NodeStatus::Failed
                            | NodeStatus::Skipped
                            | NodeStatus::Running
                            | NodeStatus::Monitoring
                    ) =>
                {
                    NodeStatus::Skipped
                }
                // A judge re-opened this node at the cap: no further attempt
                // is possible, so it must not stay re-queueable. Coherence
                // sweep before ready_nodes() so downstream Skipped/Cascade
                // sees Failed rather than Rejected.
                NodeStatus::Rejected if node.attempts >= MAX_ATTEMPTS_PER_NODE => {
                    NodeStatus::Failed
                }
                NodeStatus::Pending if deps_passed => NodeStatus::Ready,
                NodeStatus::Ready if !deps_passed => NodeStatus::Pending,
                current => current,
            };
            if next != node.status {
                node.status = next;
                changed = true;
            }
        }
        if !changed {
            return;
        }
    }
}

/// Some(Complete) when every node is Passed; Some(Blocked) when nothing is
/// Ready/Running/Monitoring and the graph cannot advance; None while runnable.
pub fn terminal(graph: &TaskGraph) -> Option<GraphStatus> {
    if graph.nodes.iter().all(|n| n.status == NodeStatus::Passed) {
        return Some(GraphStatus::Complete);
    }
    let active = graph
        .nodes
        .iter()
        .any(|n| matches!(n.status, NodeStatus::Running | NodeStatus::Monitoring));
    if !active && ready_nodes(graph).is_empty() {
        return Some(GraphStatus::Blocked);
    }
    None
}

/// Return attempts that were persisted as active by a previous core process
/// to the scheduler. The caller must hold GraphManager's per-graph run slot:
/// that is the proof these nodes are stale rather than live work in this
/// process. Attempts remain consumed, so repeated crashes still reach the
/// normal cap instead of granting unlimited retries.
fn recover_stale_attempts(graph: &mut TaskGraph) -> Vec<String> {
    let mut recovered = Vec::new();
    for node in &mut graph.nodes {
        let stale_status = match node.status {
            NodeStatus::Running => "running",
            NodeStatus::Monitoring => "monitoring",
            _ => continue,
        };
        let note = format!(
            "Recovered after the core stopped while attempt {} was {stale_status}; retry and re-verify this node.",
            node.attempts
        );
        if !node.punch_list.iter().any(|item| item == &note) {
            node.punch_list.push(note);
        }
        node.status = if node.attempts >= MAX_ATTEMPTS_PER_NODE {
            NodeStatus::Failed
        } else {
            NodeStatus::Rejected
        };
        node.score = None;
        node.session_id = None;
        node.evidence_paths.clear();
        node.evidence_count = 0;
        node.evidence_attempt = None;
        recovered.push(node.id.clone());
    }
    recovered
}

/// Rehydrate persisted Build contact sheets after a process restart. The
/// graph stores only safe project-relative paths; transient data URLs are
/// rebuilt in memory so a resumed judge still reviews the latest accepted
/// pixels instead of silently falling back to text-only evidence.
fn restore_latest_sheets(state: &AppState, graph: &TaskGraph) -> HashMap<String, String> {
    let Some(project_slug) = graph.project_slug.as_deref() else {
        return HashMap::new();
    };
    let Ok(project_dir) = crate::store::project_dir(&state.projects_root, project_slug) else {
        return HashMap::new();
    };
    let mut sheets = HashMap::new();
    let mut retained_bytes = 0usize;
    for node in &graph.nodes {
        if node.kind != NodeKind::Build || node.evidence_count == 0 {
            continue;
        }
        let Some(relative) = node
            .evidence_paths
            .iter()
            .find(|path| path.ends_with(".png"))
        else {
            continue;
        };
        let relative_path = Path::new(relative);
        if relative_path.is_absolute()
            || !relative_path
                .components()
                .all(|component| matches!(component, Component::Normal(_)))
        {
            continue;
        }
        let path = project_dir.join(relative_path);
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        let canonical_project_dir = project_dir.canonicalize().unwrap_or(project_dir.clone());
        if !canonical.starts_with(&canonical_project_dir) {
            continue;
        }
        let Ok(bytes) = std::fs::read(canonical) else {
            continue;
        };
        if bytes.len() > crate::video_analysis::MAX_PNG_BYTES
            || retained_bytes.saturating_add(bytes.len()) > MAX_CAPTURE_DATA_URL_TOTAL_BYTES
            || image::load_from_memory(&bytes).is_err()
        {
            continue;
        }
        retained_bytes = retained_bytes.saturating_add(bytes.len());
        sheets.insert(
            node.id.clone(),
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
        );
    }
    sheets
}

// ---------------------------------------------------------------------------
// Persistence (~/.cali/graphs/)
// ---------------------------------------------------------------------------

/// Graphs live alongside sessions under `~/.cali/graphs` (sessions_root is
/// `~/.cali/sessions`, mirroring how main.rs derives sessions_root itself).
pub fn graphs_root(sessions_root: &Path) -> PathBuf {
    sessions_root
        .parent()
        .map(|parent| parent.join("graphs"))
        .unwrap_or_else(|| sessions_root.join("graphs"))
}

fn graph_file(root: &Path, graph_id: &str) -> Result<PathBuf> {
    Ok(root.join(format!("{}.json", clean_graph_id(graph_id)?)))
}

/// Atomic write: tmp file + rename, so a crash mid-write can't leave a
/// truncated graph that fails to parse.
pub fn save(root: &Path, graph: &TaskGraph) -> Result<()> {
    std::fs::create_dir_all(root)?;
    let path = graph_file(root, &graph.graph_id)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(graph)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

pub fn load(root: &Path, graph_id: &str) -> Result<TaskGraph> {
    let path = graph_file(root, graph_id)?;
    let text =
        std::fs::read_to_string(&path).with_context(|| format!("graph {graph_id} not found"))?;
    Ok(serde_json::from_str(&text)?)
}

fn summary(graph: &TaskGraph) -> Value {
    let count = |status: NodeStatus| graph.nodes.iter().filter(|n| n.status == status).count();
    json!({
        "graphId": graph.graph_id,
        "goal": graph.goal,
        "template": graph.template,
        "projectSlug": graph.project_slug,
        "status": graph.status,
        "nodeCounts": {
            "passed": count(NodeStatus::Passed),
            "running": count(NodeStatus::Running) + count(NodeStatus::Monitoring),
            "failed": count(NodeStatus::Failed),
            "total": graph.nodes.len(),
        },
        "updatedAt": graph.updated_at,
    })
}

/// Graph summaries, newest first, optionally filtered by project slug.
pub fn list(root: &Path, slug: Option<&str>) -> Result<Vec<Value>> {
    let mut items: Vec<(String, Value)> = Vec::new();
    if root.exists() {
        for entry in std::fs::read_dir(root)? {
            let path = entry?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Some(graph) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_json::from_str::<TaskGraph>(&text).ok())
            else {
                continue;
            };
            if let Some(want) = slug {
                if graph.project_slug.as_deref() != Some(want) {
                    continue;
                }
            }
            items.push((graph.updated_at.clone(), summary(&graph)));
        }
    }
    // RFC3339 sorts lexicographically; newest first.
    items.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(items.into_iter().map(|(_, value)| value).collect())
}

/// Idempotent delete.
#[allow(dead_code)] // graph deletion RPC is a planned follow-up; kept as public persistence API
pub fn delete(root: &Path, graph_id: &str) -> Result<()> {
    let path = graph_file(root, graph_id)?;
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const BUILTIN_TEMPLATES: &[(&str, &str)] = &[
    ("aaa-fps", include_str!("../templates/aaa-fps.json")),
    (
        "arcade-racer",
        include_str!("../templates/arcade-racer.json"),
    ),
    ("cozy-sim", include_str!("../templates/cozy-sim.json")),
    (
        "polished-asset",
        include_str!("../templates/polished-asset.json"),
    ),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateNode {
    pub id: String,
    pub title: String,
    pub kind: NodeKind,
    pub role: String,
    pub instructions: String,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub threshold: Option<u32>,
    #[serde(default = "default_node_turns")]
    pub max_turns: usize,
    #[serde(default)]
    pub deps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub default_threshold: Option<u32>,
    pub nodes: Vec<TemplateNode>,
}

/// User template overrides live alongside graphs: `~/.cali/templates/`.
pub fn templates_root(sessions_root: &Path) -> PathBuf {
    sessions_root
        .parent()
        .map(|parent| parent.join("templates"))
        .unwrap_or_else(|| sessions_root.join("templates"))
}

/// Disk override at `~/.cali/templates/<id>.json` wins over the builtin.
pub fn load_template(sessions_root: &Path, id: &str) -> Result<GraphTemplate> {
    let clean = clean_graph_id(id)?;
    let disk = templates_root(sessions_root).join(format!("{clean}.json"));
    if let Ok(text) = std::fs::read_to_string(&disk) {
        return serde_json::from_str(&text)
            .with_context(|| format!("template override {} is invalid", disk.display()));
    }
    if let Some((_, text)) = BUILTIN_TEMPLATES.iter().find(|(known, _)| *known == clean) {
        return Ok(serde_json::from_str(text).expect("builtin template parses"));
    }
    let known: Vec<&str> = BUILTIN_TEMPLATES.iter().map(|(known, _)| *known).collect();
    anyhow::bail!("unknown template '{}'; available: {}", id, known.join(", "))
}

/// {id, name, description, nodeCount} for every template — builtins plus any
/// disk templates, with disk winning on id collisions.
pub fn list_templates(sessions_root: &Path) -> Vec<Value> {
    let mut by_id: HashMap<String, Value> = HashMap::new();
    for (id, text) in BUILTIN_TEMPLATES {
        if let Ok(template) = serde_json::from_str::<GraphTemplate>(text) {
            by_id.insert(
                (*id).to_string(),
                json!({
                    "id": template.id,
                    "name": template.name,
                    "description": template.description,
                    "nodeCount": template.nodes.len(),
                }),
            );
        }
    }
    let disk = templates_root(sessions_root);
    if let Ok(entries) = std::fs::read_dir(&disk) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            if let Some(template) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_json::from_str::<GraphTemplate>(&text).ok())
            {
                by_id.insert(
                    template.id.clone(),
                    json!({
                        "id": template.id,
                        "name": template.name,
                        "description": template.description,
                        "nodeCount": template.nodes.len(),
                    }),
                );
            }
        }
    }
    let mut items: Vec<Value> = by_id.into_values().collect();
    items.sort_by(|a, b| {
        a["id"]
            .as_str()
            .unwrap_or("")
            .cmp(b["id"].as_str().unwrap_or(""))
    });
    items
}

fn interpolate(text: &str, goal: &str, slug: &str) -> String {
    text.replace("{{goal}}", goal).replace("{{slug}}", slug)
}

fn node_from_template(
    node: &TemplateNode,
    goal: &str,
    slug: &str,
    default_threshold: Option<u32>,
) -> GraphNode {
    GraphNode {
        id: node.id.clone(),
        title: interpolate(&node.title, goal, slug),
        kind: node.kind,
        role: node.role.clone(),
        instructions: interpolate(&node.instructions, goal, slug),
        acceptance: node
            .acceptance
            .iter()
            .map(|criterion| interpolate(criterion, goal, slug))
            .collect(),
        reference: node
            .reference
            .as_deref()
            .map(|reference| interpolate(reference, goal, slug)),
        threshold: node.threshold.or(if node.kind == NodeKind::Judge {
            default_threshold
        } else {
            None
        }),
        max_turns: node.max_turns,
        deps: node.deps.clone(),
        status: NodeStatus::Pending,
        attempts: 0,
        score: None,
        punch_list: Vec::new(),
        last_report: None,
        session_id: None,
        evidence_paths: Vec::new(),
        evidence_count: 0,
        evidence_attempt: None,
    }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/// Build a TaskGraph either from an explicit node list (top agent authored)
/// or by instantiating a template with {{goal}}/{{slug}} interpolation.
/// Always validates; always appends a terminal Judge node when the plan has
/// none — the loop MUST end at a judge, that is the product requirement.
pub fn plan(
    sessions_root: &Path,
    goal: &str,
    project_slug: Option<&str>,
    template_id: Option<&str>,
    explicit_nodes: Option<&Value>,
    owner_session: Option<&str>,
    workspace_root: Option<&str>,
) -> Result<TaskGraph> {
    plan_with_effort(
        sessions_root,
        goal,
        project_slug,
        template_id,
        explicit_nodes,
        owner_session,
        workspace_root,
        None,
    )
}

/// Build a TaskGraph while retaining the coordinator's request-scoped
/// reasoning effort for every worker, monitor, and judge in the run.
#[allow(clippy::too_many_arguments)]
pub fn plan_with_effort(
    sessions_root: &Path,
    goal: &str,
    project_slug: Option<&str>,
    template_id: Option<&str>,
    explicit_nodes: Option<&Value>,
    owner_session: Option<&str>,
    workspace_root: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Result<TaskGraph> {
    let goal = goal.trim();
    if goal.is_empty() {
        anyhow::bail!("goal must not be empty");
    }
    let reasoning_effort = match reasoning_effort {
        None => None,
        Some(value) => {
            let value = value.trim();
            if value.is_empty() {
                anyhow::bail!("reasoningEffort must not be empty");
            }
            if value.len() > 32 {
                anyhow::bail!("reasoningEffort must be at most 32 characters");
            }
            Some(value.to_string())
        }
    };
    let slug = project_slug.unwrap_or("");
    let mut nodes: Vec<GraphNode> = match (template_id, explicit_nodes) {
        (Some(template_id), _) => {
            let template = load_template(sessions_root, template_id)?;
            template
                .nodes
                .iter()
                .map(|node| node_from_template(node, goal, slug, template.default_threshold))
                .collect()
        }
        (None, Some(value)) => {
            let normalized = normalize_provider_nodes(value.clone());
            validate_provider_node_shapes(&normalized)?;
            let mut nodes: Vec<GraphNode> = match serde_json::from_value(normalized.clone()) {
                Ok(nodes) => nodes,
                Err(err) => {
                    anyhow::bail!(
                        "graph_plan.nodes rejected: {}",
                        format_provider_nodes_error(&normalized, &err)
                    );
                }
            };
            // Runtime state is engine-owned; never trust it from a planner.
            for node in &mut nodes {
                node.status = NodeStatus::Pending;
                node.attempts = 0;
                node.score = None;
                node.punch_list.clear();
                node.last_report = None;
                node.session_id = None;
                node.evidence_paths.clear();
                node.evidence_count = 0;
                node.evidence_attempt = None;
            }
            nodes
        }
        (None, None) => {
            anyhow::bail!("provide either template (see template_list) or nodes to graph_plan")
        }
    };

    if let Some(error) = runtime_material_acceptance_error(&nodes) {
        anyhow::bail!(error);
    }

    if !nodes.iter().any(|node| node.kind == NodeKind::Judge) {
        // Terminal judge over every sink build node.
        let depended: HashSet<&str> = nodes
            .iter()
            .flat_map(|node| node.deps.iter().map(String::as_str))
            .collect();
        let mut sinks: Vec<String> = nodes
            .iter()
            .filter(|node| node.kind == NodeKind::Build && !depended.contains(node.id.as_str()))
            .map(|node| node.id.clone())
            .collect();
        if sinks.is_empty() {
            sinks = nodes.iter().map(|node| node.id.clone()).collect();
        }
        let mut judge_id = "judge".to_string();
        while nodes.iter().any(|node| node.id == judge_id) {
            judge_id = format!("{judge_id}-final");
        }
        nodes.push(GraphNode {
            id: judge_id,
            title: "Final verdict".into(),
            kind: NodeKind::Judge,
            role: "critic".into(),
            instructions: format!(
                "Score the overall result of: {goal}. Inspect the live project yourself and \
                 judge completeness, correctness, and polish."
            ),
            acceptance: vec![
                "the goal is demonstrably achieved in the live project".into(),
                "no errors when the result is run or inspected".into(),
            ],
            reference: Some(format!("a shipped, AAA-quality result for: {goal}")),
            threshold: Some(DEFAULT_JUDGE_THRESHOLD),
            max_turns: 6,
            deps: sinks,
            status: NodeStatus::Pending,
            attempts: 0,
            score: None,
            punch_list: Vec::new(),
            last_report: None,
            session_id: None,
            evidence_paths: Vec::new(),
            evidence_count: 0,
            evidence_attempt: None,
        });
    }
    normalize_node_turn_budgets(&mut nodes);

    let now = now_rfc3339();
    let graph = TaskGraph {
        schema_version: GRAPH_SCHEMA_VERSION,
        graph_id: format!("graph-{}", short_id()),
        goal: goal.to_string(),
        template: template_id.map(str::to_string),
        project_slug: project_slug.map(str::to_string),
        nodes,
        status: GraphStatus::Planning,
        created_at: now.clone(),
        updated_at: now,
        owner_session: owner_session.map(str::to_string),
        workspace_root: workspace_root.map(str::to_string),
        reasoning_effort,
    };
    validate(&graph)?;
    Ok(graph)
}

// ---------------------------------------------------------------------------
// GraphManager
// ---------------------------------------------------------------------------

/// graph_id -> cancel flag for in-flight runs. The engine checks the flag
/// between nodes and between attempts; subagent turns themselves are not
/// interruptible (same limitation as subagent_spawn today).
#[derive(Clone, Default)]
pub struct GraphManager {
    running: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl GraphManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a run; bails when the graph is already running.
    pub async fn begin(&self, graph_id: &str) -> Result<Arc<AtomicBool>> {
        let mut guard = self.running.lock().await;
        if guard.contains_key(graph_id) {
            anyhow::bail!("graph {} is already running", graph_id);
        }
        let flag = Arc::new(AtomicBool::new(false));
        guard.insert(graph_id.to_string(), flag.clone());
        Ok(flag)
    }

    pub async fn end(&self, graph_id: &str) {
        self.running.lock().await.remove(graph_id);
    }

    /// True when the graph was running (its flag is now raised).
    pub async fn cancel(&self, graph_id: &str) -> bool {
        match self.running.lock().await.get(graph_id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    pub async fn is_running(&self, graph_id: &str) -> bool {
        self.running.lock().await.contains_key(graph_id)
    }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct MonitorVerdict {
    pub pass: bool,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct JudgeVerdict {
    pub score: u32,
    #[serde(default, alias = "punchList")]
    pub punch_list: Vec<String>,
    #[serde(default)]
    pub summary: String,
}

/// Emit a bus event and re-save the graph. `phase` is one of
/// created|recovered|node_started|node_monitor|node_passed|node_rejected|
/// judge_verdict|completed|blocked|cancelled. Every event carries the full graph snapshot so
/// the client render is a pure function of the last payload.
fn broadcast(
    state: &AppState,
    root: &Path,
    graph: &mut TaskGraph,
    phase: &str,
    node_id: Option<&str>,
    extra: Value,
) {
    graph.updated_at = now_rfc3339();
    if let Err(error) = save(root, graph) {
        tracing::warn!(%error, graph = %graph.graph_id, "graph save failed");
    }
    let _ = state.bus.send(json!({
        "type": "graph.updated",
        "graphId": graph.graph_id,
        "phase": phase,
        "nodeId": node_id,
        "extra": extra,
        "graph": serde_json::to_value(&*graph).unwrap_or(Value::Null),
    }));
}

fn node_index(graph: &TaskGraph, node_id: &str) -> Option<usize> {
    graph.nodes.iter().position(|node| node.id == node_id)
}

/// Resolve graph routing from the durable owner record, never from the
/// mutable project default or from caller-provided spawn arguments.
///
/// Older saved graphs have neither field and remain readable, but cannot run:
/// letting an unbound or partially-bound graph execute would route browser
/// tools to whichever editor happened to be open while file tools wrote
/// somewhere else.
fn validate_binding(state: &AppState, graph: &mut TaskGraph) -> Result<()> {
    let owner = graph.owner_session.clone();
    let requested_root = graph.workspace_root.clone();
    match (owner.as_deref(), requested_root.as_deref()) {
        (None, None) => anyhow::bail!("graph requires an owner session and workspace binding"),
        (None, Some(_)) => anyhow::bail!("graph workspace requires an owner session"),
        (Some(_), None) => anyhow::bail!("graph owner session has no workspace binding"),
        (Some(owner), Some(requested_root)) => {
            let record = crate::sessions::load(&state.sessions_root, owner)
                .with_context(|| format!("graph owner session {owner} is unavailable"))?;
            let saved_root = record
                .get("workspaceRoot")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|root| !root.is_empty())
                .context("graph owner session has no workspace binding")?;
            let saved_slug = record.get("projectSlug").and_then(Value::as_str);
            if graph
                .project_slug
                .as_deref()
                .is_some_and(|slug| saved_slug != Some(slug))
            {
                anyhow::bail!("graph owner session belongs to a different project");
            }
            if graph.project_slug.is_none() {
                graph.project_slug = saved_slug.map(str::to_string);
            }
            if !crate::editor_bridge::same_path(saved_root, requested_root) {
                anyhow::bail!("graph workspace does not match its owner session");
            }
            let canonical = Path::new(saved_root).canonicalize().with_context(|| {
                format!(
                    "graph workspace {} is unavailable",
                    Path::new(saved_root).display()
                )
            })?;
            if !canonical.is_dir() {
                anyhow::bail!("graph workspace {} is not a directory", canonical.display());
            }
            graph.workspace_root = Some(canonical.to_string_lossy().into_owned());
            Ok(())
        }
    }
}

async fn reserve_attempt_session(
    state: &AppState,
    root: &Path,
    graph: &mut TaskGraph,
    index: usize,
) -> Result<String> {
    let session_id = state.agents.reserve_session().await?;
    graph.nodes[index].session_id = Some(session_id.clone());
    save(root, graph).context("persisting reserved graph session")?;
    Ok(session_id)
}

async fn spawn_bound_attempt(
    state: &AppState,
    graph: &TaskGraph,
    args: &Value,
    session_id: &str,
) -> Result<Value> {
    let result = match graph.reasoning_effort.as_deref() {
        Some(reasoning_effort) => {
            crate::tools::spawn_graph_subagent_with_effort(
                state,
                args,
                session_id,
                &graph.graph_id,
                graph.owner_session.as_deref(),
                graph.workspace_root.as_deref(),
                Some(reasoning_effort),
            )
            .await?
        }
        None => {
            crate::tools::spawn_graph_subagent(
                state,
                args,
                session_id,
                &graph.graph_id,
                graph.owner_session.as_deref(),
                graph.workspace_root.as_deref(),
            )
            .await?
        }
    };
    if result["sessionId"].as_str() != Some(session_id) {
        anyhow::bail!("graph subagent returned a different session than its reserved session");
    }
    Ok(result)
}

/// Compact "Project: ..." line for worker prompts; empty when the project is
/// missing or unset.
fn project_line(state: &AppState, slug: Option<&str>) -> String {
    let Some(slug) = slug else {
        return String::new();
    };
    let Ok(project) = crate::store::read_project(&state.projects_root, slug) else {
        return String::new();
    };
    let count = |key: &str| {
        project
            .get(key)
            .and_then(Value::as_array)
            .map(|items| items.len())
            .unwrap_or(0)
    };
    format!(
        "\n\nProject: {} — {} entities, {} assets, {} tests.",
        slug,
        count("entities"),
        count("assets"),
        count("tests")
    )
}

fn bullet_list(items: &[String]) -> String {
    items
        .iter()
        .map(|item| format!("- {item}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn node_system_prompt(node: &GraphNode) -> String {
    format!(
        "{intro}\n\n{live}\n\n{capture}\n\n{ids}\n\n{visuals}\n\n{scripts}\n\n{tests}\n\n{budget}\n\n{retry}",
        intro = node_system_prompt_intro(node),
        live = live_project_vs_worktree_paragraph(),
        capture = capture_persistence_contract_paragraph(),
        ids = stable_id_contract_paragraph(),
        visuals = procedural_visual_contract_paragraph(),
        scripts = script_runtime_contract_paragraph(),
        tests = test_runtime_contract_paragraph(),
        budget = turn_budget_paragraph(),
        retry = retry_reuse_paragraph(),
    )
}

/// Role + title; reminds the worker the monitor grades on evidence.
fn node_system_prompt_intro(node: &GraphNode) -> String {
    format!(
        "You are a {role} subagent inside CaliCode's graph engine, executing one node of a \
         task graph: \"{title}\". Do the work, verify it yourself, and finish with a concise \
         report backed by concrete evidence (files written, entities created, tests passing, \
         frames captured) — an automatic monitor rejects claims without evidence.",
        role = node.role,
        title = node.title,
    )
}

/// Locks the live-project contract: only editor_* calls reach the editor;
/// the session worktree is a disposable git checkout and editing the
/// CaliCode client or core source from it cannot affect the running editor.
fn live_project_vs_worktree_paragraph() -> String {
    "LIVE PROJECT VS. SESSION WORKTREE: mutate the live project through the editor_* tools — \
     editor_object_add, editor_object_update, editor_script_write, editor_test_add, \
     editor_camera_frame, editor_run_pie, editor_run_tests, editor_capture_frame, editor_scene_inspect, \
     editor_asset_builder_*, editor_promote_asset, editor_persist_capture, \
     editor_console_log, editor_console_history, editor_analyze_motion. Those calls flow into \
     the running editor and persist automatically. The session worktree you were given is a \
     disposable git checkout for your file sandbox; it CANNOT affect the running editor, so \
     do not write the project's source there, do not edit the CaliCode client or core source \
     from it, and do not try to \"save\" the project by hand — the project state the user sees \
     is what the editor_* tools have already written."
        .to_string()
}

/// Mirrors the main agent's client change: pass `id` to upsert, omit to
/// upsert by name. Without it, every retry duplicates the script and the
/// monitor rejects.
fn stable_id_contract_paragraph() -> String {
    "STABLE-ID TOOL CONTRACT: editor_script_write accepts an optional `id` — pass `id` to \
     create or update a script under that stable id; omit `id` to upsert by name. \
     editor_test_add follows the same stable-id pattern. editor_object_update requires the \
     entity `id` you got from the editor_object_add result or editor_scene_inspect. Use the \
     same id on retries so the call updates in place instead of leaving duplicates the \
     monitor will reject; capture the new ids in your report."
        .to_string()
}

fn procedural_visual_contract_paragraph() -> String {
    "PROCEDURAL VISUAL CONTRACT: for a thin floor/grid overlay, keep the entity `kind: plane` \
     and set `material.pattern: \"grid\"` with optional finite `gridCellSize`, \
     `gridDivisions`, and `gridLineWidth`. Its normal `color`, `emissive`, and \
     `emissiveIntensity` control the grid lines. Do not fake a grid with a large bright opaque \
     plane: it washes out the arena and hides gameplay. Use a separate dark base plane when a \
     solid floor is required."
        .to_string()
}

fn script_runtime_contract_paragraph() -> String {
    "SCRIPT RUNTIME CONTRACT: write `function update(entity, state, delta) { ... }`. `entity` \
     is the only live entity the script may mutate directly. `state.time` is deterministic simulation \
     time, `state.entities` is the legacy list of names, `state.scene` is a read-only array of \
     deeply frozen plain entity snapshots, and `state.find(nameOrId)` finds one frozen snapshot. \
     Never assign through those snapshots. For another entity's transform use \
     `state.patch(nameOrId, { position?, rotation?, scale? })`; it returns true when at least one \
     supplied finite component was accepted, merges partial `{x?,y?,z?}` vectors, and preserves \
     omitted components. Only transforms are patchable; invalid fields are ignored and logged. \
     Runtime material mutation does not exist, so use static `editor_object_update` material \
     changes before PIE or give each moving entity its own script. Persist private \
     JSON-safe data in `state.self`; coordinate scripts through shared JSON-safe `state.world`. \
     There are no global `scene` or `input` objects and no DOM, network, timers, or storage. \
     For an autonomous playtest, derive visible movement from `state.time` or bounded \
     `state.self` state, then verify motion across multiple PIE frames. Direct assignments to the \
     writable owner entity use full finite `{ x, y, z }` vectors; state.patch may merge finite \
     partial components."
        .to_string()
}

fn test_runtime_contract_paragraph() -> String {
    "TEST RUNTIME CONTRACT: editor_test_add scripts may read `scene`, `entityFor(name)`, and \
     read-only `state.world`; call `await step(frames)` to refresh both entity snapshots and \
     `state.world`. Assertions are asynchronous — always write \
     `await assert(condition, positiveExpectationMessage)`. Never use `|| true`, and never invert \
     the message into a failure claim (for example a true condition should say `Hero exists`). \
     Tests do not receive the script's `state.self`, DOM, network, timers, or storage."
        .to_string()
}

/// Locks down the three image/console tools so a worker cannot route
/// captured frames through `file_write` (which is UTF-8-only and would land
/// a base64 string instead of a real PNG), cannot mistake `editor_console_log`
/// for a read tool, and cannot skip the contact-sheet path that the
/// monitor grades on.
fn capture_persistence_contract_paragraph() -> String {
    "CAPTURE / PERSISTENCE CONTRACT: before collecting evidence, inspect the live scene and call \
     `editor_camera_frame` with the gameplay foreground entity ids and a target-to-camera view \
     direction chosen from the side opposite the backdrop. That exact authored pose persists across PIE, individual \
     captures, motion analysis, and reload; do not let decorative background geometry control the fit. \
     `editor_capture_frame` returns a transient `dataUrl`; \
     `editor_persist_capture` takes a project-relative path, captures the live PIE frame, and \
     writes a real PNG/JPEG atomically under the project tree — call it directly whenever you \
     want a single capture persisted at a path you can quote in a report. Do not call \
     `editor_capture_frame` first when you need an on-disk file, and do not copy its `dataUrl` \
     through model context. NEVER route a PNG or `dataUrl` payload through `file_write` or `file_edit`; \
     `file_write` is UTF-8-only and the on-disk result would not be a decodable image, and the \
     image validator the monitor runs will reject it. The returned `path`, `bytes`, `sha256`, \
     `frame`, and `timeMs` are engine results from the canonical project store. Do not try to \
     re-validate those project-relative paths with `file_read` or `file_glob`: file tools are \
     rooted in the disposable session worktree, where canonical captures do not exist. \
     `editor_analyze_motion` runs PIE, gathers \
     chronological captures, AND persists a labelled contact sheet + manifest under \
     `<project>/reports/video/`; its return value already lists the project-relative paths, \
     so treat its result as the authoritative per-frame evidence when you want a motion \
     review. `editor_console_log` only writes a line to the console — it never reads back; \
     if you need to verify what the runtime emitted, call `editor_console_history` instead."
        .to_string()
}

/// Reserve the last turns for the report plus the verification tools the
/// monitor and judge grade on; otherwise the "no final report" failure
/// mode kicks in.
fn turn_budget_paragraph() -> String {
    "TURN BUDGET: finish every required editor verification before optional duplicate checks, \
     then reserve the last 1-2 turns for the concise final report. Spend early turns on the \
     build, then on verification — editor_run_pie, editor_run_tests, editor_console_history, \
     and at least 3 \
     editor_persist_capture calls with distinct project-relative paths at distinct moments so \
     the monitor and judge receive real chronological image evidence, not a single transient \
     still. If an acceptance criterion cannot be met, say so in the report \
     instead of silently dropping it; claiming work you did not do will be rejected."
        .to_string()
}

/// On attempts > 1 the prior report is a hint, not a source of truth; the
/// worker must inspect the persisted project and skip landed work.
fn retry_reuse_paragraph() -> String {
    "ON RETRY (attempts > 1): the previous attempt's report is included in your instructions \
     as a hint, but it may be stale, partial, or wrong. Treat the persisted live project as \
     the source of truth — call editor_scene_inspect to confirm what already exists, then \
     only redo what is still missing or broken. Do not recreate entities, scripts, tests, \
     or assets the previous attempt already landed; redoing passed work is what burned the \
     earlier turn budget."
        .to_string()
}

/// One capture event retained by a node attempt. `finished_at_ms` orders
/// concurrent tool calls chronologically; `sequence` is the deterministic
/// tie-breaker for providers that finish several calls in the same millisecond
/// (or omit timing fields in a test/integration event).
#[derive(Debug, Clone)]
struct CapturedFrame {
    finished_at_ms: Option<u64>,
    sequence: u64,
    data_url: String,
}

/// One successful `editor_persist_capture` event retained by a node attempt.
/// Only bounded routing metadata is kept here. The byte count is consumed by
/// the aggregate admission cap and the digest is shape-checked when the event
/// arrives; the image itself is re-opened and decoded from the project store
/// before it can count as judge evidence.
#[derive(Debug, Clone)]
struct PersistedCaptureEntry {
    finished_at_ms: Option<u64>,
    sequence: u64,
    path: String,
}

#[derive(Debug, Clone)]
struct PendingToolAttestation {
    tool: String,
    arguments: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolAttestation {
    tool: String,
    arguments: Value,
    result: Value,
}

fn is_attested_editor_tool(tool: &str) -> bool {
    matches!(
        tool,
        "editor_scene_inspect"
            | "editor_object_add"
            | "editor_object_remove"
            | "editor_update_transform"
            | "editor_object_update"
            | "editor_script_write"
            | "editor_test_add"
            | "editor_asset_generate"
            | "editor_promote_asset"
            | "editor_asset_builder_apply"
            | "editor_asset_builder_save"
            | "editor_camera_frame"
            | "editor_run_pie"
            | "editor_run_tests"
            | "editor_persist_capture"
            | "editor_analyze_motion"
            | "editor_project_save"
            | "editor_console_history"
    )
}

fn bounded_string_value(value: Option<&Value>, limit: usize) -> Value {
    value
        .and_then(Value::as_str)
        .map(|value| Value::String(truncate_chars(value, limit)))
        .unwrap_or(Value::Null)
}

fn bounded_string_array(value: Option<&Value>) -> Value {
    Value::Array(
        value
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .take(MAX_ATTESTED_IDS)
            .map(|value| Value::String(truncate_chars(value, MAX_EVIDENCE_PATH_CHARS)))
            .collect(),
    )
}

fn bounded_scalar_object(value: Option<&Value>) -> Value {
    let Some(object) = value.and_then(Value::as_object) else {
        return Value::Null;
    };
    Value::Object(
        object
            .iter()
            .take(MAX_ATTESTED_IDS)
            .filter_map(|(key, value)| {
                let value = match value {
                    Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
                    Value::String(value) => {
                        Value::String(truncate_chars(value, MAX_EVIDENCE_PATH_CHARS))
                    }
                    Value::Array(values)
                        if values.len() <= 4
                            && values.iter().all(|value| {
                                matches!(value, Value::Null | Value::Bool(_) | Value::Number(_))
                            }) =>
                    {
                        Value::Array(values.clone())
                    }
                    _ => return None,
                };
                Some((truncate_chars(key, 128), value))
            })
            .collect(),
    )
}

fn bounded_named_items(value: Option<&Value>, item_kind: &str) -> Value {
    Value::Array(
        value
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_ATTESTED_SCENE_ITEMS)
            .filter_map(|item| {
                let id = item.get("id").and_then(Value::as_str)?;
                let name = item.get("name").and_then(Value::as_str)?;
                let mut summary = serde_json::Map::from_iter([
                    (
                        "id".to_string(),
                        Value::String(truncate_chars(id, MAX_EVIDENCE_PATH_CHARS)),
                    ),
                    (
                        "name".to_string(),
                        Value::String(truncate_chars(name, MAX_EVIDENCE_PATH_CHARS)),
                    ),
                ]);
                if item_kind == "entity" {
                    summary.insert(
                        "kind".to_string(),
                        bounded_string_value(item.get("kind"), 64),
                    );
                    for field in ["position", "rotation", "scale"] {
                        summary.insert(
                            field.to_string(),
                            item.get(field).cloned().unwrap_or(Value::Null),
                        );
                    }
                    summary.insert(
                        "material".to_string(),
                        bounded_scalar_object(item.get("material")),
                    );
                    summary.insert(
                        "light".to_string(),
                        bounded_scalar_object(item.get("light")),
                    );
                    summary.insert(
                        "scriptIds".to_string(),
                        bounded_string_array(item.get("scriptIds")),
                    );
                    summary.insert(
                        "assetId".to_string(),
                        bounded_string_value(item.get("assetId"), MAX_EVIDENCE_PATH_CHARS),
                    );
                } else if item_kind == "asset" {
                    summary.insert(
                        "type".to_string(),
                        bounded_string_value(item.get("type"), 64),
                    );
                    summary.insert(
                        "source".to_string(),
                        bounded_string_value(item.get("source"), MAX_EVIDENCE_PATH_CHARS),
                    );
                }
                Some(Value::Object(summary))
            })
            .collect(),
    )
}

fn summarize_tool_arguments(tool: &str, arguments: &Value) -> Value {
    match tool {
        "editor_scene_inspect" => json!({}),
        "editor_object_add" => json!({
            "name": bounded_string_value(arguments.get("name"), MAX_EVIDENCE_PATH_CHARS),
            "kind": bounded_string_value(arguments.get("kind"), 64),
            "position": arguments.get("position").cloned().unwrap_or(Value::Null),
            "color": bounded_string_value(arguments.get("color"), 128),
        }),
        "editor_object_remove" => json!({
            "id": bounded_string_value(arguments.get("id"), MAX_EVIDENCE_PATH_CHARS),
        }),
        "editor_update_transform" => json!({
            "id": bounded_string_value(arguments.get("id"), MAX_EVIDENCE_PATH_CHARS),
            "position": arguments.get("position").cloned().unwrap_or(Value::Null),
            "rotation": arguments.get("rotation").cloned().unwrap_or(Value::Null),
            "scale": arguments.get("scale").cloned().unwrap_or(Value::Null),
        }),
        "editor_object_update" => json!({
            "id": bounded_string_value(arguments.get("id"), MAX_EVIDENCE_PATH_CHARS),
            "name": bounded_string_value(arguments.get("name"), MAX_EVIDENCE_PATH_CHARS),
            "kind": bounded_string_value(arguments.get("kind"), 64),
            "position": arguments.get("position").cloned().unwrap_or(Value::Null),
            "rotation": arguments.get("rotation").cloned().unwrap_or(Value::Null),
            "scale": arguments.get("scale").cloned().unwrap_or(Value::Null),
            "material": bounded_scalar_object(arguments.get("material")),
            "light": bounded_scalar_object(arguments.get("light")),
            "scriptIds": bounded_string_array(arguments.get("scriptIds")),
            "assetId": bounded_string_value(arguments.get("assetId"), MAX_EVIDENCE_PATH_CHARS),
        }),
        "editor_script_write" => json!({
            "id": bounded_string_value(arguments.get("id"), MAX_EVIDENCE_PATH_CHARS),
            "name": bounded_string_value(arguments.get("name"), MAX_EVIDENCE_PATH_CHARS),
            "code": bounded_string_value(arguments.get("code"), MAX_ATTESTED_SOURCE_CHARS),
        }),
        "editor_test_add" => json!({
            "id": bounded_string_value(arguments.get("id"), MAX_EVIDENCE_PATH_CHARS),
            "name": bounded_string_value(arguments.get("name"), MAX_EVIDENCE_PATH_CHARS),
            "script": bounded_string_value(arguments.get("script"), MAX_ATTESTED_SOURCE_CHARS),
        }),
        "editor_asset_generate" => json!({
            "name": bounded_string_value(arguments.get("name"), MAX_EVIDENCE_PATH_CHARS),
            "kind": bounded_string_value(arguments.get("kind"), 64),
            "color": bounded_string_value(arguments.get("color"), 128),
            "metalness": arguments.get("metalness").cloned().unwrap_or(Value::Null),
            "roughness": arguments.get("roughness").cloned().unwrap_or(Value::Null),
        }),
        "editor_promote_asset" | "editor_asset_builder_save" => json!({
            "assetId": bounded_string_value(arguments.get("id").or_else(|| arguments.get("assetId")), MAX_EVIDENCE_PATH_CHARS),
        }),
        "editor_asset_builder_apply" => json!({
            "assetId": bounded_string_value(arguments.get("assetId"), MAX_EVIDENCE_PATH_CHARS),
            "ops": arguments.get("ops").and_then(Value::as_array).map(|ops| {
                Value::Array(ops.iter().take(MAX_ATTESTED_IDS).map(|op| json!({
                    "op": bounded_string_value(op.get("op"), 64),
                    "id": bounded_string_value(op.get("id"), MAX_EVIDENCE_PATH_CHARS),
                    "name": bounded_string_value(op.get("name"), MAX_EVIDENCE_PATH_CHARS),
                    "componentId": bounded_string_value(op.get("componentId"), MAX_EVIDENCE_PATH_CHARS),
                    "materialId": bounded_string_value(op.get("materialId"), MAX_EVIDENCE_PATH_CHARS),
                })).collect())
            }).unwrap_or(Value::Null),
        }),
        "editor_camera_frame" => json!({
            "entityIds": bounded_string_array(arguments.get("entityIds")),
            "excludeEntityIds": bounded_string_array(arguments.get("excludeEntityIds")),
            "viewDirection": arguments.get("viewDirection").cloned().unwrap_or(Value::Null),
            "padding": arguments.get("padding").cloned().unwrap_or(Value::Null),
            "reset": arguments.get("reset").cloned().unwrap_or(Value::Null),
        }),
        "editor_run_pie" => json!({
            "frames": arguments.get("frames").cloned().unwrap_or(Value::Null),
        }),
        "editor_persist_capture" => json!({
            "path": bounded_string_value(arguments.get("path"), MAX_EVIDENCE_PATH_CHARS),
        }),
        "editor_analyze_motion" => json!({
            "label": bounded_string_value(arguments.get("label"), MAX_EVIDENCE_PATH_CHARS),
            "frames": arguments.get("frames").cloned().unwrap_or(Value::Null),
            "maxCaptures": arguments.get("maxCaptures").cloned().unwrap_or(Value::Null),
        }),
        "editor_console_history" => json!({
            "level": bounded_string_value(arguments.get("level"), 16),
            "limit": arguments.get("limit").cloned().unwrap_or(Value::Null),
        }),
        "editor_run_tests" | "editor_project_save" => json!({}),
        _ => Value::Null,
    }
}

fn summarize_tool_result(tool: &str, result: &Value) -> Value {
    if let Some(error) = result.get("error").and_then(Value::as_str) {
        return json!({
            "ok": false,
            "error": truncate_chars(error, MAX_ATTESTED_ERROR_CHARS),
        });
    }
    match tool {
        "editor_scene_inspect" => {
            let Some(project) = result.get("project").and_then(Value::as_object) else {
                return json!({ "ok": false, "error": "unexpected result shape" });
            };
            let arrays_valid = ["entities", "scripts", "assets", "tests"]
                .iter()
                .all(|field| project.get(*field).and_then(Value::as_array).is_some());
            json!({
                "ok": arrays_valid,
                "slug": bounded_string_value(project.get("slug"), MAX_EVIDENCE_PATH_CHARS),
                "title": bounded_string_value(project.get("title"), MAX_EVIDENCE_PATH_CHARS),
                "entityCount": project.get("entities").and_then(Value::as_array).map(Vec::len),
                "scriptCount": project.get("scripts").and_then(Value::as_array).map(Vec::len),
                "assetCount": project.get("assets").and_then(Value::as_array).map(Vec::len),
                "testCount": project.get("tests").and_then(Value::as_array).map(Vec::len),
                "entities": bounded_named_items(project.get("entities"), "entity"),
                "scripts": bounded_named_items(project.get("scripts"), "script"),
                "assets": bounded_named_items(project.get("assets"), "asset"),
                "tests": bounded_named_items(project.get("tests"), "test"),
            })
        }
        "editor_object_add" => json!({
            "ok": result.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty())
                && result.get("name").and_then(Value::as_str).is_some()
                && result.get("kind").and_then(Value::as_str).is_some(),
            "id": bounded_string_value(result.get("id"), MAX_EVIDENCE_PATH_CHARS),
            "name": bounded_string_value(result.get("name"), MAX_EVIDENCE_PATH_CHARS),
            "kind": bounded_string_value(result.get("kind"), 64),
        }),
        "editor_object_remove" => json!({
            "ok": result.get("removed").and_then(Value::as_str).is_some_and(|id| !id.is_empty()),
            "removed": bounded_string_value(result.get("removed"), MAX_EVIDENCE_PATH_CHARS),
        }),
        "editor_update_transform" | "editor_object_update" => json!({
            "ok": result.get("updated").and_then(Value::as_str).is_some_and(|id| !id.is_empty()),
            "updated": bounded_string_value(result.get("updated"), MAX_EVIDENCE_PATH_CHARS),
        }),
        "editor_script_write" | "editor_test_add" => json!({
            "ok": result.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty())
                && result.get("saved").and_then(Value::as_str).is_some()
                && result.get("created").and_then(Value::as_bool).is_some(),
            "id": bounded_string_value(result.get("id"), MAX_EVIDENCE_PATH_CHARS),
            "saved": bounded_string_value(result.get("saved"), MAX_EVIDENCE_PATH_CHARS),
            "created": result.get("created").cloned().unwrap_or(Value::Null),
        }),
        "editor_asset_generate" => json!({
            "ok": result.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty())
                && result.get("name").and_then(Value::as_str).is_some()
                && result.get("type").and_then(Value::as_str).is_some(),
            "id": bounded_string_value(result.get("id"), MAX_EVIDENCE_PATH_CHARS),
            "name": bounded_string_value(result.get("name"), MAX_EVIDENCE_PATH_CHARS),
            "type": bounded_string_value(result.get("type"), 64),
            "source": bounded_string_value(result.get("source"), MAX_EVIDENCE_PATH_CHARS),
        }),
        "editor_promote_asset" => json!({
            "ok": result.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty())
                && result.get("assetId").and_then(Value::as_str).is_some(),
            "id": bounded_string_value(result.get("id"), MAX_EVIDENCE_PATH_CHARS),
            "name": bounded_string_value(result.get("name"), MAX_EVIDENCE_PATH_CHARS),
            "assetId": bounded_string_value(result.get("assetId"), MAX_EVIDENCE_PATH_CHARS),
        }),
        "editor_asset_builder_apply" => {
            let applied = result.get("applied").and_then(Value::as_u64);
            let errors = result.get("errors").and_then(Value::as_array);
            json!({
                "ok": applied.is_some_and(|count| count > 0)
                    && errors.is_some_and(Vec::is_empty),
                "applied": applied,
                "created": bounded_string_array(result.get("created")),
                "errorCount": errors.map(Vec::len),
            })
        }
        "editor_asset_builder_save" => json!({
            "ok": result.get("saved").and_then(Value::as_bool) == Some(true)
                && result.get("assetId").and_then(Value::as_str).is_some(),
            "saved": result.get("saved").cloned().unwrap_or(Value::Null),
            "assetId": bounded_string_value(result.get("assetId"), MAX_EVIDENCE_PATH_CHARS),
        }),
        "editor_run_tests" => {
            let Some(results) = result.as_array() else {
                return json!({ "ok": false, "error": "unexpected result shape" });
            };
            let passed_ids = results
                .iter()
                .filter(|test| test.get("pass").and_then(Value::as_bool) == Some(true))
                .filter_map(|test| test.get("id").and_then(Value::as_str))
                .take(MAX_ATTESTED_IDS)
                .map(|id| truncate_chars(id, MAX_EVIDENCE_PATH_CHARS))
                .collect::<Vec<_>>();
            let failed_ids = results
                .iter()
                .filter(|test| test.get("pass").and_then(Value::as_bool) != Some(true))
                .filter_map(|test| test.get("id").and_then(Value::as_str))
                .take(MAX_ATTESTED_IDS)
                .map(|id| truncate_chars(id, MAX_EVIDENCE_PATH_CHARS))
                .collect::<Vec<_>>();
            let malformed = results.iter().any(|test| {
                test.get("id").and_then(Value::as_str).is_none()
                    || test.get("pass").and_then(Value::as_bool).is_none()
            });
            json!({
                "ok": !results.is_empty() && !malformed && failed_ids.is_empty(),
                "total": results.len(),
                "passed": passed_ids.len(),
                "failed": results.len().saturating_sub(passed_ids.len()),
                "malformed": malformed,
                "passedIds": passed_ids,
                "failedIds": failed_ids,
            })
        }
        "editor_console_history" => {
            let count = result.get("count").and_then(Value::as_u64);
            let available = result.get("available").and_then(Value::as_bool);
            json!({
                "ok": count.is_some() && available == Some(true),
                "available": available,
                "count": count,
            })
        }
        "editor_analyze_motion" => {
            let png_path = bounded_string_value(result.get("pngPath"), MAX_EVIDENCE_PATH_CHARS);
            let manifest_path =
                bounded_string_value(result.get("manifestPath"), MAX_EVIDENCE_PATH_CHARS);
            json!({
                "ok": !png_path.is_null() && !manifest_path.is_null()
                    && result.get("frames").and_then(Value::as_u64).is_some_and(|frames| frames > 0),
                "frames": result.get("frames").cloned().unwrap_or(Value::Null),
                "pngPath": png_path,
                "manifestPath": manifest_path,
            })
        }
        "editor_project_save" => json!({
            "ok": result.get("saved").and_then(Value::as_bool) == Some(true),
            "saved": result.get("saved").cloned().unwrap_or(Value::Null),
            "slug": bounded_string_value(result.get("slug"), MAX_EVIDENCE_PATH_CHARS),
        }),
        "editor_persist_capture" => json!({
            "ok": result.get("path").and_then(Value::as_str).is_some()
                && result.get("bytes").and_then(Value::as_u64).is_some_and(|bytes| bytes > 0)
                && result.get("sha256").and_then(Value::as_str).is_some_and(|sha| !sha.is_empty()),
            "path": bounded_string_value(result.get("path"), MAX_EVIDENCE_PATH_CHARS),
            "bytes": result.get("bytes").cloned().unwrap_or(Value::Null),
            "sha256": bounded_string_value(result.get("sha256"), 128),
            "frame": result.get("frame").cloned().unwrap_or(Value::Null),
            "timeMs": result.get("timeMs").cloned().unwrap_or(Value::Null),
        }),
        "editor_run_pie" => json!({
            "ok": result.get("advancedFrames").and_then(Value::as_u64).is_some_and(|frames| frames > 0),
            "frames": result.get("frames").cloned().unwrap_or(Value::Null),
            "advancedFrames": result.get("advancedFrames").cloned().unwrap_or(Value::Null),
        }),
        "editor_camera_frame" => json!({
            "ok": result.get("persisted").and_then(Value::as_bool) == Some(true)
                && result.get("camera").and_then(Value::as_object).is_some(),
            "persisted": result.get("persisted").cloned().unwrap_or(Value::Null),
            "framedEntityIds": bounded_string_array(result.get("framedEntityIds")),
            "camera": result.get("camera").cloned().unwrap_or(Value::Null),
        }),
        _ => json!({ "ok": false, "error": "unsupported attestation" }),
    }
}

/// Bounded capture storage for one node attempt. Data URLs remain transient:
/// they are decoded into `VideoFrame`s before any graph state is persisted.
/// Persisted capture paths are kept as metadata only — the actual PNG/JPEG
/// bytes live under the project tree and are re-validated on read.
#[derive(Debug, Clone, Default)]
struct CaptureBuffer {
    frames: Vec<CapturedFrame>,
    retained_data_url_bytes: usize,
    /// Successful `editor_persist_capture` events, recorded in the order
    /// the listener saw them. Compose-time dedupe keeps the latest event
    /// for any repeated path so the merged `relative_paths` matches what
    /// the worker actually wrote last.
    persisted_captures: Vec<PersistedCaptureEntry>,
    /// Aggregate on-disk payload size across retained persisted captures.
    retained_persisted_bytes: usize,
    pending_attestations: HashMap<String, PendingToolAttestation>,
    tool_attestations: Vec<ToolAttestation>,
    dropped: usize,
}

impl CaptureBuffer {
    fn record(&mut self, event: &Value, expected_session: &str, sequence: &mut u64) {
        // Events arrive on a single shared bus; the listener is bound to one
        // session and one tool at a time, so the two tool families are
        // dispatched on the same admission gate.
        if event["type"] != "agent.tool_finished"
            || event["sessionId"].as_str() != Some(expected_session)
        {
            return;
        }
        let Some(tool) = event["tool"].as_str() else {
            return;
        };
        if tool == "editor_capture_frame" {
            self.record_capture_frame(event, sequence);
        } else if tool == "editor_persist_capture" {
            self.record_persisted_capture(event, sequence);
        }
        if is_attested_editor_tool(tool) {
            self.record_tool_finished(event, tool);
        }
    }

    fn record_started(&mut self, event: &Value, expected_session: &str) {
        if event["type"] != "agent.tool_started"
            || event["sessionId"].as_str() != Some(expected_session)
        {
            return;
        }
        let Some(tool) = event["tool"]
            .as_str()
            .filter(|tool| is_attested_editor_tool(tool))
        else {
            return;
        };
        let Some(call_id) = event["toolCallId"].as_str() else {
            return;
        };
        if self.pending_attestations.len() >= MAX_ATTESTED_TOOL_CALLS
            || event["arguments"].to_string().len() > MAX_ATTESTED_ARGUMENT_BYTES
        {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        self.pending_attestations.insert(
            call_id.to_string(),
            PendingToolAttestation {
                tool: tool.to_string(),
                arguments: summarize_tool_arguments(tool, &event["arguments"]),
            },
        );
    }

    fn record_tool_finished(&mut self, event: &Value, tool: &str) {
        let Some(call_id) = event["toolCallId"].as_str() else {
            return;
        };
        let pending = self.pending_attestations.remove(call_id);
        if self.tool_attestations.len() >= MAX_ATTESTED_TOOL_CALLS {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        let paired = pending.filter(|value| value.tool == tool);
        self.tool_attestations.push(ToolAttestation {
            tool: tool.to_string(),
            arguments: paired
                .as_ref()
                .map(|value| value.arguments.clone())
                .unwrap_or_else(|| json!({})),
            result: paired
                .map(|_| summarize_tool_result(tool, &event["result"]))
                .unwrap_or_else(|| {
                    json!({
                        "ok": false,
                        "error": "missing paired agent.tool_started event",
                    })
                }),
        });
    }

    fn record_capture_frame(&mut self, event: &Value, sequence: &mut u64) {
        let Some(url) = event["result"]["dataUrl"].as_str() else {
            return;
        };
        *sequence = sequence.saturating_add(1);
        if !is_supported_capture_data_url(url)
            || url.len() > MAX_CAPTURE_DATA_URL_BYTES
            || self.frames.len() >= MAX_CAPTURE_FRAMES
            || self.retained_data_url_bytes.saturating_add(url.len())
                > MAX_CAPTURE_DATA_URL_TOTAL_BYTES
        {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        self.retained_data_url_bytes = self.retained_data_url_bytes.saturating_add(url.len());
        self.frames.push(CapturedFrame {
            finished_at_ms: event["finishedAtMs"]
                .as_u64()
                .or_else(|| event["startedAtMs"].as_u64()),
            sequence: *sequence,
            data_url: url.to_string(),
        });
    }

    fn record_persisted_capture(&mut self, event: &Value, sequence: &mut u64) {
        let Some(path) = event["result"]["path"].as_str() else {
            // Anything other than the success-shape is silently dropped:
            // the listener is paired by session, not by tool-call result,
            // and a `tool_finished` for a failing capture does not get to
            // poison evidence.
            self.dropped = self.dropped.saturating_add(1);
            return;
        };
        let bytes = event["result"]["bytes"].as_u64().unwrap_or(0) as usize;
        let sha256 = event["result"]["sha256"].as_str().unwrap_or("").to_string();
        *sequence = sequence.saturating_add(1);
        if !is_safe_persisted_path(path)
            || sha256.is_empty()
            || sha256.len() > 128
            || self.persisted_captures.len() >= MAX_PERSISTED_CAPTURES
            || self.retained_persisted_bytes.saturating_add(bytes) > MAX_PERSISTED_BYTES
        {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        self.retained_persisted_bytes = self.retained_persisted_bytes.saturating_add(bytes);
        self.persisted_captures.push(PersistedCaptureEntry {
            finished_at_ms: event["finishedAtMs"]
                .as_u64()
                .or_else(|| event["startedAtMs"].as_u64()),
            sequence: *sequence,
            path: path.to_string(),
        });
    }

    fn sort_chronologically(&mut self) {
        self.frames.sort_by(|left, right| {
            match (left.finished_at_ms, right.finished_at_ms) {
                (Some(left), Some(right)) => left.cmp(&right),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
            .then_with(|| left.sequence.cmp(&right.sequence))
        });
    }
}

/// Validate a project-relative path produced by `editor_persist_capture`.
///
/// Mirrors the safety ladder in `capture_persist::resolve_target`: refuses
/// absolute paths, lexical traversal, secret-named segments, and non-image
/// extensions. Kept private to the listener because the canonical path
/// validator lives in `capture_persist`; this one only needs to keep
/// evidence on the safe side of the same fence without taking a fresh
/// dependency on the core tool from graph code.
fn is_safe_persisted_path(path: &str) -> bool {
    if path.is_empty() || path.contains('\0') {
        return false;
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return false;
    }
    // `.` alone is the project root; legitimate subpaths never include it.
    for component in Path::new(path).components() {
        if matches!(component, std::path::Component::ParentDir) {
            return false;
        }
    }
    let lower = path.to_ascii_lowercase();
    if !PERSISTED_IMAGE_SUFFIXES
        .iter()
        .any(|suffix| lower.ends_with(suffix))
    {
        return false;
    }
    for segment in lower.split(['/', '\\']) {
        if PERSISTED_SECRET_SUFFIXES.contains(&segment) {
            return false;
        }
    }
    path.chars().count() <= MAX_EVIDENCE_PATH_CHARS
}

/// Capture admission is deliberately narrower than the general asset
/// pipeline: the graph's visual evidence contract is PNG/JPEG only. The
/// decoder below still validates the actual image bytes, so a mislabeled
/// payload cannot enter a contact sheet.
fn is_supported_capture_data_url(value: &str) -> bool {
    let Some((header, _payload)) = value.split_once(',') else {
        return false;
    };
    let mut segments = header.split(';');
    let Some(mime) = segments.next() else {
        return false;
    };
    let mime = mime.strip_prefix("data:").unwrap_or_default();
    if !mime.eq_ignore_ascii_case("image/png") && !mime.eq_ignore_ascii_case("image/jpeg") {
        return false;
    }
    segments.any(|segment| segment.trim().eq_ignore_ascii_case("base64"))
}

/// Watches the event bus while a subagent runs and retains a bounded,
/// chronologically ordered set of `editor_capture_frame` data URLs for the
/// expected session. A background task drains continuously because the stream
/// of `agent.delta` events can overflow any receiver left idle until the end
/// of a turn. `finish` sends a barrier command; the listener drains all
/// already-queued bus events before acknowledging it, preserving the final
/// tool-finished capture without an arbitrary sleep.
struct CaptureListener {
    buffer: Arc<std::sync::Mutex<CaptureBuffer>>,
    stop: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl CaptureListener {
    fn start(state: &AppState, expected_session: &str) -> Self {
        let mut rx = state.bus.subscribe();
        let buffer = Arc::new(std::sync::Mutex::new(CaptureBuffer::default()));
        let sink = Arc::clone(&buffer);
        let expected_session = expected_session.to_string();
        let (stop, mut stop_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let mut sequence = 0_u64;
            loop {
                tokio::select! {
                    _ = &mut stop_rx => {
                        loop {
                            match rx.try_recv() {
                                Ok(event) => {
                                    let mut guard = sink.lock().unwrap();
                                    guard.record_started(&event, &expected_session);
                                    guard.record(&event, &expected_session, &mut sequence);
                                }
                                Err(tokio::sync::broadcast::error::TryRecvError::Lagged(skipped)) => {
                                    let mut guard = sink.lock().unwrap();
                                    guard.dropped = guard.dropped.saturating_add(skipped as usize);
                                }
                                Err(tokio::sync::broadcast::error::TryRecvError::Empty)
                                | Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
                            }
                        }
                        break;
                    }
                    event = rx.recv() => match event {
                        Ok(event) => {
                            let mut guard = sink.lock().unwrap();
                            guard.record_started(&event, &expected_session);
                            guard.record(&event, &expected_session, &mut sequence);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            let mut guard = sink.lock().unwrap();
                            guard.dropped = guard.dropped.saturating_add(skipped as usize);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        });
        Self { buffer, stop, task }
    }

    async fn finish(self) -> CaptureBuffer {
        let _ = self.stop.send(());
        let _ = self.task.await;
        let mut buffer = self.buffer.lock().unwrap().clone();
        buffer.sort_chronologically();
        buffer
    }
}

/// The in-memory side of one node attempt's visual evidence. This is passed
/// directly to a monitor or judge and is never serialised into the graph.
///
/// `relative_paths` is the merged union of the contact-sheet PNG path, the
/// manifest JSON path, and each `editor_persist_capture` event the listener
/// retained for this attempt. The monitor and judge treat every entry as an
/// authoritative, engine-attested project-relative path. `frame_count`
/// tracks only the data-URL captures; `persisted_count` tracks only the
/// individual persisted captures. The contact sheet still gates whether
/// `sheet_data_url` is set, so an attempt with no `editor_capture_frame`
/// calls returns `None` regardless of how many persisted captures landed.
#[derive(Debug, Clone)]
struct AttemptEvidence {
    sheet_data_url: Option<String>,
    relative_paths: Vec<String>,
    frame_count: usize,
    /// Number of unique `editor_persist_capture` paths merged into
    /// `relative_paths` after dedupe.
    persisted_count: usize,
    tool_attestations: Vec<ToolAttestation>,
}

/// Return the latest visual evidence for each Build dependency in a stable
/// order. Dependency ids are sorted rather than relying on completion order
/// from a concurrent wave, so the judge receives the same image sequence
/// across runs.
fn dependency_sheets(
    graph: &TaskGraph,
    index: usize,
    sheets: &HashMap<String, String>,
) -> Vec<(String, String)> {
    let mut candidates = graph.nodes[index]
        .deps
        .iter()
        .filter_map(|dep_id| {
            let dep = graph
                .nodes
                .iter()
                .find(|candidate| candidate.id == *dep_id)?;
            (dep.kind == NodeKind::Build)
                .then(|| sheets.get(dep_id).cloned())
                .flatten()
                .map(|sheet| (dep_id.clone(), sheet))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    let mut retained_bytes = 0usize;
    let mut result = Vec::with_capacity(candidates.len());
    for (node_id, sheet) in candidates {
        if result.len() >= MAX_CAPTURE_FRAMES
            || sheet.len() > MAX_CAPTURE_DATA_URL_BYTES
            || retained_bytes.saturating_add(sheet.len()) > MAX_CAPTURE_DATA_URL_TOTAL_BYTES
        {
            continue;
        }
        retained_bytes = retained_bytes.saturating_add(sheet.len());
        result.push((node_id, sheet));
    }
    result
}

/// Canonical and worktree roots where on-disk evidence for one graph
/// attempt may live. Returned in priority order: the canonical project
/// directory first, the bound session worktree second.
///
/// `editor_persist_capture` (the browser-facing half that graph
/// subagents always reach) deliberately writes through
/// `capture_persist::persist_project_evidence`, which forces the bytes
/// into `~/.cali/projects/<slug>/` regardless of any attached
/// workspace. Graph evidence verification therefore anchors on the
/// project dir so the engine-attested paths the monitor and judge
/// receive line up with the files the renderer later opens. The
/// worktree stays as a fallback for older graphs and for headless
/// callers that bypass the browser wrapper.
fn evidence_bases(graph: &TaskGraph, projects_root: &Path) -> Vec<PathBuf> {
    let mut bases = Vec::with_capacity(2);
    if let Some(slug) = graph.project_slug.as_deref() {
        if let Ok(project_dir) = crate::store::project_dir(projects_root, slug) {
            bases.push(project_dir);
        }
    }
    if let Some(workspace_root) = graph
        .workspace_root
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
    {
        if !bases.iter().any(|existing| existing == &workspace_root) {
            bases.push(workspace_root);
        }
    }
    bases
}

/// Resolve a project-relative evidence path against the canonical
/// project directory first, then the bound session worktree. Returns
/// the absolute path of the first base that actually contains the
/// file, or `None` if no base has it. Used by `decode_all_frames` and
/// the merge loop in `compose_attempt_evidence` so a worker that wrote
/// through `editor_persist_capture` is not silently dropped from the
/// evidence set when the file lives in either base.
fn resolve_evidence_file(bases: &[PathBuf], relative: &str) -> Option<PathBuf> {
    for base in bases {
        let candidate = base.join(relative);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn safe_evidence_label(graph_id: &str, node_id: &str, attempt: u32) -> Option<String> {
    let safe = |value: &str| {
        !value.is_empty()
            && value.len() <= 96
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };
    (safe(graph_id) && valid_slug(node_id, MAX_SLUG_CHARS))
        .then(|| format!("graph-{graph_id}-node-{node_id}-attempt-{attempt}"))
}

fn safe_relative_evidence_path(project_dir: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(project_dir).ok()?;
    if !relative
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let value = relative.to_str()?.to_string();
    (!value.is_empty() && value.chars().count() <= MAX_EVIDENCE_PATH_CHARS).then_some(value)
}

/// Decode every frame retained by the listener — data-URL captures AND
/// on-disk `editor_persist_capture` PNG/JPEG bytes — into a single
/// chronologically-sorted `Vec<VideoFrame>`. Empty buffers bail; empty
/// data URLs bail per frame; absent or non-image files on disk are
/// silently dropped so a stray persist does not block the rest of the
/// evidence.
fn decode_all_frames(
    buffer: &CaptureBuffer,
    bases: &[PathBuf],
) -> Vec<crate::video_analysis::VideoFrame> {
    let mut raw: Vec<(Option<u64>, Vec<u8>)> = Vec::new();
    let mut decoded_bytes = 0usize;

    for frame in &buffer.frames {
        if !is_supported_capture_data_url(&frame.data_url) {
            continue;
        }
        let Ok(bytes) = crate::baselines::decode_image_base64(&frame.data_url) else {
            continue;
        };
        if bytes.len() > crate::video_analysis::MAX_INPUT_BYTES
            || decoded_bytes.saturating_add(bytes.len()) > crate::video_analysis::MAX_INPUT_BYTES
        {
            continue;
        }
        if image::load_from_memory(&bytes).is_err() {
            continue;
        }
        decoded_bytes = decoded_bytes.saturating_add(bytes.len());
        raw.push((frame.finished_at_ms, bytes));
    }

    if !bases.is_empty() {
        // Dedupe by path keeping the LAST entry in sequence order so the
        // file on disk matches what the merged list reports.
        let mut persisted = buffer.persisted_captures.clone();
        persisted.sort_by(|left, right| {
            match (left.finished_at_ms, right.finished_at_ms) {
                (Some(left), Some(right)) => left.cmp(&right),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
            .then_with(|| left.sequence.cmp(&right.sequence))
        });
        let mut last_per_path: std::collections::HashMap<String, &PersistedCaptureEntry> =
            std::collections::HashMap::new();
        for entry in &persisted {
            match last_per_path.get(&entry.path) {
                Some(existing) if existing.sequence >= entry.sequence => {}
                _ => {
                    last_per_path.insert(entry.path.clone(), entry);
                }
            }
        }
        let mut unique_entries: Vec<&PersistedCaptureEntry> = last_per_path.into_values().collect();
        unique_entries.sort_by_key(|entry| entry.sequence);
        for entry in &unique_entries {
            let Some(path) = resolve_evidence_file(bases, &entry.path) else {
                continue;
            };
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            if bytes.len() > crate::video_analysis::MAX_INPUT_BYTES
                || decoded_bytes.saturating_add(bytes.len())
                    > crate::video_analysis::MAX_INPUT_BYTES
            {
                continue;
            }
            // Only on-disk files that decode as a real PNG/JPEG count
            // toward the evidence. A corrupt file or stale path silently
            // drops — the monitor never sees a path it cannot load.
            if image::load_from_memory(&bytes).is_err() {
                continue;
            }
            decoded_bytes = decoded_bytes.saturating_add(bytes.len());
            raw.push((entry.finished_at_ms, bytes));
        }
    }

    raw.sort_by(|left, right| match (left.0, right.0) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    let first_timestamp = raw.iter().filter_map(|(timestamp, _)| *timestamp).min();
    raw.into_iter()
        .enumerate()
        .map(|(index, (timestamp, bytes))| {
            let timestamp_seconds = timestamp
                .zip(first_timestamp)
                .map(|(current, first)| current.saturating_sub(first) as f64 / 1000.0)
                .unwrap_or(index as f64 / 1000.0);
            crate::video_analysis::VideoFrame {
                bytes,
                timestamp_seconds,
                frame_number: (index as u32).saturating_add(1),
                caption: None,
            }
        })
        .collect()
}

/// Decode, compose, optionally persist, and return one attempt's visual
/// evidence. Every failure is intentionally soft: the graph still runs and
/// the monitor/judge simply receives text when no valid sheet can be made.
/// Count of unique persisted capture paths actually rendered into the
/// contact sheet. Computed lazily by `compose_attempt_evidence` so we
/// only count files that survived the on-disk validator.
async fn compose_attempt_evidence(
    state: &AppState,
    graph: &TaskGraph,
    node_id: &str,
    attempt: u32,
    buffer: CaptureBuffer,
) -> Option<AttemptEvidence> {
    let project_dir = graph
        .project_slug
        .as_deref()
        .and_then(|slug| crate::store::project_dir(&state.projects_root, slug).ok());
    let bases = evidence_bases(graph, &state.projects_root);

    // Decode the union of data-URL captures AND on-disk persisted
    // captures up front. Either source on its own is enough to produce
    // evidence; a worker that only persisted PNGs (no editor_capture_frame
    // calls) still gets a contact sheet, and the monitor still sees
    // engine-attested paths.
    let frames = decode_all_frames(&buffer, &bases);
    if frames.is_empty() && buffer.tool_attestations.is_empty() {
        return None;
    }

    if frames.is_empty() {
        return Some(AttemptEvidence {
            sheet_data_url: None,
            relative_paths: Vec::new(),
            frame_count: 0,
            persisted_count: 0,
            tool_attestations: buffer.tool_attestations,
        });
    }

    let config = crate::video_analysis::ContactSheetConfig {
        max_frames: Some(MAX_CAPTURE_FRAMES),
        ..crate::video_analysis::ContactSheetConfig::default()
    };
    let project_info =
        project_dir
            .clone()
            .zip(safe_evidence_label(&graph.graph_id, node_id, attempt));
    let graph_id = graph.graph_id.clone();
    let node_id = node_id.to_string();
    let frames_for_work = frames.clone();
    let result = tokio::task::spawn_blocking(move || {
        let (sheet, report) = crate::video_analysis::compose_sheet(&frames_for_work, &config)?;
        let png =
            crate::video_analysis::encode_png_bytes(&sheet, crate::video_analysis::MAX_PNG_BYTES)?;
        let persisted = if let Some((project_dir, label)) = project_info {
            let report_dir = project_dir.join("reports").join("video");
            crate::video_analysis::persist_report(&report_dir, &label, &frames_for_work, &config)
                .ok()
                .and_then(|report| {
                    let png_path = safe_relative_evidence_path(&project_dir, &report.png_path)?;
                    let manifest_path =
                        safe_relative_evidence_path(&project_dir, &report.manifest_path)?;
                    Some(vec![png_path, manifest_path])
                })
        } else {
            None
        };
        Ok::<_, anyhow::Error>((png, report.tiles.len(), persisted))
    })
    .await
    .ok()
    .and_then(Result::ok)?;
    let (png, frame_count, relative_paths) = result;
    let sheet_data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    );

    // The merged path list: contact-sheet PNG + manifest JSON first, then
    // every persisted path that survived the on-disk validator (already
    // deduped by `decode_all_frames` above). The contact-sheet path is
    // listed first because the monitor reads "contact sheet at <pngPath>"
    // and the subsequent paths as per-frame evidence; mixing them would
    // confuse the surface.
    let mut merged_paths = relative_paths.unwrap_or_default();
    let mut persisted_count = 0usize;

    // Two deterministic rules keep the merged path list stable across
    // runs and honest about what is on disk:
    //   1. For any path repeated across N events, keep only the entry
    //      with the highest sequence (the last write is the one on
    //      disk) — earlier duplicates drop.
    //   2. Order the unique entries by that last-seen sequence so the
    //      merged list mirrors the order in which paths finished
    //      writing. `finished_at_ms` ties break the same way.
    let mut max_seq_per_path: std::collections::HashMap<String, u64> =
        std::collections::HashMap::new();
    for entry in &buffer.persisted_captures {
        let cur = max_seq_per_path.entry(entry.path.clone()).or_insert(0);
        if entry.sequence > *cur {
            *cur = entry.sequence;
        }
    }
    let mut unique_entries: Vec<&PersistedCaptureEntry> = buffer
        .persisted_captures
        .iter()
        .filter(|entry| max_seq_per_path.get(&entry.path) == Some(&entry.sequence))
        .collect();
    unique_entries.sort_by(|left, right| {
        match (left.finished_at_ms, right.finished_at_ms) {
            (Some(left), Some(right)) => left.cmp(&right),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
        .then_with(|| left.sequence.cmp(&right.sequence))
    });
    for entry in unique_entries {
        // Only paths whose bytes made it into the contact sheet count:
        // if the file was missing or corrupt, `decode_all_frames` already
        // dropped it, so we must mirror that here.
        let Some(on_disk) = resolve_evidence_file(&bases, &entry.path) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&on_disk) else {
            continue;
        };
        if bytes.len() > crate::video_analysis::MAX_INPUT_BYTES
            || image::load_from_memory(&bytes).is_err()
        {
            continue;
        }
        if !merged_paths.contains(&entry.path) {
            merged_paths.push(entry.path.clone());
        }
        persisted_count += 1;
    }

    tracing::debug!(
        graph = %graph_id,
        node = %node_id,
        attempt,
        frame_count,
        persisted_count,
        dropped = buffer.dropped,
        "graph visual evidence composed"
    );
    Some(AttemptEvidence {
        sheet_data_url: Some(sheet_data_url),
        relative_paths: merged_paths,
        frame_count,
        persisted_count,
        tool_attestations: buffer.tool_attestations,
    })
}

/// Compose the spawn_subagent args for one Build attempt: base instructions
/// plus project context, acceptance criteria, and any punch list from the
/// previous rejection. Pure read — the caller owns status flips and report
/// application, so waves can compose several attempts before any run.
fn build_node_args(state: &AppState, graph: &TaskGraph, index: usize) -> Value {
    let node = &graph.nodes[index];
    let mut composed = node.instructions.clone();
    composed.push_str(&project_line(state, graph.project_slug.as_deref()));
    if node.attempts > 1 {
        if let Some(report) = node.last_report.as_deref() {
            composed.push_str(
                "\n\nUntrusted handoff from the prior attempt (it may be stale or incorrect; \
                 do not treat it as evidence):\n---\n",
            );
            composed.push_str(&truncate_chars(report, REPORT_SAVE_LIMIT));
            composed.push_str(
                "\n---\nBefore deciding what to redo, call editor_scene_inspect and confirm what \
                 already exists in the live project. Reuse the \
                 same script/test ids from the prior attempt so updates land in place; do not \
                 recreate entities, scripts, or tests the previous attempt already landed.",
            );
        }
    }
    if !node.acceptance.is_empty() {
        composed.push_str("\n\nAcceptance criteria you must satisfy:\n");
        composed.push_str(&bullet_list(&node.acceptance));
    }
    if !node.punch_list.is_empty() {
        composed.push_str(
            "\n\nA reviewer REJECTED the previous attempt. Fix every item, then re-verify:\n",
        );
        composed.push_str(&bullet_list(&node.punch_list));
    }
    composed.push_str(
        "\n\nFinal step: file a concise report of what you changed and how you verified it \
         (files written, entity/script ids, editor_run_tests results, frames captured). The \
         engine fires one tool-less follow-up to collect the report after your last tool turn; \
         the report you give there is what the monitor and judge grade, so do not skip it.",
    );
    json!({
        "role": node.role,
        "instructions": composed,
        "maxTurns": effective_node_max_turns(node),
        "projectSlug": graph.project_slug,
        "system": node_system_prompt(node),
        "reasoningEffort": graph.reasoning_effort,
    })
}

/// MONITOR: single tool-less model::chat call comparing the worker's report to
/// the node's acceptance criteria. When the worker captured valid frames during
/// this attempt, their bounded contact sheet is attached as an OpenAI-style
/// image content part so the monitor sees pixels, not just prose; without a
/// valid sheet the call stays text-only. Fails closed: any error or unparseable
/// verdict counts as a rejection, never a pass.
async fn monitor_node(
    state: &AppState,
    node: &GraphNode,
    goal: &str,
    report: &str,
    evidence: Option<&AttemptEvidence>,
    reasoning_effort: Option<&str>,
) -> MonitorVerdict {
    let system = "You are the MONITOR in CaliCode's graph engine. Compare a worker's \
                  report and the engine's structured per-attempt attestations against acceptance \
                  criteria. Be strict: a criterion counts only if either the report or a matching \
                  successful attestation shows concrete evidence. Attestations come directly from \
                  completed editor tool calls and outrank omissions or contradictions in a truncated \
                  report. Never infer an unattested check. Canonical persisted-capture paths were \
                  re-opened and decoded by core; do not demand file_read/file_glob verification in \
                  the disposable session worktree. Reply ONLY with JSON:\n\
                  {\"pass\": true|false, \"notes\": [\"unmet criterion or missing evidence\", ...]}";
    let criteria = node
        .acceptance
        .iter()
        .enumerate()
        .map(|(number, criterion)| format!("{}. {}", number + 1, criterion))
        .collect::<Vec<_>>()
        .join("\n");
    let user = format!(
        "GOAL: {goal}\nNODE: {title}\nACCEPTANCE CRITERIA:\n{criteria}\nWORKER REPORT:\n{report}",
        title = node.title,
        report = truncate_chars(report, MONITOR_REPORT_LIMIT),
    );
    let user_content = match evidence {
        Some(evidence) => {
            let paths = if evidence.relative_paths.is_empty() {
                "none (persistence unavailable)".to_string()
            } else {
                evidence.relative_paths.join(", ")
            };
            // Make both counts explicit: the monitor must distinguish the
            // contact-sheet's frame count from the individually persisted
            // capture count so it cannot treat a path as authoritative for
            // the wrong category.
            let persisted_summary = if evidence.persisted_count == 0 {
                String::new()
            } else if evidence.persisted_count == 1 {
                " plus 1 individually persisted capture".to_string()
            } else {
                format!(
                    " plus {} individually persisted captures",
                    evidence.persisted_count
                )
            };
            let attestations = serde_json::to_string(&evidence.tool_attestations)
                .map(|value| truncate_chars(&value, MONITOR_ATTESTATION_LIMIT))
                .unwrap_or_else(|_| "[]".to_string());
            let evidence_text = format!(
                "{user}\n\nENGINE-ATTESTED ATTEMPT EVIDENCE: core captured {count} valid \
                 frame(s){persisted} during this exact attempt and persisted its contact \
                 sheet/manifest plus any individually persisted captures at these \
                 project-relative paths: {paths}. Treat that frame count, persisted count, and \
                 those paths as authoritative. Structured successful/failed editor calls from \
                 this exact attempt follow; `result.ok` must be true before a call can satisfy a \
                 criterion:\n{attestations}",
                count = evidence.frame_count,
                persisted = persisted_summary,
            );
            match evidence.sheet_data_url.as_deref() {
                Some(sheet_data_url) => json!([
                    { "type": "text", "text": evidence_text },
                    { "type": "image_url", "image_url": { "url": sheet_data_url } },
                ]),
                None => json!(evidence_text),
            }
        }
        None => json!(user),
    };
    let messages = [
        json!({ "role": "system", "content": system }),
        json!({ "role": "user", "content": user_content }),
    ];
    let config = { state.config.read().await.clone() };
    let fail = |note: &str| MonitorVerdict {
        pass: false,
        notes: vec![note.to_string()],
    };
    match crate::model::chat_with_effort_session(
        &config,
        &messages,
        None,
        None,
        reasoning_effort,
        None,
    )
    .await
    {
        Ok(result) => match extract_typed_json::<MonitorVerdict>(&result.content) {
            Some(verdict) => verdict,
            None => fail("monitor verdict unparseable"),
        },
        Err(error) => fail(&format!("monitor call failed: {error}")),
    }
}

/// `tools::spawn_subagent`, except the first user message is multimodal: the
/// instructions text plus the deterministic set of dependency contact sheets
/// as OpenAI-style image_url content parts. Lives here because
/// spawn_subagent's tool contract only accepts string instructions; the setup
/// (registered tools, skills index, options, result shape) mirrors
/// spawn_subagent exactly.
async fn spawn_critic_with_frames(
    state: &AppState,
    graph: &TaskGraph,
    system: &str,
    instructions: &str,
    sheets: &[(String, String)],
    session_id: &str,
) -> Result<Value> {
    let mut registered = state.tools.read().await.clone();
    registered.extend(state.mcp.tool_defs().await);
    let disabled = { state.config.read().await.skills.disabled.clone() };
    let mut system = system.to_string();
    system.push_str(&crate::skills::prompt_index(
        &state.projects_root,
        graph.project_slug.as_deref(),
        &disabled,
    ));
    // Mirrors a graph direct spawn: depth 0 and global + game-scoped rules,
    // but the editor/workspace route stays bound to the graph owner.
    let permission_rules = crate::tools::permission_rules_for_binding(
        state,
        graph.project_slug.as_deref(),
        graph.workspace_root.as_deref(),
    )
    .await;
    let options = crate::agent::AgentOptions {
        permission_mode: "full-access".into(),
        max_turns: JUDGE_MAX_TURNS,
        final_response_drain: true,
        reasoning_effort: graph.reasoning_effort.clone(),
        system: Some(system),
        loop_id: None,
        project_slug: graph.project_slug.clone(),
        workspace_root: graph.workspace_root.clone(),
        approval_session: graph.owner_session.clone(),
        // The graph's owner panel owns the critic's prompts too — and an
        // unowned graph says so rather than naming the critic's own session.
        approval_owner: crate::agent::ApprovalOwner::from_ancestor(graph.owner_session.clone()),
        // Critic work is this run's work, so a cancelled run takes it with it.
        owner_graph: Some(graph.graph_id.clone()),
        subagent_depth: 0,
        permission_rules,
    };
    let mut content = Vec::with_capacity(1 + sheets.len() * 2);
    content.push(json!({ "type": "text", "text": instructions }));
    for (node_id, data_url) in sheets {
        content.push(json!({
            "type": "text",
            "text": format!("Build dependency `{node_id}` contact sheet:")
        }));
        content.push(json!({ "type": "image_url", "image_url": { "url": data_url } }));
    }
    let message = json!({
        "role": "user",
        "content": content
    });
    // Box::pin mirrors spawn_subagent: agent chat can recurse back into
    // graph/subagent tools, so the future must be boxed to stay finite.
    Box::pin(
        state
            .agents
            .chat(state, &registered, Some(session_id), &[message], options),
    )
    .await
    .and_then(|result| {
        if result["sessionId"].as_str() == Some(session_id) {
            Ok(result)
        } else {
            anyhow::bail!("graph critic returned a different session than its reserved session")
        }
    })
}

/// Build the system prompt the JUDGE critic runs under. Pulled out of
/// `judge_node` so tests can assert on the authority statement and the
/// dep evidence list without driving the full graph run.
fn judge_system_prompt(
    node: &GraphNode,
    reference: &str,
    dependency_sheets: &[(String, String)],
) -> String {
    let mut system = format!(
        "You are a JUDGE with no knowledge of how this was built, and no stake in it \
         passing. Reference bar: {reference}. Inspect the actual result yourself: use \
         editor_scene_inspect, editor_run_pie, editor_capture_frame, editor_run_tests, \
         file_read. Do not trust any claims — verify. Judge as a blind side-by-side: \
         imagine the supplied contact sheets and a frame of {reference} next to each other. \
         Say which a player would pick and exactly why; every reason they would not \
         pick this one goes in the punch_list. Harshness is your job — finding flaws \
         is success, approval without evidence is failure. Then output ONLY JSON:\n\
         {{\"score\": 0-100, \"summary\": \"...\", \"punch_list\": [\"specific, actionable fix\", ...]}}\n\
         Scoring: 90+ means it would pass review at a AAA studio next to {reference}; \
         100 means utterly perfect — you can name nothing to improve. Empty punch_list \
         is only permitted at 100."
    );
    // This node's own engine-attested evidence paths. The judge gets
    // them in the system prompt (not just the user instructions) so
    // any verdict that calls the attempt evidence-less has to
    // explicitly contradict a sentence the model already saw.
    if node.evidence_count > 0 {
        let paths = if node.evidence_paths.is_empty() {
            "(no path recorded)".to_string()
        } else {
            node.evidence_paths.join(", ")
        };
        let attempt = node
            .evidence_attempt
            .map(|value| format!(" (attempt {value})"))
            .unwrap_or_default();
        system.push_str(&format!(
            " Engine-attested evidence for THIS attempt on node `{}`: {} frame(s) at \
             project-relative paths {}{}. These are the authoritative visual evidence — the \
             engine re-decoded every on-disk PNG before listing it, the paths are what the \
             report renderer later opens.",
            node.id, node.evidence_count, paths, attempt
        ));
    }
    if !dependency_sheets.is_empty() {
        system.push_str(&format!(
            " Bounded multi-frame contact sheets for the Build dependencies are attached \
             to your first message as labeled images — weigh every available pixel \
             directly against {reference}."
        ));
        // The attached sheet bytes and the engine-attested persisted paths are
        // AUTHORITATIVE: they come from the engine's on-disk validator and the
        // paths the engine reports are what the renderer later opens. Do NOT
        // invalidate them by globbing the bound worktree for `reports/**` —
        // `editor_persist_capture` writes through
        // `capture_persist::persist_project_evidence` which forces the bytes
        // into the canonical project dir, so the worktree tree is not where
        // the evidence lives. If `file_glob` (or any other file tool) does
        // not return a path the engine listed, trust the engine — the
        // absence is a worktree-vs-project resolution artifact, not
        // evidence the attempt failed.
        system.push_str(
            " The attached sheet bytes and the engine-attested persisted paths are \
             AUTHORITATIVE; do not invalidate them by globbing the bound worktree \
             for `reports/**`. The canonical project dir is where the bytes live, \
             not the worktree.",
        );
    }
    system
}

/// Build the user-message instructions the JUDGE critic runs against.
/// The `dependency_evidence` block enumerates each Build dep's
/// `evidence_paths` and `evidence_count` so the judge can cross-check
/// the attached contact-sheet pixels against real on-disk PNGs without
/// having to re-glob the worktree.
fn judge_instructions(node: &GraphNode, graph: &TaskGraph) -> String {
    let mut deliverables = String::new();
    let mut dependency_evidence = String::new();
    for dep_id in &node.deps {
        if let Some(dep) = graph.nodes.iter().find(|other| &other.id == dep_id) {
            if dep.kind != NodeKind::Build {
                continue;
            }
            deliverables.push_str(&format!(
                "\n- {}: {}",
                dep.title,
                truncate_chars(
                    dep.last_report.as_deref().unwrap_or("(no report)"),
                    JUDGE_DEP_REPORT_LIMIT
                )
            ));
            if dep.evidence_count > 0 {
                let paths = if dep.evidence_paths.is_empty() {
                    "(no path recorded)".to_string()
                } else {
                    dep.evidence_paths.join(", ")
                };
                dependency_evidence.push_str(&format!(
                    "\n- {}: {} frame(s) at {}{}",
                    dep.id,
                    dep.evidence_count,
                    paths,
                    dep.evidence_attempt
                        .map(|attempt| format!(" (attempt {attempt})"))
                        .unwrap_or_default(),
                ));
            }
        }
    }
    let mut instructions = node.instructions.clone();
    if !node.acceptance.is_empty() {
        instructions.push_str("\n\nAcceptance criteria for the overall result:\n");
        instructions.push_str(&bullet_list(&node.acceptance));
    }
    if !deliverables.is_empty() {
        instructions.push_str("\n\nDeliverables to inspect (from the build steps):");
        instructions.push_str(&deliverables);
    }
    if !dependency_evidence.is_empty() {
        instructions.push_str("\n\nEngine-attested Build dependency evidence (canonical project-relative paths the engine validated by re-decoding the on-disk PNG; do NOT re-validate via file_glob on the worktree, the bytes live under the project store):");
        instructions.push_str(&dependency_evidence);
    }
    instructions
}

/// JUDGE: fresh critic subagent with NO builder context. It gathers its own
/// evidence via the registered editor tools, scores 0-100 vs node.reference,
/// and returns a punch list on failure. The latest contact sheet for every
/// Build dependency is attached to the critic's first message in stable node
/// id order, so the blind side-by-side happens on all available pixels;
/// without any valid dependency sheet the judge falls back to the text-only
/// path. Fails closed: an unparseable verdict scores 0.
async fn judge_node(
    state: &AppState,
    graph: &mut TaskGraph,
    index: usize,
    dependency_sheets: &[(String, String)],
    session_id: &str,
) -> JudgeVerdict {
    let (system, instructions) = {
        let node = &graph.nodes[index];
        let reference = node.reference.as_deref().unwrap_or("a shipped AAA title");
        let system = judge_system_prompt(node, reference, dependency_sheets);
        let instructions = judge_instructions(node, graph);
        (system, instructions)
    };
    let fail_closed = |note: String| JudgeVerdict {
        score: 0,
        punch_list: vec![note],
        summary: "verdict unavailable".into(),
    };
    let spawned = if dependency_sheets.is_empty() {
        let args = json!({
            "role": "critic",
            "instructions": instructions,
            "maxTurns": JUDGE_MAX_TURNS,
            "projectSlug": graph.project_slug,
            "system": system,
        });
        spawn_bound_attempt(state, graph, &args, session_id).await
    } else {
        spawn_critic_with_frames(
            state,
            graph,
            &system,
            &instructions,
            dependency_sheets,
            session_id,
        )
        .await
    };
    match spawned {
        Ok(result) => {
            let reply = result["reply"].as_str().unwrap_or("").to_string();
            {
                let node = &mut graph.nodes[index];
                node.last_report = Some(truncate_chars(&reply, REPORT_SAVE_LIMIT));
            }
            match extract_typed_json::<JudgeVerdict>(&reply) {
                Some(mut verdict) => {
                    verdict.score = verdict.score.min(PERFECT_THRESHOLD);
                    verdict
                }
                None => fail_closed("judge verdict unparseable — re-run".into()),
            }
        }
        Err(error) => fail_closed(format!("judge run failed: {error}")),
    }
}

/// Reject a build node: punch list recorded, Rejected while attempts remain,
/// Failed once the cap is hit.
fn reject_node(graph: &mut TaskGraph, index: usize, notes: Vec<String>) {
    let node = &mut graph.nodes[index];
    node.punch_list = notes;
    node.status = if node.attempts >= MAX_ATTEMPTS_PER_NODE {
        NodeStatus::Failed
    } else {
        NodeStatus::Rejected
    };
}

/// Operational failures supplement the review brief; they must not erase it.
fn reject_node_with_additional_notes(graph: &mut TaskGraph, index: usize, notes: Vec<String>) {
    let node = &mut graph.nodes[index];
    for note in notes {
        if !node.punch_list.iter().any(|existing| existing == &note) {
            node.punch_list.push(note);
        }
    }
    node.status = if node.attempts >= MAX_ATTEMPTS_PER_NODE {
        NodeStatus::Failed
    } else {
        NodeStatus::Rejected
    };
}

fn apply_attempt_evidence(
    graph: &mut TaskGraph,
    index: usize,
    attempt: u32,
    evidence: Option<&AttemptEvidence>,
) {
    let node = &mut graph.nodes[index];
    node.evidence_paths = evidence
        .map(|value| value.relative_paths.clone())
        .unwrap_or_default();
    node.evidence_count = evidence.map(|value| value.frame_count).unwrap_or(0);
    node.evidence_attempt = Some(attempt);
}

fn rollup(graph: &TaskGraph) -> Value {
    let count = |status: NodeStatus| graph.nodes.iter().filter(|n| n.status == status).count();
    json!({
        "graphId": graph.graph_id,
        "status": graph.status,
        "passed": count(NodeStatus::Passed),
        "failed": count(NodeStatus::Failed),
        "totalAttempts": graph.nodes.iter().map(|n| n.attempts).sum::<u32>(),
        "nodes": serde_json::to_value(&graph.nodes).unwrap_or(Value::Null),
    })
}

/// Entry point behind the `graph_run` tool/RPC. Runs the whole graph to a
/// terminal state SYNCHRONOUSLY (mirrors spawn_subagent's recursion contract:
/// the caller's tool call awaits the full run; progress streams on the bus).
/// Returns the final rollup: { graphId, status, passed, failed,
/// totalAttempts, nodes: [...] }.
///
/// `adopt_owner` moves the graph onto the session that asked for this run.
/// Graphs are listed globally, so a second window can start a run on a graph
/// the first one planned — and the prompts that run raises are addressed to the
/// graph's owner. Without the move they would reach a window that is not
/// expecting them while the window that clicked Run sees nothing. Merely
/// loading a graph (status, list, check out) leaves the owner on disk exactly
/// as it was; ownership moves when a run actually starts. Two calls racing here
/// can both re-stamp their in-memory copy; `begin` then lets exactly one of
/// them run, and only that one's owner is persisted.
pub async fn run(state: &AppState, graph_id: &str, adopt_owner: Option<&str>) -> Result<Value> {
    let root = graphs_root(&state.sessions_root);
    let mut graph = load(&root, graph_id)?;
    if let Some(owner) = adopt_owner
        .map(str::trim)
        .filter(|owner| !owner.is_empty())
        .filter(|owner| graph.owner_session.as_deref() != Some(*owner))
    {
        graph.owner_session = Some(owner.to_string());
    }
    validate_binding(state, &mut graph)?;
    if graph.status == GraphStatus::Cancelled {
        anyhow::bail!(
            "graph {graph_id} is cancelled; create a new graph instead of resuming cancelled work"
        );
    }
    if graph.status == GraphStatus::Complete {
        return Ok(rollup(&graph));
    }
    let cancel = state.graphs.begin(graph_id).await?;
    let recovered = recover_stale_attempts(&mut graph);
    if !recovered.is_empty() {
        broadcast(
            state,
            &root,
            &mut graph,
            "recovered",
            None,
            json!({ "nodes": recovered }),
        );
    }
    let result = run_inner(state, &root, &mut graph, &cancel).await;
    state.graphs.end(graph_id).await;
    // The run is over, so any prompt it raised is asking about work that no
    // longer exists. Core drops those senders itself — the party that knows —
    // instead of leaving them to a 300s timer or, worse, to a client guessing
    // the run is done and answering "denied" on its behalf.
    let abandoned = state.agents.approvals().cancel_by_graph(graph_id).await;
    if abandoned > 0 {
        tracing::info!(graph_id, abandoned, "dropped a finished run's approvals");
    }
    if let Err(error) = result {
        // A hard engine error still leaves a coherent, persisted graph.
        graph.status = GraphStatus::Blocked;
        broadcast(
            state,
            &root,
            &mut graph,
            "blocked",
            None,
            json!({ "error": error.to_string() }),
        );
    }
    Ok(rollup(&graph))
}

async fn run_inner(
    state: &AppState,
    root: &Path,
    graph: &mut TaskGraph,
    cancel: &AtomicBool,
) -> Result<()> {
    graph.status = GraphStatus::Running;
    broadcast(state, root, graph, "created", None, json!({}));

    // Latest transient sheet per Build node; judges receive their dependency
    // sheets in deterministic node-id order. Graph JSON stores only relative
    // paths/counts.
    let mut latest_sheets = restore_latest_sheets(state, graph);

    loop {
        if cancel.load(Ordering::Relaxed) {
            graph.status = GraphStatus::Cancelled;
            broadcast(state, root, graph, "cancelled", None, json!({}));
            return Ok(());
        }
        settle(graph);
        if let Some(status) = terminal(graph) {
            graph.status = status;
            let phase = if status == GraphStatus::Complete {
                "completed"
            } else {
                "blocked"
            };
            broadcast(state, root, graph, phase, None, json!({}));
            return Ok(());
        }
        let ready = ready_nodes(graph);
        if ready.is_empty() {
            // Deadlock guard — terminal() should have caught this.
            graph.status = GraphStatus::Blocked;
            broadcast(
                state,
                root,
                graph,
                "blocked",
                None,
                json!({ "reason": "no runnable nodes" }),
            );
            return Ok(());
        }
        let kind_of = |graph: &TaskGraph, id: &str| {
            node_index(graph, id).map(|index| graph.nodes[index].kind)
        };
        if kind_of(graph, &ready[0]) == Some(NodeKind::Build) {
            // Judges never share a wave: parallelize only when EVERY ready
            // node is a Build. A mixed ready set (a judge became ready
            // alongside an independent build branch) degrades to a wave of
            // one, so the judge's turn comes with nothing else in flight.
            let all_build = ready
                .iter()
                .all(|id| kind_of(graph, id) == Some(NodeKind::Build));
            let wave: Vec<String> = if all_build {
                ready.into_iter().take(MAX_PARALLEL_NODES).collect()
            } else {
                vec![ready[0].clone()]
            };
            run_build_wave(state, root, graph, &wave, cancel, &mut latest_sheets).await;
            continue;
        }

        // Judge — always runs alone: every ready sibling waits for the wave
        // after the verdict.
        let node_id = ready[0].clone();
        let index = node_index(graph, &node_id).expect("ready node exists");
        graph.nodes[index].status = NodeStatus::Running;
        graph.nodes[index].attempts += 1;
        let attempt = graph.nodes[index].attempts;
        let session_id = reserve_attempt_session(state, root, graph, index).await?;
        // Started before node_started goes out, so a capture made at any
        // point of the attempt lands in the listener's subscription window.
        let listener = CaptureListener::start(state, &session_id);
        broadcast(
            state,
            root,
            graph,
            "node_started",
            Some(&node_id),
            json!({ "attempt": attempt }),
        );

        let judge_sheets = dependency_sheets(graph, index, &latest_sheets);
        let verdict = judge_node(state, graph, index, &judge_sheets, &session_id).await;
        let capture_buffer = listener.finish().await;
        let evidence =
            compose_attempt_evidence(state, graph, &node_id, attempt, capture_buffer).await;
        apply_attempt_evidence(graph, index, attempt, evidence.as_ref());
        let threshold = graph.nodes[index]
            .threshold
            .unwrap_or(DEFAULT_JUDGE_THRESHOLD);
        graph.nodes[index].score = Some(verdict.score);
        broadcast(
            state,
            root,
            graph,
            "judge_verdict",
            Some(&node_id),
            json!({
                "score": verdict.score,
                "threshold": threshold,
                "punchList": verdict.punch_list,
                "summary": verdict.summary,
            }),
        );
        if verdict.score >= threshold {
            let node = &mut graph.nodes[index];
            node.status = NodeStatus::Passed;
            node.punch_list.clear();
            broadcast(state, root, graph, "node_passed", Some(&node_id), json!({}));
        } else if graph.nodes[index].attempts >= MAX_ATTEMPTS_PER_NODE {
            graph.nodes[index].status = NodeStatus::Failed;
            graph.nodes[index].punch_list = verdict.punch_list;
            broadcast(
                state,
                root,
                graph,
                "node_rejected",
                Some(&node_id),
                json!({}),
            );
        } else {
            // THE "until it's AAA" LOOP: re-open every Build dep with
            // the judge's punch list, reset the judge so it re-scores
            // after the rework.
            graph.nodes[index].status = NodeStatus::Pending;
            graph.nodes[index].punch_list = verdict.punch_list.clone();
            let deps = graph.nodes[index].deps.clone();
            for dep_id in deps {
                if let Some(dep_index) = node_index(graph, &dep_id) {
                    if graph.nodes[dep_index].kind == NodeKind::Build {
                        // A dep that has already burned its full attempt budget
                        // cannot be re-queued. Mark it Failed so settle()'s
                        // Skipped cascade reaches terminal Blocked instead of
                        // letting ready_nodes() schedule a 6th attempt.
                        graph.nodes[dep_index].punch_list = verdict.punch_list.clone();
                        graph.nodes[dep_index].status =
                            if graph.nodes[dep_index].attempts >= MAX_ATTEMPTS_PER_NODE {
                                NodeStatus::Failed
                            } else {
                                NodeStatus::Rejected
                            };
                    }
                }
            }
            broadcast(
                state,
                root,
                graph,
                "node_rejected",
                Some(&node_id),
                json!({}),
            );
        }
    }
}

/// What one wave worker hands back to the loop that owns the graph. The
/// monitor verdict lives inside `result` because a worker error never reaches
/// the monitor.
struct WaveOutcome {
    index: usize,
    attempt: u32,
    session_id: Option<String>,
    evidence: Option<AttemptEvidence>,
    result: Result<(String, MonitorVerdict)>,
}

/// Run a wave of ready Build nodes concurrently (the caller caps the wave at
/// MAX_PARALLEL_NODES and guarantees every node is a Build). Each node keeps
/// the full sequential attempt flow — spawn subagent, attribute its capture,
/// monitor, pass/reject — and the graph is persisted + broadcast as EACH node
/// changes phase or completes, not once per wave. Cancellation is checked
/// before each node starts; attempts already in flight run to completion
/// (subagent turns are not interruptible, same as the sequential engine).
///
/// Concurrency shape: the workers are plain futures polled together via
/// FuturesUnordered — they never touch the graph. All graph mutation happens
/// here, fed by an mpsc channel for the Running->Monitoring phase flip and by
/// completion outcomes. Capture attribution is safe under concurrency because
/// every CaptureListener is bound to the worker's reserved session id and each
/// worker only claims its own subagent's frames.
async fn run_build_wave(
    state: &AppState,
    root: &Path,
    graph: &mut TaskGraph,
    wave: &[String],
    cancel: &AtomicBool,
    latest_sheets: &mut HashMap<String, String>,
) {
    use futures::stream::{FuturesUnordered, StreamExt};
    // (index, session_id, report): a worker's subagent returned and its
    // monitor call is starting.
    let (monitor_tx, mut monitor_rx) =
        tokio::sync::mpsc::unbounded_channel::<(usize, Option<String>, String)>();
    let mut in_flight = FuturesUnordered::new();
    for node_id in wave {
        if cancel.load(Ordering::Relaxed) {
            break; // started attempts still resolve below; the loop top cancels
        }
        let index = node_index(graph, node_id).expect("wave node exists");
        graph.nodes[index].status = NodeStatus::Running;
        graph.nodes[index].attempts += 1;
        let attempt = graph.nodes[index].attempts;
        let args = build_node_args(state, graph, index);
        let snapshot = graph.nodes[index].clone();
        let goal = graph.goal.clone();
        let session_id = match reserve_attempt_session(state, root, graph, index).await {
            Ok(session_id) => session_id,
            Err(error) => {
                latest_sheets.remove(node_id);
                reject_node_with_additional_notes(
                    graph,
                    index,
                    vec![format!("session reservation failed: {error}")],
                );
                broadcast(
                    state,
                    root,
                    graph,
                    "node_rejected",
                    Some(node_id),
                    json!({ "error": error.to_string() }),
                );
                continue;
            }
        };
        let owner_session = graph.owner_session.clone();
        let workspace_root = graph.workspace_root.clone();
        let reasoning_effort = graph.reasoning_effort.clone();
        let graph_id = graph.graph_id.clone();
        broadcast(
            state,
            root,
            graph,
            "node_started",
            Some(node_id),
            json!({ "attempt": attempt }),
        );
        let tx = monitor_tx.clone();
        let node_id = node_id.clone();
        let snapshot_graph = graph.clone();
        in_flight.push(async move {
            // The listener subscribes before the subagent starts, so every
            // frame this worker captures lands inside its window. It is bound
            // to the worker's reserved session id, so concurrent wave
            // siblings can never claim each other's evidence.
            let listener = CaptureListener::start(state, &session_id);
            let spawned = match reasoning_effort.as_deref() {
                Some(reasoning_effort) => {
                    crate::tools::spawn_graph_subagent_with_effort(
                        state,
                        &args,
                        &session_id,
                        &graph_id,
                        owner_session.as_deref(),
                        workspace_root.as_deref(),
                        Some(reasoning_effort),
                    )
                    .await
                }
                None => {
                    crate::tools::spawn_graph_subagent(
                        state,
                        &args,
                        &session_id,
                        &graph_id,
                        owner_session.as_deref(),
                        workspace_root.as_deref(),
                    )
                    .await
                }
            }
            .and_then(|value| {
                if value["sessionId"].as_str() == Some(session_id.as_str()) {
                    Ok(value)
                } else {
                    anyhow::bail!(
                        "graph subagent returned a different session than its reserved session"
                    )
                }
            });
            tokio::task::yield_now().await;
            match spawned {
                Ok(value) => {
                    let report = value["reply"].as_str().unwrap_or("").to_string();
                    let capture_buffer = listener.finish().await;
                    let evidence = compose_attempt_evidence(
                        state,
                        &snapshot_graph,
                        &node_id,
                        attempt,
                        capture_buffer,
                    )
                    .await;
                    let _ = tx.send((index, Some(session_id.clone()), report.clone()));
                    let verdict = monitor_node(
                        state,
                        &snapshot,
                        &goal,
                        &report,
                        evidence.as_ref(),
                        snapshot_graph.reasoning_effort.as_deref(),
                    )
                    .await;
                    WaveOutcome {
                        index,
                        attempt,
                        session_id: Some(session_id),
                        evidence,
                        result: Ok((report, verdict)),
                    }
                }
                Err(error) => {
                    let capture_buffer = listener.finish().await;
                    let evidence = compose_attempt_evidence(
                        state,
                        &snapshot_graph,
                        &node_id,
                        attempt,
                        capture_buffer,
                    )
                    .await;
                    WaveOutcome {
                        index,
                        attempt,
                        session_id: Some(session_id),
                        evidence,
                        result: Err(error),
                    }
                }
            }
        });
    }
    drop(monitor_tx);
    while !in_flight.is_empty() {
        tokio::select! {
            Some((index, session_id, report)) = monitor_rx.recv() => {
                // Guarded: select may deliver a node's completion before its
                // phase event, in which case the event is stale and the
                // completion already applied session id and report.
                if graph.nodes[index].status == NodeStatus::Running {
                    let node_id = graph.nodes[index].id.clone();
                    {
                        let node = &mut graph.nodes[index];
                        node.session_id = session_id;
                        node.last_report = Some(truncate_chars(&report, REPORT_SAVE_LIMIT));
                        node.status = NodeStatus::Monitoring;
                    }
                    broadcast(state, root, graph, "node_monitor", Some(&node_id), json!({}));
                }
            }
            Some(outcome) = in_flight.next() => {
                apply_wave_outcome(state, root, graph, latest_sheets, outcome);
            }
        }
    }
}

/// Persist + broadcast one completed wave node — invoked as each node
/// finishes, so a long-running sibling never delays the graph.updated for a
/// node that is already done.
fn apply_wave_outcome(
    state: &AppState,
    root: &Path,
    graph: &mut TaskGraph,
    latest_sheets: &mut HashMap<String, String>,
    outcome: WaveOutcome,
) {
    let WaveOutcome {
        index,
        attempt,
        session_id,
        evidence,
        result,
    } = outcome;
    let node_id = graph.nodes[index].id.clone();
    apply_attempt_evidence(graph, index, attempt, evidence.as_ref());
    if let Some(value) = evidence {
        if let Some(sheet_data_url) = value.sheet_data_url.clone() {
            latest_sheets.insert(node_id.clone(), sheet_data_url);
        } else {
            latest_sheets.remove(&node_id);
        }
    } else {
        // A fresh attempt without a valid capture must not leave stale pixels
        // from an earlier attempt attached to the next judge.
        latest_sheets.remove(&node_id);
    }
    match result {
        Ok((report, verdict)) => {
            {
                let node = &mut graph.nodes[index];
                node.session_id = session_id;
                node.last_report = Some(truncate_chars(&report, REPORT_SAVE_LIMIT));
            }
            if verdict.pass {
                let node = &mut graph.nodes[index];
                node.status = NodeStatus::Passed;
                node.punch_list.clear();
                broadcast(state, root, graph, "node_passed", Some(&node_id), json!({}));
            } else {
                reject_node(graph, index, verdict.notes);
                broadcast(
                    state,
                    root,
                    graph,
                    "node_rejected",
                    Some(&node_id),
                    json!({}),
                );
            }
        }
        Err(error) => {
            reject_node_with_additional_notes(graph, index, vec![format!("worker error: {error}")]);
            broadcast(
                state,
                root,
                graph,
                "node_rejected",
                Some(&node_id),
                json!({ "error": error.to_string() }),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Tool / RPC wrappers
// ---------------------------------------------------------------------------

/// `graph_plan` tool: plan + save + broadcast "created" + return the graph.
pub async fn plan_tool(state: &AppState, args: &Value) -> Result<Value> {
    let goal = crate::tools::required_str(args, "goal")?;
    let slug = args.get("slug").and_then(Value::as_str);
    let template = args
        .get("template")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    // Preserve malformed provider output so normalization can repair common
    // wrapper shapes or report the real field/type error. Filtering here
    // used to turn every non-array into the unrelated "provide template or
    // nodes" message, leaving the model no information with which to retry.
    let nodes = args.get("nodes");
    let template = if nodes.is_some() { None } else { template };
    let owner = args.get("ownerSession").and_then(Value::as_str);
    let workspace_root = args.get("workspaceRoot").and_then(Value::as_str);
    let reasoning_effort = match args.get("reasoningEffort") {
        Some(value) => Some(value.as_str().context("reasoningEffort must be a string")?),
        None => None,
    };
    let mut graph = match reasoning_effort {
        Some(reasoning_effort) => plan_with_effort(
            &state.sessions_root,
            goal,
            slug,
            template,
            nodes,
            owner,
            workspace_root,
            Some(reasoning_effort),
        )?,
        None => plan(
            &state.sessions_root,
            goal,
            slug,
            template,
            nodes,
            owner,
            workspace_root,
        )?,
    };
    validate_binding(state, &mut graph)?;
    settle(&mut graph);
    let root = graphs_root(&state.sessions_root);
    broadcast(state, &root, &mut graph, "created", None, json!({}));
    Ok(serde_json::to_value(&graph)?)
}

/// `graph_status` tool: the graph's current persisted state.
pub fn status(state: &AppState, args: &Value) -> Result<Value> {
    let graph_id = crate::tools::required_str(args, "graphId")?;
    let graph = load(&graphs_root(&state.sessions_root), graph_id)?;
    Ok(serde_json::to_value(&graph)?)
}

/// `graph_list` tool: summaries, optionally filtered by project slug.
pub fn list_tool(state: &AppState, args: &Value) -> Result<Value> {
    let slug = args.get("slug").and_then(Value::as_str);
    let graphs = list(&graphs_root(&state.sessions_root), slug)?;
    Ok(json!({ "graphs": graphs }))
}

/// `graph_cancel` tool: raise the cancel flag on a running graph. When the
/// graph is not running but its file is stuck in Running (a crashed run), mark
/// it Cancelled on disk so it can be re-run cleanly.
pub async fn cancel_tool(state: &AppState, args: &Value) -> Result<Value> {
    let graph_id = crate::tools::required_str(args, "graphId")?;
    let was_running = state.graphs.cancel(graph_id).await;
    // Cancel only raises a flag the run loop checks between waves. A node
    // parked on an approval never reaches that check, so the wave it is joined
    // into would hold the cancellation for up to 300s per attempt. Dropping the
    // run's approvals here is what makes Cancel mean cancel.
    state.agents.approvals().cancel_by_graph(graph_id).await;
    if !was_running {
        let root = graphs_root(&state.sessions_root);
        if let Ok(mut graph) = load(&root, graph_id) {
            if graph.status == GraphStatus::Running {
                graph.status = GraphStatus::Cancelled;
                broadcast(state, &root, &mut graph, "cancelled", None, json!({}));
            }
        }
    }
    Ok(json!({ "graphId": graph_id, "cancelled": was_running }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn build_node(id: &str, deps: &[&str]) -> GraphNode {
        GraphNode {
            id: id.into(),
            title: format!("Node {id}"),
            kind: NodeKind::Build,
            role: "coder".into(),
            instructions: format!("do {id}"),
            acceptance: vec![format!("{id} done")],
            reference: None,
            threshold: None,
            max_turns: 4,
            deps: deps.iter().map(|dep| dep.to_string()).collect(),
            status: NodeStatus::Pending,
            attempts: 0,
            score: None,
            punch_list: Vec::new(),
            last_report: None,
            session_id: None,
            evidence_paths: Vec::new(),
            evidence_count: 0,
            evidence_attempt: None,
        }
    }

    fn judge_node_def(id: &str, deps: &[&str]) -> GraphNode {
        let mut node = build_node(id, deps);
        node.kind = NodeKind::Judge;
        node.role = "critic".into();
        node.reference = Some("DOOM (2016) arena combat slice".into());
        node.threshold = Some(90);
        node
    }

    fn graph_with(nodes: Vec<GraphNode>) -> TaskGraph {
        TaskGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            graph_id: format!("graph-{}", short_id()),
            goal: "test goal".into(),
            template: None,
            project_slug: None,
            nodes,
            status: GraphStatus::Planning,
            created_at: now_rfc3339(),
            updated_at: now_rfc3339(),
            owner_session: None,
            workspace_root: None,
            reasoning_effort: None,
        }
    }

    // ---- validation ----

    #[test]
    fn validate_accepts_a_diamond() {
        let graph = graph_with(vec![
            build_node("a", &[]),
            build_node("b", &["a"]),
            build_node("c", &["a"]),
            judge_node_def("judge", &["b", "c"]),
        ]);
        validate(&graph).unwrap();
    }

    #[test]
    fn validate_rejects_cycles() {
        let graph = graph_with(vec![build_node("a", &["b"]), build_node("b", &["a"])]);
        let error = validate(&graph).unwrap_err().to_string();
        assert!(error.contains("cycle"), "{error}");
    }

    #[test]
    fn validate_rejects_duplicate_ids_and_unknown_deps() {
        let graph = graph_with(vec![build_node("a", &[]), build_node("a", &[])]);
        assert!(validate(&graph)
            .unwrap_err()
            .to_string()
            .contains("duplicate"));

        let graph = graph_with(vec![build_node("a", &["ghost"])]);
        assert!(validate(&graph).unwrap_err().to_string().contains("ghost"));
    }

    #[test]
    fn validate_rejects_bad_judges() {
        // No reference.
        let mut judge = judge_node_def("judge", &["a"]);
        judge.reference = None;
        let graph = graph_with(vec![build_node("a", &[]), judge]);
        assert!(validate(&graph)
            .unwrap_err()
            .to_string()
            .contains("reference"));

        // No build dep.
        let judge_a = judge_node_def("judge-a", &["a"]);
        let judge_b = judge_node_def("judge-b", &["judge-a"]);
        let graph = graph_with(vec![build_node("a", &[]), judge_a, judge_b]);
        assert!(validate(&graph)
            .unwrap_err()
            .to_string()
            .contains("build dep"));
    }

    #[test]
    fn validate_rejects_bad_charset_and_node_cap() {
        let graph = graph_with(vec![build_node("Bad_Id", &[])]);
        assert!(validate(&graph).is_err());

        let nodes: Vec<GraphNode> = (0..MAX_NODES + 1)
            .map(|index| build_node(&format!("n{index}"), &[]))
            .collect();
        let graph = graph_with(nodes);
        assert!(validate(&graph).unwrap_err().to_string().contains("max"));
    }

    // ---- scheduling ----

    #[test]
    fn ready_nodes_orders_by_layer_then_declaration() {
        let mut graph = graph_with(vec![
            build_node("b", &[]),
            build_node("a", &[]),
            build_node("c", &["a", "b"]),
        ]);
        settle(&mut graph);
        assert_eq!(ready_nodes(&graph), vec!["b".to_string(), "a".to_string()]);

        graph.nodes[0].status = NodeStatus::Passed;
        graph.nodes[1].status = NodeStatus::Passed;
        settle(&mut graph);
        assert_eq!(ready_nodes(&graph), vec!["c".to_string()]);
    }

    #[test]
    fn rejected_nodes_re_enter_the_ready_set() {
        let mut graph = graph_with(vec![build_node("a", &[]), build_node("b", &["a"])]);
        graph.nodes[0].status = NodeStatus::Passed;
        graph.nodes[1].status = NodeStatus::Rejected;
        assert_eq!(ready_nodes(&graph), vec!["b".to_string()]);
    }

    #[test]
    fn ready_nodes_never_returns_a_rejected_node_at_the_cap() {
        // Judge re-open can set a Passed Build back to Rejected with its
        // attempts still at MAX. The scheduler must not pick it up again or
        // we exceed the cap on the next attempt increment.
        let mut graph = graph_with(vec![build_node("a", &[]), build_node("b", &["a"])]);
        graph.nodes[0].status = NodeStatus::Passed;
        graph.nodes[1].status = NodeStatus::Rejected;
        graph.nodes[1].attempts = MAX_ATTEMPTS_PER_NODE;
        assert!(ready_nodes(&graph).is_empty());
    }

    #[test]
    fn settle_escalates_a_cap_rejected_node_to_failed() {
        // A judge re-opened a Passed dep at the cap, so the dep is sitting
        // at status=Rejected with attempts=MAX. settle() must convert it
        // to Failed so the Skipped cascade below actually runs.
        let mut graph = graph_with(vec![build_node("a", &[]), build_node("b", &["a"])]);
        graph.nodes[0].status = NodeStatus::Rejected;
        graph.nodes[0].attempts = MAX_ATTEMPTS_PER_NODE;
        graph.nodes[1].status = NodeStatus::Ready;
        settle(&mut graph);
        assert_eq!(graph.nodes[0].status, NodeStatus::Failed);
        assert_eq!(graph.nodes[1].status, NodeStatus::Skipped);
        assert_eq!(terminal(&graph), Some(GraphStatus::Blocked));
    }

    #[test]
    fn judge_reopen_does_not_set_dep_to_rejected_when_at_cap() {
        // When the judge branch re-opens its Build dep, the dep must not
        // land back in the rejected-at-cap state that ready_nodes() guards
        // against. Direct simulation of the judge verdict handler.
        let mut graph = graph_with(vec![
            build_node("build", &[]),
            judge_node_def("judge", &["build"]),
        ]);
        // Build burned its full cap, then passed its last attempt.
        graph.nodes[0].status = NodeStatus::Passed;
        graph.nodes[0].attempts = MAX_ATTEMPTS_PER_NODE;
        // Judge runs once and rejects.
        graph.nodes[1].status = NodeStatus::Monitoring;
        graph.nodes[1].attempts = 1;

        // Mirror the in-graph.rs judge verdict branch with score<threshold
        // and attempts<MAX: it re-opens deps with the cap-aware status.
        let judge_index = 1usize;
        let deps = graph.nodes[judge_index].deps.clone();
        for dep_id in deps {
            let dep_index = node_index(&graph, &dep_id).expect("dep exists");
            graph.nodes[dep_index].punch_list = vec!["redo".into()];
            graph.nodes[dep_index].status =
                if graph.nodes[dep_index].attempts >= MAX_ATTEMPTS_PER_NODE {
                    NodeStatus::Failed
                } else {
                    NodeStatus::Rejected
                };
        }

        assert_eq!(graph.nodes[0].status, NodeStatus::Failed);
        settle(&mut graph);
        // The Build dep is past the cap and never re-queued regardless of
        // whether the judge branch still considers itself active.
        assert!(!ready_nodes(&graph).contains(&"build".to_string()));
    }

    #[test]
    fn settle_skips_below_failed_and_demotes_stale_ready() {
        let mut graph = graph_with(vec![
            build_node("a", &[]),
            build_node("b", &["a"]),
            build_node("c", &["b"]),
        ]);
        graph.nodes[0].status = NodeStatus::Failed;
        settle(&mut graph);
        assert_eq!(graph.nodes[1].status, NodeStatus::Skipped);
        assert_eq!(graph.nodes[2].status, NodeStatus::Skipped);

        // A Ready node whose dep is re-opened demotes back to Pending.
        let mut graph = graph_with(vec![build_node("a", &[]), build_node("b", &["a"])]);
        graph.nodes[0].status = NodeStatus::Rejected;
        graph.nodes[1].status = NodeStatus::Ready;
        settle(&mut graph);
        assert_eq!(graph.nodes[1].status, NodeStatus::Pending);
    }

    #[test]
    fn settle_never_skips_nodes_that_are_in_flight() {
        // A dep failing while a sibling attempt is mid-air must not yank the
        // active node to Skipped — its attempt resolves first.
        let mut graph = graph_with(vec![
            build_node("a", &[]),
            build_node("b", &["a"]),
            build_node("c", &["a"]),
        ]);
        graph.nodes[0].status = NodeStatus::Failed;
        graph.nodes[1].status = NodeStatus::Running;
        graph.nodes[2].status = NodeStatus::Monitoring;
        settle(&mut graph);
        assert_eq!(graph.nodes[1].status, NodeStatus::Running);
        assert_eq!(graph.nodes[2].status, NodeStatus::Monitoring);

        // Once the attempts resolve, the next settle applies the skip rule.
        graph.nodes[1].status = NodeStatus::Rejected;
        graph.nodes[2].status = NodeStatus::Rejected;
        settle(&mut graph);
        assert_eq!(graph.nodes[1].status, NodeStatus::Skipped);
        assert_eq!(graph.nodes[2].status, NodeStatus::Skipped);
    }

    #[test]
    fn terminal_detects_complete_and_blocked() {
        let mut graph = graph_with(vec![build_node("a", &[])]);
        graph.nodes[0].status = NodeStatus::Passed;
        assert_eq!(terminal(&graph), Some(GraphStatus::Complete));

        let mut graph = graph_with(vec![build_node("a", &[]), build_node("b", &["a"])]);
        graph.nodes[0].status = NodeStatus::Failed;
        settle(&mut graph);
        assert_eq!(terminal(&graph), Some(GraphStatus::Blocked));

        let mut graph = graph_with(vec![build_node("a", &[])]);
        settle(&mut graph);
        assert_eq!(terminal(&graph), None);
    }

    #[test]
    fn restart_recovery_requeues_active_attempts_without_refunding_them() {
        let mut graph = graph_with(vec![
            build_node("build", &[]),
            judge_node_def("judge", &["build"]),
        ]);
        graph.status = GraphStatus::Running;
        graph.nodes[0].status = NodeStatus::Monitoring;
        graph.nodes[0].attempts = 2;
        graph.nodes[0].session_id = Some("session-stale".into());
        graph.nodes[0].evidence_paths = vec!["reports/video/stale.png".into()];
        graph.nodes[0].evidence_count = 3;
        graph.nodes[0].evidence_attempt = Some(2);

        assert_eq!(recover_stale_attempts(&mut graph), vec!["build"]);
        assert_eq!(graph.nodes[0].status, NodeStatus::Rejected);
        assert_eq!(graph.nodes[0].attempts, 2);
        assert_eq!(graph.nodes[0].session_id, None);
        assert!(graph.nodes[0].evidence_paths.is_empty());
        assert_eq!(graph.nodes[0].evidence_count, 0);
        assert_eq!(graph.nodes[0].evidence_attempt, None);
        assert!(graph.nodes[0].punch_list[0].contains("core stopped"));
        assert_eq!(ready_nodes(&graph), vec!["build"]);
    }

    #[test]
    fn restart_recovery_fails_an_active_attempt_at_the_cap() {
        let mut graph = graph_with(vec![build_node("build", &[])]);
        graph.status = GraphStatus::Running;
        graph.nodes[0].status = NodeStatus::Running;
        graph.nodes[0].attempts = MAX_ATTEMPTS_PER_NODE;
        graph.nodes[0].score = Some(99);

        assert_eq!(recover_stale_attempts(&mut graph), vec!["build"]);
        assert_eq!(graph.nodes[0].status, NodeStatus::Failed);
        assert_eq!(graph.nodes[0].attempts, MAX_ATTEMPTS_PER_NODE);
        assert_eq!(graph.nodes[0].score, None);
        assert_eq!(terminal(&graph), Some(GraphStatus::Blocked));
    }

    #[test]
    fn restart_restores_only_safe_decodable_build_contact_sheets() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (state, _mock) = runtime.block_on(test_state(95, 0));
        let mut graph = bound_two_node_graph(&state);
        let project_dir = crate::store::project_dir(&state.projects_root, "starter").unwrap();
        let report_dir = project_dir.join("reports/video");
        std::fs::create_dir_all(&report_dir).unwrap();
        let png = crate::baselines::decode_image_base64(&capture_data_url(42)).unwrap();
        std::fs::write(report_dir.join("build.png"), &png).unwrap();
        graph.nodes[0].evidence_count = 1;
        graph.nodes[0].evidence_paths = vec!["reports/video/build.png".into()];

        let restored = restore_latest_sheets(&state, &graph);
        assert!(restored["build"].starts_with("data:image/png;base64,"));

        graph.nodes[0].evidence_paths = vec!["../outside.png".into()];
        assert!(restore_latest_sheets(&state, &graph).is_empty());
        std::fs::write(report_dir.join("broken.png"), b"not an image").unwrap();
        graph.nodes[0].evidence_paths = vec!["reports/video/broken.png".into()];
        assert!(restore_latest_sheets(&state, &graph).is_empty());
    }

    // ---- extract_json ----

    #[test]
    fn extract_json_handles_fenced_bare_and_prose() {
        let fenced = "```json\n{\"pass\": true, \"notes\": []}\n```";
        assert_eq!(extract_json(fenced).unwrap()["pass"], true);

        let bare = r#"{"score": 92, "punch_list": []}"#;
        assert_eq!(extract_json(bare).unwrap()["score"], 92);

        let prose =
            "Here is my verdict: {\"pass\": false, \"notes\": [\"missing {evidence}\"]} done";
        let value = extract_json(prose).unwrap();
        assert_eq!(value["pass"], false);
        assert_eq!(value["notes"][0], "missing {evidence}");

        // Braces inside strings do not break matching.
        let tricky = r#"{"summary": "use { and } carefully", "score": 88}"#;
        assert_eq!(extract_json(tricky).unwrap()["score"], 88);

        assert!(extract_json("no json here { broken").is_none());
        assert!(extract_json("").is_none());
    }

    #[test]
    fn typed_verdict_extraction_skips_leading_tool_json() {
        let reply = r#"
            Verified scene state: {"project":{"slug":"audit","entities":[]}}
            PIE result: {"captures":12,"frames":12}
            ```json
            {"score":95,"summary":"all criteria verified","punch_list":[]}
            ```
        "#;

        let verdict = extract_typed_json::<JudgeVerdict>(reply).expect("later verdict");
        assert_eq!(verdict.score, 95);
        assert_eq!(verdict.summary, "all criteria verified");
        assert!(verdict.punch_list.is_empty());
    }

    // ---- persistence ----

    #[test]
    fn save_load_roundtrips_and_lists_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("graphs");

        let mut older = graph_with(vec![build_node("a", &[])]);
        older.project_slug = Some("starter".into());
        older.updated_at = "2026-01-01T00:00:00Z".into();
        save(&root, &older).unwrap();

        let mut newer = graph_with(vec![build_node("a", &[])]);
        newer.graph_id = format!("graph-{}x", short_id());
        newer.project_slug = Some("other".into());
        newer.updated_at = "2026-02-01T00:00:00Z".into();
        save(&root, &newer).unwrap();

        let loaded = load(&root, &older.graph_id).unwrap();
        assert_eq!(loaded.nodes.len(), 1);
        assert_eq!(loaded.nodes[0].id, "a");

        let all = list(&root, None).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0]["graphId"], newer.graph_id);
        assert_eq!(all[0]["nodeCounts"]["total"], 1);

        let filtered = list(&root, Some("starter")).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0]["graphId"], older.graph_id);

        delete(&root, &older.graph_id).unwrap();
        delete(&root, &older.graph_id).unwrap(); // idempotent
        assert!(load(&root, &older.graph_id).is_err());
    }

    #[test]
    fn persistence_rejects_path_traversal() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path(), "../evil").is_err());
        assert!(delete(dir.path(), "../../etc/passwd").is_err());
        let mut graph = graph_with(vec![build_node("a", &[])]);
        graph.graph_id = "../escape".into();
        assert!(save(dir.path(), &graph).is_err());
    }

    #[test]
    fn graphs_root_sits_beside_sessions() {
        let root = graphs_root(Path::new("/home/u/.cali/sessions"));
        assert_eq!(root, PathBuf::from("/home/u/.cali/graphs"));
    }

    // ---- templates + planning ----

    #[test]
    fn builtin_templates_parse_and_instantiate_valid_graphs() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        for (id, _) in BUILTIN_TEMPLATES {
            let template = load_template(&sessions, id).unwrap();
            assert_eq!(&template.id, id);
            let graph = plan(
                &sessions,
                "build a space arena",
                Some("starter"),
                Some(id),
                None,
                None,
                None,
            )
            .unwrap();
            validate(&graph).unwrap();
            assert!(
                graph.nodes.iter().any(|node| node.kind == NodeKind::Judge),
                "template {id} must end at a judge"
            );
            assert!(
                !graph
                    .nodes
                    .iter()
                    .any(|node| node.instructions.contains("{{goal}}")),
                "goal must be interpolated in {id}"
            );
        }
    }

    #[test]
    fn template_list_includes_builtins_and_disk_overrides_win() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let listed = list_templates(&sessions);
        let ids: Vec<&str> = listed
            .iter()
            .filter_map(|item| item["id"].as_str())
            .collect();
        assert!(ids.contains(&"aaa-fps"));
        assert!(ids.contains(&"polished-asset"));

        // Disk override wins.
        let templates = templates_root(&sessions);
        std::fs::create_dir_all(&templates).unwrap();
        std::fs::write(
            templates.join("aaa-fps.json"),
            json!({
                "id": "aaa-fps",
                "name": "Custom FPS",
                "description": "override",
                "nodes": [
                    { "id": "only", "title": "Only", "kind": "build", "role": "coder",
                      "instructions": "do {{goal}}", "acceptance": ["done"], "deps": [] }
                ]
            })
            .to_string(),
        )
        .unwrap();
        let template = load_template(&sessions, "aaa-fps").unwrap();
        assert_eq!(template.name, "Custom FPS");
        let listed = list_templates(&sessions);
        let custom = listed.iter().find(|item| item["id"] == "aaa-fps").unwrap();
        assert_eq!(custom["name"], "Custom FPS");

        assert!(load_template(&sessions, "nope").is_err());
    }

    #[test]
    fn plan_appends_a_terminal_judge_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let nodes = json!([
            { "id": "a", "title": "A", "kind": "build", "role": "coder",
              "instructions": "do a", "acceptance": ["a done"], "deps": [] },
            { "id": "b", "title": "B", "kind": "build", "role": "coder",
              "instructions": "do b", "acceptance": ["b done"], "deps": ["a"] }
        ]);
        let graph = plan(&sessions, "polish it", None, None, Some(&nodes), None, None).unwrap();
        let judge = graph
            .nodes
            .iter()
            .find(|node| node.kind == NodeKind::Judge)
            .expect("judge appended");
        assert_eq!(judge.deps, vec!["b".to_string()]); // sink only
        assert!(judge.reference.as_deref().unwrap().contains("polish it"));
        assert_eq!(judge.threshold, Some(DEFAULT_JUDGE_THRESHOLD));
        validate(&graph).unwrap();
    }

    #[test]
    fn plan_persists_reasoning_effort_and_reads_legacy_graphs() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let nodes = json!([
            { "id": "a", "title": "A", "kind": "build", "role": "coder",
              "instructions": "do a", "acceptance": ["a done"], "deps": [] }
        ]);
        let graph = plan_with_effort(
            &sessions,
            "goal",
            None,
            None,
            Some(&nodes),
            None,
            None,
            Some(" max "),
        )
        .unwrap();
        assert_eq!(graph.reasoning_effort.as_deref(), Some("max"));

        let root = graphs_root(&sessions);
        save(&root, &graph).unwrap();
        let loaded = load(&root, &graph.graph_id).unwrap();
        assert_eq!(loaded.reasoning_effort.as_deref(), Some("max"));

        let mut legacy = serde_json::to_value(&graph).unwrap();
        legacy.as_object_mut().unwrap().remove("reasoningEffort");
        let loaded_legacy: TaskGraph = serde_json::from_value(legacy).unwrap();
        assert!(loaded_legacy.reasoning_effort.is_none());
    }

    #[test]
    fn plan_resets_runtime_state_and_requires_input() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let nodes = json!([
            { "id": "a", "title": "A", "kind": "build", "role": "coder",
              "instructions": "do a", "acceptance": [], "deps": [],
              "status": "passed", "attempts": 4, "score": 99,
              "punchList": ["stale"], "lastReport": "stale", "sessionId": "stale" }
        ]);
        let graph = plan(&sessions, "goal", None, None, Some(&nodes), None, None).unwrap();
        let node = &graph.nodes[0];
        assert_eq!(node.status, NodeStatus::Pending);
        assert_eq!(node.attempts, 0);
        assert!(node.score.is_none());
        assert!(node.punch_list.is_empty());
        assert!(node.last_report.is_none());
        assert!(node.session_id.is_none());

        assert!(plan(&sessions, "goal", None, None, None, None, None).is_err());
        assert!(plan(&sessions, "  ", None, Some("aaa-fps"), None, None, None).is_err());
    }

    #[test]
    fn provider_node_variants_are_normalized_without_weakening_fields() {
        let dir = tempfile::tempdir().unwrap();
        let nodes = json!([{
            "id": "Build Core",
            "title": "Core",
            "kind": "BUILD",
            "role": "Gameplay Specialist",
            "instructions": "make it playable",
            "acceptance": ["it plays"],
            "deps": []
        }]);
        let graph = plan(
            &dir.path().join("sessions"),
            "goal",
            None,
            None,
            Some(&nodes),
            None,
            None,
        )
        .unwrap();
        assert_eq!(graph.nodes[0].id, "build-core");
        assert_eq!(graph.nodes[0].role, "gameplay-specialist");
        assert_eq!(graph.nodes[0].kind, NodeKind::Build);

        let malformed = json!([{
            "id": "build",
            "title": "Build",
            "kind": "build",
            "role": "coder",
            "instructions": "build",
            "acceptance": {"criterion": "playable"},
            "deps": []
        }]);
        let error = plan(
            &dir.path().join("sessions"),
            "goal",
            None,
            None,
            Some(&malformed),
            None,
            None,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("nodes[0].acceptance"), "{error}");
        assert!(error.contains("array of strings"), "{error}");
    }

    // ---- graph_plan robustness: normalization + actionable errors ----

    #[test]
    fn plan_normalizes_role_and_id_from_provider_prose() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let nodes = json!([
            { "id": "design", "title": "Design", "kind": "build", "role": "planner",
              "instructions": "plan", "acceptance": ["a"], "deps": [] },
            { "id": "BuildCore", "title": "Build core", "kind": "Build", "role": "Gameplay Specialist",
              "instructions": "do the build", "acceptance": ["a"], "deps": ["Design"] }
        ]);
        let graph = plan(&sessions, "goal", None, None, Some(&nodes), None, None).unwrap();
        let node = graph.nodes.iter().find(|n| n.id == "buildcore").unwrap();
        assert_eq!(node.id, "buildcore");
        assert_eq!(node.role, "gameplay-specialist");
        assert!(matches!(node.kind, NodeKind::Build));
        assert_eq!(node.deps, vec!["design".to_string()]);
    }

    #[test]
    fn plan_normalizes_object_deps_and_unwraps_nodes_wrapper() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let nodes = json!({
            "nodes": [
                { "id": "design", "title": "Design", "kind": "build", "role": "planner",
                  "instructions": "plan", "acceptance": ["a"], "deps": {} },
                { "id": "build", "title": "Build", "kind": "build", "role": "coder",
                  "instructions": "do", "acceptance": ["a"], "deps": { "Design": [] } }
            ]
        });
        let graph = plan(&sessions, "goal", None, None, Some(&nodes), None, None).unwrap();
        assert_eq!(graph.nodes.len(), 3, "auto judge should append");
        let build = graph.nodes.iter().find(|n| n.id == "build").unwrap();
        assert_eq!(build.deps, vec!["design".to_string()]);
    }

    #[test]
    fn plan_error_surfaces_serde_detail_for_missing_field() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let nodes = json!([
            { "id": "x", "title": "t", "kind": "build", "instructions": "i" }
        ]);
        let error = plan(&sessions, "goal", None, None, Some(&nodes), None, None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("graph_plan.nodes rejected"), "{error}");
        assert!(error.contains("role"), "{error}");
        assert!(error.contains("missing"), "{error}");
    }

    #[test]
    fn plan_error_surfaces_serde_detail_for_wrong_type() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        // `kind` is the open `NodeKind` enum, so serde reports the field by
        // name when the JSON does not match.
        let nodes = json!([
            { "id": "x", "title": "t", "kind": 5, "role": "r", "instructions": "i" }
        ]);
        let error = plan(&sessions, "goal", None, None, Some(&nodes), None, None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("graph_plan.nodes[0].kind"), "{error}");
        assert!(error.contains("must be a string"), "{error}");
    }

    #[test]
    fn plan_error_surfaces_invalid_kind_variant() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let nodes = json!([
            { "id": "x", "title": "t", "kind": "critic", "role": "r", "instructions": "i" }
        ]);
        let error = plan(&sessions, "goal", None, None, Some(&nodes), None, None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("graph_plan.nodes rejected"), "{error}");
        assert!(
            error.contains("kind") || error.contains("variant"),
            "{error}"
        );
    }

    #[test]
    fn plan_error_rejects_non_array_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let error = plan(
            &sessions,
            "goal",
            None,
            None,
            Some(&json!("just a string")),
            None,
            None,
        )
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("graph_plan.nodes must be an array"),
            "{error}"
        );
        assert!(error.contains("string"), "{error}");
    }

    #[test]
    fn plan_preserves_dash_in_role_and_id() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let nodes = json!([
            { "id": "block-out", "title": "Block out", "kind": "build", "role": "level-designer",
              "instructions": "block out", "acceptance": ["a"], "deps": [] }
        ]);
        let graph = plan(&sessions, "goal", None, None, Some(&nodes), None, None).unwrap();
        let node = &graph.nodes[0];
        assert_eq!(node.id, "block-out");
        assert_eq!(node.role, "level-designer");
    }

    #[test]
    fn plan_appends_terminal_judge_after_normalization() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let nodes = json!([
            { "id": "BuildCore", "title": "Build", "kind": "Build", "role": "Coder",
              "instructions": "do it", "acceptance": ["a"], "deps": [] }
        ]);
        let graph = plan(&sessions, "goal", None, None, Some(&nodes), None, None).unwrap();
        assert_eq!(graph.nodes.len(), 2);
        let judge = graph
            .nodes
            .iter()
            .find(|n| n.kind == NodeKind::Judge)
            .unwrap();
        assert_eq!(judge.deps, vec!["buildcore".to_string()]);
    }

    // ---- runtime material mutation guard ----

    #[test]
    fn plan_rejects_runtime_emissive_intensity_pulse() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let nodes = json!([
            { "id": "build", "title": "Build", "kind": "build", "role": "coder",
              "instructions": "make the hero glow",
              "acceptance": ["emissiveIntensity pulses during PIE"],
              "deps": [] }
        ]);
        let error = plan(&sessions, "goal", None, None, Some(&nodes), None, None)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("runtime material mutation does not exist"),
            "{error}"
        );
        assert!(error.contains("nodes[0].acceptance[0]"), "{error}");
        assert!(error.contains("state.patch"), "{error}");
        assert!(error.contains("editor_object_update"), "{error}");
    }

    #[test]
    fn plan_allows_static_editor_object_update_material_criteria() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        // Static author phrase ("editor_object_update", "is set") short-circuits
        // the guard; this is the legitimate alternative the planner must use
        // for material configuration that lives in the saved scene.
        let nodes = json!([
            { "id": "build", "title": "Build", "kind": "build", "role": "coder",
              "instructions": "configure the hero material",
              "acceptance": [
                  "editor_object_update sets emissiveIntensity to 0.5",
                  "the material.color is set to #00ffff before PIE",
              ],
              "deps": [] }
        ]);
        plan(&sessions, "goal", None, None, Some(&nodes), None, None)
            .expect("static material criteria must not be rejected");
    }

    #[test]
    fn plan_allows_transform_feedback_pulse_criteria() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        // No material field token means the runtime material guard never
        // fires; the planner can still ask for transform feedback via
        // state.patch (the other valid alternative).
        let nodes = json!([
            { "id": "build", "title": "Build", "kind": "build", "role": "coder",
              "instructions": "make the entity move",
              "acceptance": [
                  "the entity's position pulses along the X axis at runtime",
              ],
              "deps": [] }
        ]);
        plan(&sessions, "goal", None, None, Some(&nodes), None, None)
            .expect("transform-only feedback must not trigger the guard");
    }

    #[test]
    fn plan_rejects_runtime_material_criteria_from_templates_too() {
        let root = tempfile::tempdir().unwrap();
        let sessions = root.path().join("sessions");
        std::fs::create_dir_all(templates_root(&sessions)).unwrap();
        std::fs::write(
            templates_root(&sessions).join("bad-runtime.json"),
            serde_json::to_vec(&json!({
                "id": "bad-runtime",
                "name": "Bad runtime material",
                "description": "invalid contract",
                "nodes": [{
                    "id": "build",
                    "title": "Build",
                    "kind": "build",
                    "role": "coder",
                    "instructions": "pulse a goal",
                    "acceptance": ["emissiveIntensity pulses during PIE"],
                    "deps": []
                }]
            }))
            .unwrap(),
        )
        .unwrap();

        let error = plan(
            &sessions,
            "build",
            Some("starter"),
            Some("bad-runtime"),
            None,
            None,
            None,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("runtime material mutation"), "{error}");
        assert!(error.contains("editor_object_update"), "{error}");
    }

    // ---- misc helpers ----

    #[test]
    fn truncate_is_char_boundary_safe() {
        let text = "héllo wörld".repeat(1000);
        let truncated = truncate_chars(&text, 100);
        assert!(truncated.len() < 130);
        assert!(truncated.ends_with("[truncated]"));
        assert_eq!(truncate_chars("short", 100), "short");
    }

    #[test]
    fn rfc3339_timestamps_look_sane() {
        let now = now_rfc3339();
        assert_eq!(now.len(), 20);
        assert!(now.starts_with("20"));
        assert!(now.ends_with('Z'));
        // Known instant: 2026-08-11 is well past the epoch math edge cases.
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }

    // ---- prompt contract ----

    fn build_prompt_node(role: &str, title: &str) -> GraphNode {
        GraphNode {
            id: "n1".into(),
            title: title.into(),
            kind: NodeKind::Build,
            role: role.into(),
            instructions: "do the thing".into(),
            acceptance: vec!["criterion".into()],
            reference: None,
            threshold: None,
            max_turns: 4,
            deps: vec![],
            status: NodeStatus::Pending,
            attempts: 0,
            score: None,
            punch_list: vec![],
            last_report: None,
            session_id: None,
            evidence_paths: vec![],
            evidence_count: 0,
            evidence_attempt: None,
        }
    }

    #[test]
    fn node_system_prompt_frames_role_and_title() {
        let prompt = node_system_prompt(&build_prompt_node("coder", "Arena blockout"));
        assert!(
            prompt.contains("coder subagent"),
            "intro should name the role: {prompt}"
        );
        assert!(
            prompt.contains("\"Arena blockout\""),
            "intro should name the title: {prompt}"
        );
        assert!(
            prompt.contains("monitor rejects claims without evidence"),
            "intro should remind the worker the monitor grades on evidence: {prompt}"
        );
    }

    #[test]
    fn node_system_prompt_directs_workers_to_live_project_editor_tools() {
        let prompt = node_system_prompt(&build_prompt_node("coder", "Blockout"));
        for tool in [
            "editor_object_add",
            "editor_object_update",
            "editor_script_write",
            "editor_test_add",
            "editor_camera_frame",
            "editor_run_pie",
            "editor_run_tests",
            "editor_capture_frame",
            "editor_scene_inspect",
        ] {
            assert!(
                prompt.contains(tool),
                "live-project paragraph must name {tool}: {prompt}"
            );
        }
    }

    #[test]
    fn node_system_prompt_exposes_safe_cross_entity_runtime_and_grid_contracts() {
        let prompt = node_system_prompt(&build_prompt_node("coder", "Runtime polish"));
        for contract in [
            "state.patch(nameOrId",
            "returns true when at least one",
            "partial `{x?,y?,z?}`",
            "Runtime material mutation does not exist",
            "material.pattern: \"grid\"",
            "Never use `|| true`",
            "positiveExpectationMessage",
        ] {
            assert!(
                prompt.contains(contract),
                "worker prompt must include {contract}: {prompt}"
            );
        }
    }

    #[test]
    fn node_system_prompt_warns_about_disposable_session_worktree() {
        let prompt = node_system_prompt(&build_prompt_node("coder", "Blockout"));
        assert!(
            prompt.contains("session worktree"),
            "prompt must name the session worktree: {prompt}"
        );
        assert!(
            prompt.contains("disposable"),
            "prompt must mark the worktree disposable: {prompt}"
        );
        assert!(
            prompt.contains("CANNOT affect the running editor"),
            "prompt must forbid treating the worktree as the editor: {prompt}"
        );
        // Regression: integration worker edited the harness source.
        assert!(
            prompt.contains("CaliCode client or core source"),
            "prompt must forbid editing client or core source: {prompt}"
        );
    }

    #[test]
    fn node_system_prompt_describes_editor_script_write_stable_id_contract() {
        let prompt = node_system_prompt(&build_prompt_node("coder", "Blockout"));
        assert!(
            prompt.contains("STABLE-ID TOOL CONTRACT"),
            "stable-id paragraph must be present: {prompt}"
        );
        // Post-client-change contract.
        assert!(
            prompt.contains("editor_script_write accepts an optional `id`"),
            "stable-id paragraph must mention editor_script_write id param: {prompt}"
        );
        assert!(
            prompt.contains("omit `id` to upsert by name"),
            "stable-id paragraph must explain the no-id upsert path: {prompt}"
        );
        assert!(
            prompt.contains("editor_test_add follows the same stable-id pattern"),
            "stable-id paragraph must mirror the contract for editor_test_add: {prompt}"
        );
    }

    #[test]
    fn node_system_prompt_describes_the_executable_script_runtime_contract() {
        let prompt = node_system_prompt(&build_prompt_node("coder", "Gameplay"));
        assert!(prompt.contains("SCRIPT RUNTIME CONTRACT"));
        assert!(prompt.contains("state.scene") && prompt.contains("state.find(nameOrId)"));
        assert!(prompt.contains("state.self") && prompt.contains("state.world"));
        assert!(prompt.contains("no global `scene` or `input` objects"));
        assert!(prompt.contains("derive visible movement from `state.time`"));
    }

    #[test]
    fn node_system_prompt_locks_capture_and_console_tool_contracts() {
        let prompt = node_system_prompt(&build_prompt_node("coder", "Blockout"));
        assert!(
            prompt.contains("CAPTURE / PERSISTENCE CONTRACT"),
            "capture persistence paragraph must be present: {prompt}"
        );
        // The live-project paragraph must enumerate every evidence tool the
        // worker is allowed to call.
        for tool in [
            "editor_camera_frame",
            "editor_persist_capture",
            "editor_console_log",
            "editor_console_history",
            "editor_analyze_motion",
        ] {
            assert!(
                prompt.contains(tool),
                "live-project paragraph must name {tool}: {prompt}"
            );
        }
        assert!(
            prompt.contains("gameplay foreground entity ids")
                && prompt.contains("persists across PIE"),
            "capture paragraph must require an authored persistent evidence camera: {prompt}"
        );
        // The capture paragraph must spell out the three contracts the worker
        // most often gets wrong.
        assert!(
            prompt.contains("editor_persist_capture") && prompt.contains("writes a"),
            "capture paragraph must explain editor_persist_capture writes PNGs: {prompt}"
        );
        assert!(
            prompt.contains("editor_persist_capture") && prompt.contains("decodable image"),
            "capture paragraph must forbid routing PNG/dataUrl through file_write: {prompt}"
        );
        assert!(
            prompt.contains("Do not try to re-validate")
                && prompt.contains("`file_read` or `file_glob`")
                && prompt.contains("canonical captures do not exist"),
            "capture paragraph must forbid impossible worktree re-validation: {prompt}"
        );
        assert!(
            prompt.contains("NEVER route a PNG"),
            "capture paragraph must use the explicit NEVER rule: {prompt}"
        );
        assert!(
            prompt.contains("editor_analyze_motion") && prompt.contains("contact sheet"),
            "capture paragraph must link editor_analyze_motion to the contact-sheet path: {prompt}"
        );
        assert!(
            prompt.contains("editor_console_history"),
            "capture paragraph must point at editor_console_history as the read tool: {prompt}"
        );
        assert!(
            prompt.contains("only writes a line"),
            "capture paragraph must mark editor_console_log as write-only: {prompt}"
        );
    }

    #[test]
    fn node_system_prompt_reserves_turn_budget_for_verification_and_report() {
        let prompt = node_system_prompt(&build_prompt_node("coder", "Blockout"));
        assert!(
            prompt.contains("TURN BUDGET"),
            "turn-budget paragraph must be present: {prompt}"
        );
        assert!(
            prompt.contains(
                "finish every required editor verification before optional duplicate checks"
            ) && prompt.contains("reserve the last 1-2 turns for the concise final report"),
            "turn-budget paragraph must tell the worker to keep turns for the report: {prompt}"
        );
        assert!(
            prompt.contains("editor_run_pie")
                && prompt.contains("editor_run_tests")
                && prompt.contains("editor_persist_capture"),
            "turn-budget paragraph must name the verification tools: {prompt}"
        );
        // Monitor/judge need motion, not a still.
        assert!(
            prompt.contains("at least 3 editor_persist_capture calls")
                && prompt.contains("distinct project-relative paths at distinct moments"),
            "turn-budget paragraph must require 3+ chronological captures: {prompt}"
        );
    }

    #[test]
    fn node_system_prompt_instructs_retry_to_reuse_persisted_project() {
        let prompt = node_system_prompt(&build_prompt_node("coder", "Blockout"));
        assert!(
            prompt.contains("ON RETRY (attempts > 1)"),
            "retry paragraph must be present: {prompt}"
        );
        assert!(
            prompt.contains("editor_scene_inspect"),
            "retry paragraph must tell the worker to inspect the live project: {prompt}"
        );
        assert!(
            prompt.contains("Do not recreate entities, scripts, tests"),
            "retry paragraph must forbid recreating landed work: {prompt}"
        );
    }

    #[tokio::test]
    async fn build_node_args_pipes_prompt_into_subagent_call() {
        let state = test_state_for_prompts();
        let mut node = build_prompt_node("coder", "Blockout");
        node.acceptance = vec!["arena entities exist".into(), "frame captured".into()];
        let mut graph = graph_with(vec![node.clone()]);
        graph.project_slug = Some("starter".into());
        let args = build_node_args(&state, &graph, 0);
        let system = args["system"].as_str().expect("system prompt is a string");
        assert!(
            system.contains("LIVE PROJECT VS. SESSION WORKTREE"),
            "subagent system must carry the live-project paragraph: {system}"
        );
        let instructions = args["instructions"]
            .as_str()
            .expect("instructions is a string");
        assert!(
            instructions.contains("Acceptance criteria you must satisfy"),
            "instructions must list the acceptance criteria: {instructions}"
        );
        assert!(
            instructions.contains("Final step: file a concise report"),
            "instructions must close with the final-report step: {instructions}"
        );
        assert_eq!(args["maxTurns"], 4);
        assert_eq!(args["role"], "coder");
        assert_eq!(args["projectSlug"], "starter");
    }

    #[tokio::test]
    async fn build_node_args_gives_integration_nodes_a_bounded_minimum_budget() {
        let state = test_state_for_prompts();
        let mut node = build_prompt_node("integrator", "Integration Build");
        node.id = "integration-build".into();
        node.max_turns = 8;
        let graph = graph_with(vec![node]);

        let args = build_node_args(&state, &graph, 0);
        assert_eq!(args["maxTurns"], INTEGRATION_MIN_TURNS);

        let mut ordinary = build_prompt_node("coder", "Arena blockout");
        ordinary.max_turns = 8;
        let graph = graph_with(vec![ordinary]);
        assert_eq!(build_node_args(&state, &graph, 0)["maxTurns"], 8);
    }

    #[test]
    fn plan_persists_the_integration_minimum_budget() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        let nodes = json!([
            { "id": "root", "title": "Root", "kind": "build", "role": "coder",
              "instructions": "do root", "acceptance": ["done"], "maxTurns": 8, "deps": [] },
            { "id": "integration", "title": "Integration", "kind": "build", "role": "integrator",
              "instructions": "integrate", "acceptance": ["integrated"], "maxTurns": 8, "deps": ["root"] },
            { "id": "judge", "title": "Judge", "kind": "judge", "role": "critic",
              "instructions": "judge", "acceptance": ["good"], "reference": "shipped game",
              "maxTurns": 6, "deps": ["integration"] }
        ]);
        let graph = plan(&sessions, "goal", None, None, Some(&nodes), None, None).unwrap();
        assert_eq!(graph.nodes[0].max_turns, 8);
        assert_eq!(graph.nodes[1].max_turns, INTEGRATION_MIN_TURNS);
        assert_eq!(graph.nodes[2].max_turns, 6);
    }

    #[tokio::test]
    async fn build_node_args_retry_message_names_editor_inspect_and_idempotence() {
        let state = test_state_for_prompts();
        let mut node = build_prompt_node("coder", "Blockout");
        node.acceptance = vec!["arena entities exist".into()];
        node.last_report = Some("I added floor + 4 covers; left capture to next attempt".into());
        let mut graph = graph_with(vec![node.clone()]);
        graph.project_slug = Some("starter".into());
        // Re-queued attempt: retry paragraph must be appended.
        graph.nodes[0].attempts = 2;
        graph.nodes[0].last_report = node.last_report.clone();
        let args = build_node_args(&state, &graph, 0);
        let instructions = args["instructions"]
            .as_str()
            .expect("instructions is a string");
        assert!(
            instructions.contains("Untrusted handoff from the prior attempt"),
            "retry attempt must surface the prior report: {instructions}"
        );
        assert!(
            instructions.contains("editor_scene_inspect"),
            "retry attempt must tell the worker to inspect the live project: {instructions}"
        );
        assert!(
            !instructions.contains("read the project slug via the file tools"),
            "retry must not send the worker back to its disposable worktree: {instructions}"
        );
        assert!(
            instructions.contains("Reuse the same script/test ids"),
            "retry attempt must ask the worker to reuse ids for idempotence: {instructions}"
        );
        assert!(
            instructions.contains("added floor + 4 covers"),
            "retry attempt must include the prior report text: {instructions}"
        );
    }

    #[tokio::test]
    async fn operational_failure_preserves_the_reviewer_brief_for_retry() {
        let state = test_state_for_prompts();
        let mut graph = graph_with(vec![build_prompt_node("integrator", "Integration")]);
        graph.nodes[0].attempts = 2;
        graph.nodes[0].punch_list = vec![
            "move collectibles into distinct arena quadrants".into(),
            "attach a playable movement script to the hero".into(),
        ];

        reject_node_with_additional_notes(
            &mut graph,
            0,
            vec!["worker error: empty completion".into()],
        );

        assert_eq!(graph.nodes[0].status, NodeStatus::Rejected);
        assert_eq!(graph.nodes[0].punch_list.len(), 3);
        let args = build_node_args(&state, &graph, 0);
        let instructions = args["instructions"].as_str().unwrap();
        assert!(
            instructions.contains("move collectibles into distinct arena quadrants"),
            "{instructions}"
        );
        assert!(
            instructions.contains("attach a playable movement script to the hero"),
            "{instructions}"
        );
        assert!(
            instructions.contains("worker error: empty completion"),
            "{instructions}"
        );
    }

    /// Throwaway `AppState` for prompt-contract tests.
    fn test_state_for_prompts() -> crate::AppState {
        let projects_root = tempfile::tempdir().unwrap().keep();
        let sessions_root = projects_root.join("sessions");
        std::fs::create_dir_all(&sessions_root).unwrap();
        let (bus, _) = tokio::sync::broadcast::channel(16);
        crate::AppState {
            config: Arc::new(tokio::sync::RwLock::new(crate::config::AppConfig::default())),
            projects_root,
            sessions_root,
            agents: crate::agent::AgentManager::new(bus.clone()),
            bus,
            workspaces: Arc::new(tokio::sync::RwLock::new(crate::workspace::Registry::new())),
            dev_servers: Arc::new(tokio::sync::RwLock::new(crate::devserver::Servers::new())),
            shutdown: Arc::new(tokio::sync::watch::channel(false).0),
            tools: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            editor_bridge: crate::editor_bridge::EditorBridge::new(
                tokio::sync::broadcast::channel(1).0,
            ),
            editor_attachment: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            graphs: GraphManager::new(),
            mcp: Arc::new(crate::mcp::McpManager::default()),
            asset_catalog: Arc::new(tokio::sync::RwLock::new(Vec::new())),
        }
    }

    // ---- GraphManager ----

    #[tokio::test]
    async fn graph_manager_begin_cancel_end() {
        let manager = GraphManager::new();
        let flag = manager.begin("graph-1").await.unwrap();
        assert!(manager.is_running("graph-1").await);
        assert!(manager.begin("graph-1").await.is_err());

        assert!(manager.cancel("graph-1").await);
        assert!(flag.load(Ordering::Relaxed));

        manager.end("graph-1").await;
        assert!(!manager.is_running("graph-1").await);
        assert!(!manager.cancel("graph-1").await);
        // Re-runnable after end.
        manager.begin("graph-1").await.unwrap();
    }

    #[tokio::test]
    async fn capture_listener_orders_expected_frames_and_retains_the_final_event() {
        let (state, _mock) = test_state(95, 0).await;
        let listener = CaptureListener::start(&state, "session-expected");
        let first = capture_data_url(10);
        let second = capture_data_url(200);
        let foreign = capture_data_url(80);
        let _ = state.bus.send(json!({
            "type": "agent.tool_finished",
            "sessionId": "session-expected",
            "tool": "editor_capture_frame",
            "finishedAtMs": 200,
            "result": { "dataUrl": first }
        }));
        let _ = state.bus.send(json!({
            "type": "agent.tool_finished",
            "sessionId": "session-foreign",
            "tool": "editor_capture_frame",
            "finishedAtMs": 50,
            "result": { "dataUrl": foreign }
        }));
        let _ = state.bus.send(json!({
            "type": "agent.tool_finished",
            "sessionId": "session-expected",
            "tool": "editor_capture_frame",
            "finishedAtMs": 100,
            "result": { "dataUrl": second }
        }));
        // Sent immediately before finish: the barrier must drain it even when
        // the listener task has not been scheduled between the two sends.
        let final_frame = capture_data_url(30);
        let _ = state.bus.send(json!({
            "type": "agent.tool_finished",
            "sessionId": "session-expected",
            "tool": "editor_capture_frame",
            "finishedAtMs": 300,
            "result": { "dataUrl": final_frame }
        }));
        let untimed_frame = capture_data_url(40);
        let _ = state.bus.send(json!({
            "type": "agent.tool_finished",
            "sessionId": "session-expected",
            "tool": "editor_capture_frame",
            "result": { "dataUrl": untimed_frame }
        }));

        let buffer = listener.finish().await;
        assert_eq!(buffer.frames.len(), 4);
        assert_eq!(buffer.frames[0].finished_at_ms, Some(100));
        assert_eq!(buffer.frames[1].finished_at_ms, Some(200));
        assert_eq!(buffer.frames[2].finished_at_ms, Some(300));
        assert_eq!(buffer.frames[2].data_url, final_frame);
        assert_eq!(buffer.frames[3].finished_at_ms, None);
        assert_eq!(buffer.dropped, 0);
    }

    #[tokio::test]
    async fn capture_listener_caps_frames_and_oversize_data_urls() {
        let (state, _mock) = test_state(95, 0).await;
        let listener = CaptureListener::start(&state, "session-capped");
        for index in 0..(MAX_CAPTURE_FRAMES + 3) {
            let _ = state.bus.send(json!({
                "type": "agent.tool_finished",
                "sessionId": "session-capped",
                "tool": "editor_capture_frame",
                "finishedAtMs": index as u64,
                "result": { "dataUrl": capture_data_url(index as u8) }
            }));
        }
        let oversized = format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_CAPTURE_DATA_URL_BYTES)
        );
        let _ = state.bus.send(json!({
            "type": "agent.tool_finished",
            "sessionId": "session-capped",
            "tool": "editor_capture_frame",
            "finishedAtMs": 9999,
            "result": { "dataUrl": oversized }
        }));
        let gif = format!(
            "data:image/gif;base64,{}",
            base64::engine::general_purpose::STANDARD.encode([0_u8; 8])
        );
        let _ = state.bus.send(json!({
            "type": "agent.tool_finished",
            "sessionId": "session-capped",
            "tool": "editor_capture_frame",
            "finishedAtMs": 10000,
            "result": { "dataUrl": gif }
        }));

        let buffer = listener.finish().await;
        assert_eq!(buffer.frames.len(), MAX_CAPTURE_FRAMES);
        assert!(buffer.dropped >= 5);
    }

    #[test]
    fn dependency_sheets_are_stable_and_build_only() {
        let graph = graph_with(vec![
            build_node("zeta", &[]),
            build_node("alpha", &[]),
            judge_node_def("judge", &["zeta", "alpha"]),
        ]);
        let sheets = HashMap::from([
            ("zeta".to_string(), "sheet-zeta".to_string()),
            ("alpha".to_string(), "sheet-alpha".to_string()),
            ("judge".to_string(), "sheet-judge".to_string()),
        ]);
        assert_eq!(
            dependency_sheets(&graph, 2, &sheets),
            vec![
                ("alpha".to_string(), "sheet-alpha".to_string()),
                ("zeta".to_string(), "sheet-zeta".to_string()),
            ]
        );
    }

    #[test]
    fn capture_data_urls_accept_only_base64_png_or_jpeg() {
        assert!(is_supported_capture_data_url("data:image/png;base64,AAAA"));
        assert!(is_supported_capture_data_url("data:image/jpeg;BASE64,AAAA"));
        assert!(!is_supported_capture_data_url("data:image/gif;base64,AAAA"));
        assert!(!is_supported_capture_data_url("data:image/png,AAAA"));
        assert!(!is_supported_capture_data_url("image/png;base64,AAAA"));
    }

    #[test]
    fn evidence_bases_lists_canonical_project_dir_before_worktree() {
        // `editor_persist_capture` routes through the browser RPC, which
        // forces writes into `~/.cali/projects/<slug>/` regardless of any
        // attached workspace. Evidence verification therefore anchors on
        // the canonical project dir; the worktree is only a fallback for
        // older graphs and headless callers.
        let temp = tempfile::tempdir().unwrap();
        let worktree = temp.path().join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        let projects_root = temp.path().join("projects");
        let project_dir = projects_root.join("slug");
        std::fs::create_dir_all(&project_dir).unwrap();
        let graph = TaskGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            graph_id: "graph-1".into(),
            goal: "goal".into(),
            template: None,
            project_slug: Some("slug".into()),
            nodes: Vec::new(),
            status: GraphStatus::Running,
            created_at: "2024-01-01T00:00:00Z".into(),
            updated_at: "2024-01-01T00:00:00Z".into(),
            owner_session: Some("owner".into()),
            workspace_root: Some(worktree.to_string_lossy().into_owned()),
            reasoning_effort: None,
        };
        let bases = evidence_bases(&graph, &projects_root);
        assert_eq!(bases, vec![project_dir.clone(), worktree.clone()]);
    }

    #[test]
    fn evidence_bases_keeps_canonical_project_dir_even_when_missing() {
        // The project dir is a path-level construct (`store::project_dir`
        // does not require the directory to exist). If the project is
        // gone, the canonical entry stays in the list so
        // `resolve_evidence_file` has a chance to fail-soft against the
        // path rather than silently switching roots.
        let temp = tempfile::tempdir().unwrap();
        let projects_root = temp.path().join("projects");
        let worktree = temp.path().join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        let project_dir = projects_root.join("slug");
        std::fs::create_dir_all(&project_dir).unwrap();
        let graph = TaskGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            graph_id: "graph-1".into(),
            goal: "goal".into(),
            template: None,
            project_slug: Some("slug".into()),
            nodes: Vec::new(),
            status: GraphStatus::Running,
            created_at: "2024-01-01T00:00:00Z".into(),
            updated_at: "2024-01-01T00:00:00Z".into(),
            owner_session: Some("owner".into()),
            workspace_root: Some(worktree.to_string_lossy().into_owned()),
            reasoning_effort: None,
        };
        let bases = evidence_bases(&graph, &projects_root);
        assert_eq!(bases, vec![project_dir, worktree]);
    }

    #[test]
    fn evidence_bases_omits_workspace_root_that_does_not_exist() {
        // A stale `workspaceRoot` (e.g. a deleted worktree) must not
        // poison the list with a non-directory path. Canonical stays,
        // the missing workspace drops.
        let temp = tempfile::tempdir().unwrap();
        let projects_root = temp.path().join("projects");
        let project_dir = projects_root.join("slug");
        std::fs::create_dir_all(&project_dir).unwrap();
        let graph = TaskGraph {
            schema_version: GRAPH_SCHEMA_VERSION,
            graph_id: "graph-1".into(),
            goal: "goal".into(),
            template: None,
            project_slug: Some("slug".into()),
            nodes: Vec::new(),
            status: GraphStatus::Running,
            created_at: "2024-01-01T00:00:00Z".into(),
            updated_at: "2024-01-01T00:00:00Z".into(),
            owner_session: Some("owner".into()),
            // Path that does not exist on disk; must be dropped.
            workspace_root: Some(temp.path().join("missing").to_string_lossy().into_owned()),
            reasoning_effort: None,
        };
        let bases = evidence_bases(&graph, &projects_root);
        assert_eq!(bases, vec![project_dir]);
    }

    #[test]
    fn resolve_evidence_file_walks_bases_canonical_first_then_worktree() {
        let temp = tempfile::tempdir().unwrap();
        let canonical = temp.path().join("canonical");
        let worktree = temp.path().join("worktree");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        let only_in_worktree = worktree.join("snap.png");
        std::fs::write(&only_in_worktree, b"worktree").unwrap();
        // Bases are ordered: canonical first, worktree fallback.
        let bases = vec![canonical.clone(), worktree.clone()];
        let resolved = resolve_evidence_file(&bases, "snap.png").unwrap();
        assert_eq!(resolved, only_in_worktree);
    }

    #[test]
    fn resolve_evidence_file_prefers_canonical_when_both_exist() {
        // When the same relative path lives in both bases, the canonical
        // project directory wins because the RPC contract promises the
        // canonical file is the authoritative evidence. This is also the
        // safety net for the workspace override case where a stray capture
        // could otherwise shadow the durable project-store copy.
        let temp = tempfile::tempdir().unwrap();
        let canonical = temp.path().join("canonical");
        let worktree = temp.path().join("worktree");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        let canonical_path = canonical.join("snap.png");
        let worktree_path = worktree.join("snap.png");
        std::fs::write(&canonical_path, b"canonical").unwrap();
        std::fs::write(&worktree_path, b"worktree").unwrap();
        let bases = vec![canonical.clone(), worktree.clone()];
        let resolved = resolve_evidence_file(&bases, "snap.png").unwrap();
        assert_eq!(resolved, canonical_path);
        // Sanity: the bytes match the canonical file, not the worktree.
        assert_eq!(std::fs::read(&resolved).unwrap(), b"canonical");
        let _ = worktree_path;
    }

    #[tokio::test]
    async fn compose_attempt_evidence_skips_invalid_frames_and_persists_safe_metadata() {
        let (state, _mock) = test_state(95, 0).await;
        let graph = bound_two_node_graph(&state);
        let buffer = CaptureBuffer {
            frames: vec![
                CapturedFrame {
                    finished_at_ms: Some(100),
                    sequence: 1,
                    data_url: capture_data_url(90),
                },
                CapturedFrame {
                    finished_at_ms: Some(200),
                    sequence: 2,
                    data_url: "data:image/png;base64,QUFB".into(),
                },
            ],
            retained_data_url_bytes: 0,
            persisted_captures: Vec::new(),
            retained_persisted_bytes: 0,
            pending_attestations: HashMap::new(),
            tool_attestations: Vec::new(),
            dropped: 1,
        };

        let evidence = compose_attempt_evidence(&state, &graph, "build", 3, buffer)
            .await
            .expect("one valid frame still produces a sheet");
        assert_eq!(evidence.frame_count, 1);
        assert_eq!(evidence.relative_paths.len(), 2);
        assert!(evidence
            .relative_paths
            .iter()
            .all(|path| !Path::new(path).is_absolute() && !path.contains("..")));
        assert!(evidence
            .sheet_data_url
            .as_deref()
            .is_some_and(|value| value.starts_with("data:image/png;base64,")));

        let project = crate::store::project_dir(&state.projects_root, "starter").unwrap();
        for path in &evidence.relative_paths {
            assert!(project.join(path).exists(), "{path}");
        }
        let mut persisted = graph.clone();
        apply_attempt_evidence(&mut persisted, 0, 3, Some(&evidence));
        let serialized = serde_json::to_string(&persisted).unwrap();
        assert!(!serialized.contains("data:image/"));
        assert!(serialized.contains("\"evidencePaths\""));
        assert!(serialized.contains("\"evidenceCount\":1"));
        assert!(serialized.contains("\"evidenceAttempt\":3"));
    }

    /// Helper: build a successful `editor_persist_capture` event payload.
    fn persisted_event(
        session: &str,
        path: &str,
        sha: &str,
        bytes: usize,
        finished_at_ms: u64,
    ) -> Value {
        json!({
            "type": "agent.tool_finished",
            "sessionId": session,
            "tool": "editor_persist_capture",
            "finishedAtMs": finished_at_ms,
            "result": {
                "path": path,
                "bytes": bytes,
                "sha256": sha,
            }
        })
    }

    fn started_event(session: &str, call_id: &str, tool: &str, arguments: Value) -> Value {
        json!({
            "type": "agent.tool_started",
            "sessionId": session,
            "tool": tool,
            "toolCallId": call_id,
            "arguments": arguments,
        })
    }

    fn finished_event(session: &str, call_id: &str, tool: &str, result: Value) -> Value {
        json!({
            "type": "agent.tool_finished",
            "sessionId": session,
            "tool": tool,
            "toolCallId": call_id,
            "result": result,
        })
    }

    #[tokio::test]
    async fn attempt_evidence_attests_live_project_mutations_and_scene_state() {
        let (state, _mock) = test_state(95, 0).await;
        let listener = CaptureListener::start(&state, "session-mutations");
        for event in [
            started_event(
                "session-mutations",
                "update",
                "editor_object_update",
                json!({
                    "id": "entity-hero",
                    "material": { "color": "#00ffff", "emissiveIntensity": 0.4 },
                    "position": [2, 1, -3],
                }),
            ),
            finished_event(
                "session-mutations",
                "update",
                "editor_object_update",
                json!({ "updated": "entity-hero" }),
            ),
            started_event(
                "session-mutations",
                "script",
                "editor_script_write",
                json!({
                    "id": "script-runtime",
                    "name": "Runtime",
                    "code": "function update(entity, state, delta) { state.patch('goal', { position: { x: 1, y: 2, z: 3 } }); }",
                }),
            ),
            finished_event(
                "session-mutations",
                "script",
                "editor_script_write",
                json!({ "saved": "Runtime", "id": "script-runtime", "created": true }),
            ),
            started_event(
                "session-mutations",
                "inspect",
                "editor_scene_inspect",
                json!({}),
            ),
            finished_event(
                "session-mutations",
                "inspect",
                "editor_scene_inspect",
                json!({
                    "project": {
                        "slug": "starter",
                        "title": "Starter",
                        "entities": [{
                            "id": "entity-hero",
                            "name": "Hero",
                            "kind": "sphere",
                            "position": [2, 1, -3],
                            "rotation": [0, 0, 0],
                            "scale": [1, 1, 1],
                            "material": { "color": "#00ffff", "emissiveIntensity": 0.4 },
                            "light": {},
                            "scriptIds": ["script-runtime"],
                            "assetId": null,
                        }],
                        "scripts": [{ "id": "script-runtime", "name": "Runtime", "code": "oversized source is intentionally not copied" }],
                        "assets": [],
                        "tests": [],
                    }
                }),
            ),
        ] {
            let _ = state.bus.send(event);
        }

        let buffer = listener.finish().await;
        let graph = bound_two_node_graph(&state);
        let evidence = compose_attempt_evidence(&state, &graph, "build", 1, buffer)
            .await
            .expect("successful mutations alone are monitor evidence");
        let attestations = serde_json::to_value(&evidence.tool_attestations).unwrap();
        assert_eq!(attestations[0]["arguments"]["material"]["color"], "#00ffff");
        assert_eq!(attestations[0]["result"]["ok"], true);
        assert_eq!(attestations[1]["arguments"]["id"], "script-runtime");
        assert_eq!(attestations[1]["result"]["created"], true);
        assert_eq!(attestations[2]["result"]["entityCount"], 1);
        assert_eq!(attestations[2]["result"]["entities"][0]["name"], "Hero");
        assert_eq!(
            attestations[2]["result"]["entities"][0]["material"]["color"],
            "#00ffff"
        );
        assert!(attestations[2]["result"]["scripts"][0]
            .get("code")
            .is_none());
    }

    #[tokio::test]
    async fn attempt_evidence_marks_rejected_mutation_as_failed() {
        let (state, _mock) = test_state(95, 0).await;
        let listener = CaptureListener::start(&state, "session-mutation-error");
        for event in [
            started_event(
                "session-mutation-error",
                "update",
                "editor_object_update",
                json!({ "id": "missing", "material": { "color": "#ff00ff" } }),
            ),
            finished_event(
                "session-mutation-error",
                "update",
                "editor_object_update",
                json!({ "error": "entity missing not found" }),
            ),
        ] {
            let _ = state.bus.send(event);
        }
        let buffer = listener.finish().await;
        let graph = bound_two_node_graph(&state);
        let evidence = compose_attempt_evidence(&state, &graph, "build", 1, buffer)
            .await
            .expect("failed mutations remain visible to the monitor");
        let attestations = serde_json::to_value(&evidence.tool_attestations).unwrap();
        assert_eq!(attestations[0]["result"]["ok"], false);
        assert!(attestations[0]["result"]["error"]
            .as_str()
            .unwrap()
            .contains("not found"));
    }

    #[tokio::test]
    async fn attempt_evidence_never_attests_an_unpaired_success() {
        let (state, _mock) = test_state(95, 0).await;
        let listener = CaptureListener::start(&state, "session-unpaired");
        let _ = state.bus.send(finished_event(
            "session-unpaired",
            "missing-start",
            "editor_object_update",
            json!({ "updated": "entity-hero" }),
        ));
        let buffer = listener.finish().await;
        let graph = bound_two_node_graph(&state);
        let evidence = compose_attempt_evidence(&state, &graph, "build", 1, buffer)
            .await
            .expect("unpaired calls remain visible as failed attestations");
        let attestations = serde_json::to_value(&evidence.tool_attestations).unwrap();
        assert_eq!(attestations[0]["result"]["ok"], false);
        assert!(attestations[0]["result"]["error"]
            .as_str()
            .unwrap()
            .contains("missing paired"));
    }

    #[tokio::test]
    async fn attempt_evidence_attests_completed_editor_checks_without_pixels() {
        let (state, _mock) = test_state(95, 0).await;
        let listener = CaptureListener::start(&state, "session-attest");
        for event in [
            started_event(
                "session-attest",
                "console",
                "editor_console_history",
                json!({ "level": "error" }),
            ),
            finished_event(
                "session-attest",
                "console",
                "editor_console_history",
                json!({ "available": true, "count": 0, "logs": [] }),
            ),
            started_event("session-attest", "tests", "editor_run_tests", json!({})),
            finished_event(
                "session-attest",
                "tests",
                "editor_run_tests",
                json!([
                    { "id": "test-a", "name": "A", "pass": true, "logs": [] },
                    { "id": "test-b", "name": "B", "pass": true, "logs": [] }
                ]),
            ),
            started_event(
                "session-attest",
                "motion",
                "editor_analyze_motion",
                json!({ "label": "final-motion", "frames": 8 }),
            ),
            finished_event(
                "session-attest",
                "motion",
                "editor_analyze_motion",
                json!({
                    "frames": 8,
                    "pngPath": "reports/video/final-motion.png",
                    "manifestPath": "reports/video/final-motion.manifest.json"
                }),
            ),
            started_event("session-attest", "save", "editor_project_save", json!({})),
            finished_event(
                "session-attest",
                "save",
                "editor_project_save",
                json!({ "saved": true, "slug": "starter" }),
            ),
        ] {
            let _ = state.bus.send(event);
        }

        let buffer = listener.finish().await;
        let graph = bound_two_node_graph(&state);
        let evidence = compose_attempt_evidence(&state, &graph, "build", 1, buffer)
            .await
            .expect("structured checks alone are monitor evidence");
        assert!(evidence.sheet_data_url.is_none());
        assert_eq!(evidence.frame_count, 0);
        assert_eq!(evidence.tool_attestations.len(), 4);
        let attestations = serde_json::to_value(&evidence.tool_attestations).unwrap();
        assert_eq!(attestations[0]["arguments"]["level"], "error");
        assert_eq!(attestations[0]["result"]["count"], 0);
        assert_eq!(attestations[1]["result"]["passed"], 2);
        assert_eq!(attestations[1]["result"]["failed"], 0);
        assert_eq!(attestations[2]["arguments"]["label"], "final-motion");
        assert_eq!(attestations[2]["result"]["ok"], true);
        assert_eq!(attestations[3]["result"]["saved"], true);
    }

    #[tokio::test]
    async fn attempt_evidence_marks_failed_editor_checks_without_inventing_success() {
        let (state, _mock) = test_state(95, 0).await;
        let listener = CaptureListener::start(&state, "session-attest-fail");
        for event in [
            started_event(
                "session-attest-fail",
                "tests",
                "editor_run_tests",
                json!({}),
            ),
            finished_event(
                "session-attest-fail",
                "tests",
                "editor_run_tests",
                json!([
                    { "id": "test-a", "pass": true },
                    { "id": "test-b", "pass": false, "error": "boom" }
                ]),
            ),
            started_event(
                "session-attest-fail",
                "motion",
                "editor_analyze_motion",
                json!({ "label": "final-motion", "frames": 8 }),
            ),
            finished_event(
                "session-attest-fail",
                "motion",
                "editor_analyze_motion",
                json!({ "error": "length limit exceeded" }),
            ),
        ] {
            let _ = state.bus.send(event);
        }

        let buffer = listener.finish().await;
        let graph = bound_two_node_graph(&state);
        let evidence = compose_attempt_evidence(&state, &graph, "build", 1, buffer)
            .await
            .expect("failed calls remain visible to the monitor");
        let attestations = serde_json::to_value(&evidence.tool_attestations).unwrap();
        assert_eq!(attestations[0]["result"]["ok"], false);
        assert_eq!(attestations[0]["result"]["failedIds"], json!(["test-b"]));
        assert_eq!(attestations[1]["result"]["ok"], false);
        assert!(attestations[1]["result"]["error"]
            .as_str()
            .unwrap()
            .contains("length limit"));
    }

    #[tokio::test]
    async fn compose_attempt_evidence_merges_three_persisted_captures_in_order() {
        let (state, _mock) = test_state(95, 0).await;
        let listener = CaptureListener::start(&state, "session-persist-three");
        // Pre-create the three persisted PNGs under the project tree so the
        // on-disk validator counts them as evidence. The listener only
        // knows the paths; the contact sheet is what makes them real.
        let project = crate::store::project_dir(&state.projects_root, "starter").unwrap();
        for (path, red) in [
            ("reports/walk/a.png", 10),
            ("reports/walk/b.png", 60),
            ("reports/walk/c.png", 120),
        ] {
            let full = project.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            let image = image::RgbImage::from_pixel(16, 16, image::Rgb([red, 80, 160]));
            let mut cursor = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgb8(image)
                .write_to(&mut cursor, image::ImageFormat::Png)
                .unwrap();
            std::fs::write(&full, cursor.into_inner()).unwrap();
        }

        // Three captures arrive in interleaved order with the data-URL
        // captures so a single sequence counter orders them deterministically.
        let _ = state.bus.send(json!({
            "type": "agent.tool_finished",
            "sessionId": "session-persist-three",
            "tool": "editor_capture_frame",
            "finishedAtMs": 50,
            "result": { "dataUrl": capture_data_url(120) }
        }));
        let _ = state.bus.send(persisted_event(
            "session-persist-three",
            "reports/walk/a.png",
            "sha-a",
            1024,
            100,
        ));
        let _ = state.bus.send(persisted_event(
            "session-persist-three",
            "reports/walk/b.png",
            "sha-b",
            2048,
            150,
        ));
        let _ = state.bus.send(persisted_event(
            "session-persist-three",
            "reports/walk/c.png",
            "sha-c",
            4096,
            200,
        ));
        let _ = state.bus.send(json!({
            "type": "agent.tool_finished",
            "sessionId": "session-persist-three",
            "tool": "editor_capture_frame",
            "finishedAtMs": 250,
            "result": { "dataUrl": capture_data_url(220) }
        }));

        let buffer = listener.finish().await;
        // Two capture_frame events still gate compose_attempt_evidence, and
        // the three persisted captures are sorted by sequence (interleaved
        // with the data-URL captures) into the merged relative_paths.
        let graph = bound_two_node_graph(&state);
        let evidence = compose_attempt_evidence(&state, &graph, "build", 1, buffer)
            .await
            .expect("two capture_frame events still produce a sheet");

        // The on-disk validator counted every persisted path because we
        // wrote real PNG bytes before the listener ran.
        assert_eq!(evidence.persisted_count, 3);
        // frame_count must include both data-URL captures AND on-disk
        // persisted captures because the contact sheet is built from
        // both. Three data-URL events land in the test (the two
        // interleaved ones plus the duplicate from finished_at_ms 250;
        // the second is deduped by the same path so we end with 3
        // frames from the data-URL side plus 3 from disk = 6.
        assert!(
            evidence.frame_count >= 3,
            "frame_count must include on-disk reads (got {})",
            evidence.frame_count
        );
        let persisted_paths: Vec<&str> = evidence
            .relative_paths
            .iter()
            .filter(|path| path.starts_with("reports/walk/"))
            .map(String::as_str)
            .collect();
        assert_eq!(
            persisted_paths,
            vec![
                "reports/walk/a.png",
                "reports/walk/b.png",
                "reports/walk/c.png"
            ],
            "persisted paths must appear in listener sequence order"
        );
        // Contact-sheet paths must remain first; the merged set is contact
        // sheet PNG + manifest JSON then persisted paths.
        assert!(
            evidence.relative_paths[0].ends_with(".png")
                && evidence.relative_paths[0].contains("reports/video/"),
            "contact sheet PNG must lead the merged path list: {:?}",
            evidence.relative_paths
        );
        assert!(
            evidence.relative_paths[1].ends_with(".manifest.json"),
            "contact sheet manifest must be the second merged path: {:?}",
            evidence.relative_paths
        );
    }

    #[tokio::test]
    async fn compose_attempt_evidence_works_with_zero_capture_frame_events() {
        // A worker that never called `editor_capture_frame` but persisted
        // PNGs through `editor_persist_capture` must still produce a
        // contact sheet the monitor can grade.
        let (state, _mock) = test_state(95, 0).await;
        let listener = CaptureListener::start(&state, "session-persist-only");
        let project = crate::store::project_dir(&state.projects_root, "starter").unwrap();
        for (path, red) in [
            ("reports/walk/frame-001.png", 30),
            ("reports/walk/frame-002.png", 90),
            ("reports/walk/frame-003.png", 200),
        ] {
            let full = project.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            let image = image::RgbImage::from_pixel(16, 16, image::Rgb([red, 100, 220]));
            let mut cursor = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgb8(image)
                .write_to(&mut cursor, image::ImageFormat::Png)
                .unwrap();
            std::fs::write(&full, cursor.into_inner()).unwrap();
        }
        for (i, path) in [
            "reports/walk/frame-001.png",
            "reports/walk/frame-002.png",
            "reports/walk/frame-003.png",
        ]
        .iter()
        .enumerate()
        {
            let _ = state.bus.send(persisted_event(
                "session-persist-only",
                path,
                &format!("sha-{i}"),
                1024,
                100 + (i as u64) * 50,
            ));
        }
        let buffer = listener.finish().await;
        assert_eq!(buffer.frames.len(), 0, "no data-URL captures by design");
        assert_eq!(buffer.persisted_captures.len(), 3);

        let graph = bound_two_node_graph(&state);
        let evidence = compose_attempt_evidence(&state, &graph, "build", 1, buffer)
            .await
            .expect("three persisted captures must produce a sheet");

        assert_eq!(
            evidence.frame_count, 3,
            "frame_count must reflect on-disk reads when no data-URL captures exist"
        );
        assert_eq!(evidence.persisted_count, 3);
        let persisted: Vec<&str> = evidence
            .relative_paths
            .iter()
            .filter(|path| path.starts_with("reports/walk/frame-"))
            .map(String::as_str)
            .collect();
        assert_eq!(
            persisted,
            vec![
                "reports/walk/frame-001.png",
                "reports/walk/frame-002.png",
                "reports/walk/frame-003.png"
            ]
        );
        assert!(evidence.relative_paths[0].ends_with(".png"));
        assert!(evidence.relative_paths[0].contains("reports/video/"));
    }

    #[tokio::test]
    async fn compose_attempt_evidence_drops_a_persisted_path_that_is_missing_on_disk() {
        // Only on-disk valid image paths count toward evidence. A
        // persisted path whose file was wiped between persist and
        // compose must be silently dropped — the monitor never sees a
        // path it cannot load.
        let (state, _mock) = test_state(95, 0).await;
        let listener = CaptureListener::start(&state, "session-missing");
        let project = crate::store::project_dir(&state.projects_root, "starter").unwrap();
        // Only one of the two persisted paths is actually written.
        let present = project.join("reports/walk/present.png");
        std::fs::create_dir_all(present.parent().unwrap()).unwrap();
        let image = image::RgbImage::from_pixel(8, 8, image::Rgb([10, 200, 30]));
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        std::fs::write(&present, cursor.into_inner()).unwrap();

        let _ = state.bus.send(persisted_event(
            "session-missing",
            "reports/walk/present.png",
            "sha-present",
            1024,
            100,
        ));
        let _ = state.bus.send(persisted_event(
            "session-missing",
            "reports/walk/missing.png",
            "sha-missing",
            1024,
            150,
        ));
        let buffer = listener.finish().await;

        let graph = bound_two_node_graph(&state);
        let evidence = compose_attempt_evidence(&state, &graph, "build", 1, buffer)
            .await
            .expect("the present path plus any data-URL captures must still produce a sheet");

        assert_eq!(evidence.persisted_count, 1, "missing file must not count");
        let present_path = evidence
            .relative_paths
            .iter()
            .find(|path| path.as_str() == "reports/walk/present.png")
            .expect("present.png must survive");
        assert_eq!(present_path, "reports/walk/present.png");
        let missing = evidence
            .relative_paths
            .iter()
            .find(|path| path.as_str() == "reports/walk/missing.png");
        assert!(
            missing.is_none(),
            "missing.png must be dropped: {:?}",
            evidence.relative_paths
        );
    }

    #[tokio::test]
    async fn compose_attempt_evidence_reads_persisted_captures_from_canonical_project_dir() {
        // Regression: `editor_persist_capture` (the browser wrapper that
        // graph subagents always reach) writes through
        // `capture_persist::persist_project_evidence`, which forces the
        // PNGs into `~/.cali/projects/<slug>/` regardless of any attached
        // workspace. The compose path must read those PNGs back so the
        // monitor and judge receive them — a strict live judge otherwise
        // sees evidenceCount == 0 for a node that persisted 7 frames.
        let (state, _mock) = test_state(95, 0).await;
        let listener = CaptureListener::start(&state, "session-canonical");
        let graph = bound_two_node_graph(&state);
        let project = crate::store::project_dir(&state.projects_root, "starter").unwrap();

        // The worker writes three PNGs into the canonical project dir
        // (the contract `persist_project_evidence` enforces).
        for (path, red) in [
            ("reports/walk/walk-001.png", 20),
            ("reports/walk/walk-002.png", 110),
            ("reports/walk/walk-003.png", 200),
        ] {
            let full = project.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            let image = image::RgbImage::from_pixel(16, 16, image::Rgb([red, 80, 160]));
            let mut cursor = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgb8(image)
                .write_to(&mut cursor, image::ImageFormat::Png)
                .unwrap();
            std::fs::write(&full, cursor.into_inner()).unwrap();
        }
        for (i, path) in [
            "reports/walk/walk-001.png",
            "reports/walk/walk-002.png",
            "reports/walk/walk-003.png",
        ]
        .iter()
        .enumerate()
        {
            let _ = state.bus.send(persisted_event(
                "session-canonical",
                path,
                &format!("sha-canonical-{i}"),
                1024,
                100 + (i as u64) * 50,
            ));
        }

        let buffer = listener.finish().await;
        assert_eq!(
            buffer.persisted_captures.len(),
            3,
            "all three events must land before compose runs"
        );
        let evidence = compose_attempt_evidence(&state, &graph, "build", 1, buffer)
            .await
            .expect("canonical captures must produce a sheet");
        assert_eq!(
            evidence.persisted_count, 3,
            "canonical PNGs must count toward the attempt's evidence: {:?}",
            evidence.relative_paths
        );
        let persisted: Vec<&str> = evidence
            .relative_paths
            .iter()
            .filter(|path| path.starts_with("reports/walk/walk-"))
            .map(String::as_str)
            .collect();
        assert_eq!(
            persisted,
            vec![
                "reports/walk/walk-001.png",
                "reports/walk/walk-002.png",
                "reports/walk/walk-003.png"
            ],
            "persisted paths must appear in listener sequence order"
        );
        let mut persisted_graph = graph.clone();
        apply_attempt_evidence(&mut persisted_graph, 0, 1, Some(&evidence));
        assert_eq!(persisted_graph.nodes[0].evidence_count, 3);
        assert_eq!(persisted_graph.nodes[0].evidence_attempt, Some(1));
        assert!(
            persisted_graph.nodes[0]
                .evidence_paths
                .iter()
                .any(|path| path == "reports/walk/walk-001.png"),
            "canonical path must survive as project-relative evidence: {:?}",
            persisted_graph.nodes[0].evidence_paths
        );
    }

    #[tokio::test]
    async fn capture_listener_ignores_persisted_capture_from_foreign_session() {
        let (state, _mock) = test_state(95, 0).await;
        let listener = CaptureListener::start(&state, "session-expected");
        // Foreign session: same tool, different session id, earlier timestamp.
        // The listener is bound to one session; the foreign event must be
        // dropped, not promoted into evidence that the monitor trusts.
        let _ = state.bus.send(persisted_event(
            "session-foreign",
            "reports/walk/foreign.png",
            "sha-foreign",
            512,
            50,
        ));
        let _ = state.bus.send(persisted_event(
            "session-expected",
            "reports/walk/own.png",
            "sha-own",
            1024,
            100,
        ));
        let buffer = listener.finish().await;
        assert_eq!(buffer.persisted_captures.len(), 1);
        assert_eq!(buffer.persisted_captures[0].path, "reports/walk/own.png");
        assert_eq!(
            buffer.dropped, 0,
            "foreign events are not counted as dropped"
        );
    }

    #[tokio::test]
    async fn capture_listener_rejects_unsafe_persisted_capture_paths() {
        let (state, _mock) = test_state(95, 0).await;
        let listener = CaptureListener::start(&state, "session-unsafe");
        // Each of these lands on disk in a real call but must be refused
        // up front so they never become "evidence".
        for (label, path) in [
            ("absolute", "/etc/passwd.png"),
            ("traversal", "../escape.png"),
            ("secret-suffix", ".env/innocent.png"),
            ("wrong-extension", "notes.html"),
            ("empty-sha", "empty.png"),
            ("embedded-nul", "bad\0.png"),
        ] {
            let mut event =
                persisted_event("session-unsafe", path, "sha-1234567890abcdef", 1024, 100);
            if label == "empty-sha" {
                event["result"]["sha256"] = json!("");
            }
            let _ = state.bus.send(event);
        }
        let buffer = listener.finish().await;
        assert!(
            buffer.persisted_captures.is_empty(),
            "every unsafe path must be dropped, retained: {:?}",
            buffer.persisted_captures
        );
        assert_eq!(
            buffer.dropped, 6,
            "every unsafe event should be counted as dropped"
        );
    }

    #[tokio::test]
    async fn capture_listener_dedupes_persisted_capture_paths_deterministically() {
        let (state, _mock) = test_state(95, 0).await;
        let listener = CaptureListener::start(&state, "session-dedupe");
        // Pre-create the on-disk PNGs so the validator can decode them.
        let project = crate::store::project_dir(&state.projects_root, "starter").unwrap();
        for (path, red) in [
            ("reports/walk/frame.png", 30),
            ("reports/walk/other.png", 90),
        ] {
            let full = project.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            let image = image::RgbImage::from_pixel(8, 8, image::Rgb([red, 100, 220]));
            let mut cursor = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgb8(image)
                .write_to(&mut cursor, image::ImageFormat::Png)
                .unwrap();
            std::fs::write(&full, cursor.into_inner()).unwrap();
        }

        // Same path written three times with three different contents.
        // The listener must retain every event and the composer must dedupe
        // by path keeping the LAST entry in sequence order so the merged
        // set matches what is currently on disk.
        let _ = state.bus.send(persisted_event(
            "session-dedupe",
            "reports/walk/frame.png",
            "sha-first",
            100,
            100,
        ));
        let _ = state.bus.send(persisted_event(
            "session-dedupe",
            "reports/walk/other.png",
            "sha-other",
            200,
            150,
        ));
        let _ = state.bus.send(persisted_event(
            "session-dedupe",
            "reports/walk/frame.png",
            "sha-latest",
            300,
            200,
        ));

        let buffer = listener.finish().await;
        assert_eq!(
            buffer.persisted_captures.len(),
            3,
            "listener must retain every event; dedupe happens at compose time"
        );

        // Hand-build the post-listener buffer the composer consumes. We
        // also need a single capture_frame so compose_attempt_evidence is
        // willing to run; the dedupe assertions only care about the
        // persisted side.
        let mut manual = CaptureBuffer::default();
        manual.frames.push(CapturedFrame {
            finished_at_ms: Some(0),
            sequence: 1,
            data_url: capture_data_url(10),
        });
        manual.persisted_captures = buffer.persisted_captures.clone();

        let graph = bound_two_node_graph(&state);
        let merged = compose_attempt_evidence(&state, &graph, "build", 1, manual)
            .await
            .expect("manual buffer should still produce a sheet");
        assert_eq!(
            merged.persisted_count, 2,
            "three events on two paths dedupe to two unique paths"
        );
        // Order: contact sheet first, then persisted paths in sequence
        // order — other.png (seq 2) before frame.png (seq 3).
        let other_idx = merged
            .relative_paths
            .iter()
            .position(|path| path == "reports/walk/other.png")
            .expect("other.png must survive dedupe");
        let frame_idx = merged
            .relative_paths
            .iter()
            .position(|path| path == "reports/walk/frame.png")
            .expect("frame.png must survive dedupe");
        assert!(
            other_idx < frame_idx,
            "other.png (sequence 2) must precede frame.png (sequence 3) in the merged list: {:?}",
            merged.relative_paths
        );
    }

    // ---- engine integration (stub model over HTTP, like agent.rs tests) ----

    use axum::response::sse::{Event, Sse};
    use axum::routing::post;
    use axum::Router;
    use std::convert::Infallible;
    use std::sync::atomic::AtomicUsize;

    #[derive(Clone)]
    struct MockState {
        judge_calls: Arc<AtomicUsize>,
        judge_first_score: u32,
        requests: Arc<std::sync::Mutex<Vec<Value>>>,
        delay_ms: u64,
        /// Model calls currently inside the provider's delay window.
        in_flight: Arc<AtomicUsize>,
        /// High-water mark of `in_flight` — the overlap proof for the
        /// parallel-wave tests (>= 2 means two calls interleaved in time).
        max_in_flight: Arc<AtomicUsize>,
    }

    fn sse_reply(content: &str) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let payload =
            json!({ "choices": [{ "delta": { "role": "assistant", "content": content } }] });
        Sse::new(futures::stream::iter(vec![
            Ok(Event::default().data(payload.to_string())),
            Ok(Event::default().data("[DONE]")),
        ]))
    }

    fn capture_data_url(red: u8) -> String {
        let image = image::RgbImage::from_pixel(16, 16, image::Rgb([red, 20, 30]));
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
        )
    }

    async fn mock_provider(
        axum::extract::State(mock): axum::extract::State<MockState>,
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        mock.requests.lock().unwrap().push(body.clone());
        let concurrent = mock
            .in_flight
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        mock.max_in_flight
            .fetch_max(concurrent, std::sync::atomic::Ordering::SeqCst);
        if mock.delay_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(mock.delay_ms)).await;
        }
        mock.in_flight
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        // The judge is recognized by its dedicated system prompt ("JUDGE",
        // once the integrator lands spawn_subagent's `system` passthrough) or
        // by the legacy role blurb ("critic" today) — the test passes in both
        // worlds.
        let system = body["messages"][0]["content"].as_str().unwrap_or("");
        if system.contains("MONITOR") {
            sse_reply(r#"{"pass": true, "notes": []}"#)
        } else if system.contains("JUDGE") || system.contains("critic") {
            let call = mock
                .judge_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let score = if call == 0 {
                mock.judge_first_score
            } else {
                95
            };
            sse_reply(&format!(
                r#"{{"score": {score}, "summary": "verdict", "punch_list": ["fix the lighting"]}}"#
            ))
        } else {
            sse_reply("built it; wrote arena.md; captured a frame; tests green")
        }
    }

    async fn test_state(judge_first_score: u32, delay_ms: u64) -> (crate::AppState, MockState) {
        let mock = MockState {
            judge_calls: Arc::new(AtomicUsize::new(0)),
            judge_first_score,
            requests: Arc::new(std::sync::Mutex::new(Vec::new())),
            delay_ms,
            in_flight: Arc::new(AtomicUsize::new(0)),
            max_in_flight: Arc::new(AtomicUsize::new(0)),
        };
        let app = Router::new()
            .route("/v1/chat/completions", post(mock_provider))
            .with_state(mock.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        // `..Default::default()` so config fields added by other modules
        // (mcp servers, skills, ...) never break this test's initializer.
        let config = crate::config::AppConfig {
            model: crate::config::ModelConfig {
                default: "mock".into(),
                provider: "mock".into(),
                base_url: format!("http://{}/v1", addr),
                api_key_env: "CALI_MOCK_KEY".into(),
                temperature: 0.0,
                max_tokens: Some(128),
            },
            ..Default::default()
        };
        let (bus, _) = tokio::sync::broadcast::channel(256);
        let agents = crate::agent::AgentManager::new(bus.clone());
        let state = crate::AppState {
            config: Arc::new(tokio::sync::RwLock::new(config)),
            projects_root: tempfile::tempdir().unwrap().keep(),
            sessions_root: tempfile::tempdir().unwrap().keep().join("sessions"),
            agents,
            bus: bus.clone(),
            workspaces: Arc::new(tokio::sync::RwLock::new(crate::workspace::Registry::new())),
            dev_servers: Arc::new(tokio::sync::RwLock::new(crate::devserver::Servers::new())),
            shutdown: Arc::new(tokio::sync::watch::channel(false).0),
            tools: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            editor_bridge: crate::editor_bridge::EditorBridge::new(bus.clone()),
            editor_attachment: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            graphs: GraphManager::new(),
            mcp: Arc::new(crate::mcp::McpManager::default()),
            asset_catalog: Arc::new(tokio::sync::RwLock::new(Vec::new())),
        };
        crate::store::create_project(&state.projects_root, "starter", "Starter").unwrap();
        std::fs::create_dir_all(&state.sessions_root).unwrap();
        let workspace = tempfile::tempdir().unwrap().keep();
        crate::sessions::save(
            &state.sessions_root,
            &json!({
                "id": "session-graph-owner",
                "projectSlug": "starter",
                "workspaceRoot": workspace.to_string_lossy(),
                "messages": [],
            }),
        )
        .unwrap();
        (state, mock)
    }

    fn bind_test_graph(state: &crate::AppState, graph: &mut TaskGraph) {
        let owner = crate::sessions::load(&state.sessions_root, "session-graph-owner").unwrap();
        graph.owner_session = Some("session-graph-owner".into());
        graph.workspace_root = owner["workspaceRoot"].as_str().map(str::to_string);
        graph.project_slug = Some("starter".into());
    }

    fn two_node_graph() -> TaskGraph {
        graph_with(vec![
            build_node("build", &[]),
            judge_node_def("judge", &["build"]),
        ])
    }

    fn bound_two_node_graph(state: &crate::AppState) -> TaskGraph {
        let mut graph = two_node_graph();
        bind_test_graph(state, &mut graph);
        graph
    }

    #[tokio::test]
    async fn run_drives_a_graph_to_complete() {
        let (state, _mock) = test_state(95, 0).await;
        let root = graphs_root(&state.sessions_root);
        let graph = bound_two_node_graph(&state);
        save(&root, &graph).unwrap();

        let result = run(&state, &graph.graph_id, None).await.unwrap();
        assert_eq!(result["status"], "complete");
        assert_eq!(result["passed"], 2);
        assert_eq!(result["failed"], 0);

        let saved = load(&root, &graph.graph_id).unwrap();
        assert_eq!(saved.status, GraphStatus::Complete);
        assert_eq!(saved.nodes[0].status, NodeStatus::Passed);
        assert_eq!(saved.nodes[1].score, Some(95));
        assert!(saved.nodes[0].session_id.is_some());
        assert!(saved.nodes[0]
            .last_report
            .as_deref()
            .unwrap()
            .contains("built it"));
    }

    #[tokio::test]
    async fn graph_reasoning_effort_reaches_build_monitor_and_judge() {
        let (state, mock) = test_state(95, 0).await;
        let root = graphs_root(&state.sessions_root);
        let mut graph = bound_two_node_graph(&state);
        graph.reasoning_effort = Some("max".into());
        save(&root, &graph).unwrap();

        let result = run(&state, &graph.graph_id, None).await.unwrap();
        assert_eq!(result["status"], "complete");

        let requests = mock.requests.lock().unwrap();
        assert!(
            requests.len() >= 3,
            "expected build, monitor, and judge requests: {}",
            requests.len()
        );
        for body in requests.iter() {
            assert_eq!(
                body["reasoning_effort"], "max",
                "missing graph effort in request: {body}"
            );
        }
    }

    #[tokio::test]
    async fn node_started_persists_the_reserved_session_first() {
        let (state, _mock) = test_state(95, 100).await;
        let root = graphs_root(&state.sessions_root);
        let graph = bound_two_node_graph(&state);
        let graph_id = graph.graph_id.clone();
        save(&root, &graph).unwrap();
        let mut rx = state.bus.subscribe();

        let observed = tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                if event["type"] == "graph.updated"
                    && event["phase"] == "node_started"
                    && event["nodeId"] == "build"
                {
                    return event["graph"]["nodes"][0]["sessionId"]
                        .as_str()
                        .expect("node_started must expose the reserved session")
                        .to_string();
                }
            }
            panic!("node_started event missing")
        });

        run(&state, &graph_id, None).await.unwrap();
        let session_id = observed.await.unwrap();
        let saved = load(&root, &graph_id).unwrap();
        assert_eq!(
            saved.nodes[0].session_id.as_deref(),
            Some(session_id.as_str())
        );
    }

    #[tokio::test]
    async fn graph_binding_is_loaded_from_the_owner_session() {
        let (state, _mock) = test_state(95, 0).await;
        let workspace = tempfile::tempdir().unwrap();
        let owner = crate::sessions::create(
            &state.sessions_root,
            &json!({
                "projectSlug": "starter",
                "workspaceRoot": workspace.path().to_string_lossy(),
            }),
        )
        .unwrap();
        let owner_id = owner["id"].as_str().unwrap();
        let planned = plan_tool(
            &state,
            &json!({
                "goal": "arena slice",
                "slug": "starter",
                "template": "aaa-fps",
                "ownerSession": owner_id,
                "workspaceRoot": workspace.path().join(".").to_string_lossy()
            }),
        )
        .await
        .unwrap();

        assert_eq!(planned["ownerSession"], owner_id);
        assert_eq!(
            Path::new(planned["workspaceRoot"].as_str().unwrap()),
            workspace.path().canonicalize().unwrap()
        );
    }

    #[tokio::test]
    async fn graph_binding_refuses_mismatched_owner_or_workspace() {
        let (state, _mock) = test_state(95, 0).await;
        let workspace = tempfile::tempdir().unwrap();
        let foreign = tempfile::tempdir().unwrap();
        let owner = crate::sessions::create(
            &state.sessions_root,
            &json!({
                "projectSlug": "starter",
                "workspaceRoot": workspace.path().to_string_lossy(),
            }),
        )
        .unwrap();
        let owner_id = owner["id"].as_str().unwrap();

        let error = plan_tool(
            &state,
            &json!({
                "goal": "arena slice",
                "slug": "starter",
                "template": "aaa-fps",
                "ownerSession": owner_id,
                "workspaceRoot": foreign.path().to_string_lossy()
            }),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("does not match"), "{error}");

        let error = plan_tool(
            &state,
            &json!({
                "goal": "arena slice",
                "slug": "other",
                "template": "aaa-fps",
                "ownerSession": owner_id,
                "workspaceRoot": workspace.path().to_string_lossy()
            }),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("different project"), "{error}");
    }

    #[tokio::test]
    async fn judge_rejection_requeues_builders_with_the_punch_list() {
        let (state, mock) = test_state(40, 0).await;
        let root = graphs_root(&state.sessions_root);
        let graph = bound_two_node_graph(&state);
        save(&root, &graph).unwrap();

        let result = run(&state, &graph.graph_id, None).await.unwrap();
        assert_eq!(result["status"], "complete");

        let saved = load(&root, &graph.graph_id).unwrap();
        // Builder ran twice: once fresh, once re-queued by the judge.
        assert_eq!(saved.nodes[0].attempts, 2);
        assert_eq!(saved.nodes[1].attempts, 2);
        assert_eq!(saved.nodes[1].score, Some(95));
        assert!(saved.nodes[0].punch_list.is_empty(), "cleared on pass");

        // The re-queued builder was handed the judge's punch list verbatim.
        let requests = mock.requests.lock().unwrap();
        let second_build = requests
            .iter()
            .filter(|body| {
                // A build request is whatever is neither monitor nor judge —
                // matching the mock's own routing.
                body["messages"][0]["content"]
                    .as_str()
                    .is_some_and(|system| {
                        !system.contains("MONITOR")
                            && !system.contains("JUDGE")
                            && !system.contains("critic")
                    })
            })
            .nth(1)
            .expect("two build requests");
        let user = second_build["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["role"] == "user")
            .unwrap();
        let content = user["content"].as_str().unwrap();
        assert!(content.contains("REJECTED"), "{content}");
        assert!(content.contains("fix the lighting"), "{content}");
    }

    #[tokio::test]
    async fn monitor_and_judge_attach_the_contact_sheet() {
        // 150ms of provider delay keeps the build attempt in flight long
        // enough for the injected capture event to be polled by the listener.
        let (state, mock) = test_state(95, 150).await;
        let root = graphs_root(&state.sessions_root);
        let graph = bound_two_node_graph(&state);
        save(&root, &graph).unwrap();

        let frame = capture_data_url(200);
        let injected_frame = frame.clone();
        let bus = state.bus.clone();
        let mut rx = state.bus.subscribe();
        let injector = tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                // Captures are scoped to the worker's own subagent session,
                // so the injected frame must carry that session's id. The
                // first agent.delta of the run belongs to the build worker
                // (the monitor is a session-less model::chat) and streams
                // while the attempt is still in flight — the engine's
                // capture listener subscribed before node_started, so the
                // send below lands inside its window.
                if event["type"] == "agent.delta" {
                    let _ = bus.send(json!({
                        "type": "agent.tool_finished",
                        "sessionId": event["sessionId"],
                        "tool": "editor_capture_frame",
                        "finishedAtMs": 1000,
                        "result": { "dataUrl": injected_frame }
                    }));
                    return;
                }
            }
        });

        let result = run(&state, &graph.graph_id, None).await.unwrap();
        injector.await.unwrap();
        assert_eq!(result["status"], "complete");

        let requests = mock.requests.lock().unwrap();
        let system_of = |body: &Value| {
            body["messages"][0]["content"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        };

        // The MONITOR call carries the worker's contact sheet as an image part.
        let monitor = requests
            .iter()
            .find(|body| system_of(body).contains("MONITOR"))
            .expect("monitor request");
        let parts = monitor["messages"][1]["content"]
            .as_array()
            .expect("monitor user content is multimodal");
        let monitor_text = parts[0]["text"].as_str().unwrap();
        assert!(monitor_text.contains("WORKER REPORT"));
        assert!(monitor_text.contains("core captured 1 valid frame"));
        assert!(monitor_text.contains("reports/video/"));
        assert!(monitor_text.contains("project-relative paths"));
        let monitor_sheet = parts[1]["image_url"]["url"].as_str().unwrap();
        assert!(monitor_sheet.starts_with("data:image/png;base64,"));
        assert_ne!(monitor_sheet, frame);

        // The JUDGE critic sees the same pixels in its first message.
        let judge = requests
            .iter()
            .find(|body| system_of(body).contains("JUDGE"))
            .expect("judge request");
        assert!(
            system_of(judge).contains("contact sheet"),
            "system tells the judge an image is attached"
        );
        let user = judge["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["role"] == "user")
            .expect("judge user message");
        let parts = user["content"]
            .as_array()
            .expect("judge user content is multimodal");
        assert_eq!(parts[2]["image_url"]["url"], monitor_sheet);

        let saved = load(&root, &graph.graph_id).unwrap();
        assert_eq!(saved.nodes[0].evidence_count, 1);
        assert_eq!(saved.nodes[0].evidence_attempt, Some(1));
        assert_eq!(saved.nodes[0].evidence_paths.len(), 2);
        assert!(saved.nodes[0]
            .evidence_paths
            .iter()
            .all(|path| !path.contains("base64") && !Path::new(path).is_absolute()));
    }

    #[test]
    fn judge_system_prompt_labels_own_node_evidence_paths_as_authoritative() {
        // The judge system prompt must name THIS node's own engine-attested
        // evidence paths as authoritative visual evidence. Without that,
        // a verdict claiming the attempt was evidence-less could pass
        // without contradicting any prompt sentence the model saw.
        let mut graph = judge_node_def("critic", &["build"]);
        graph.reference = Some("DOOM Eternal arena flow".into());
        graph.evidence_count = 4;
        graph.evidence_paths = vec![
            "reports/video/critic.png".into(),
            "reports/video/critic.manifest.json".into(),
        ];
        graph.evidence_attempt = Some(2);
        let system = judge_system_prompt(&graph, graph.reference.as_deref().unwrap(), &[]);
        assert!(
            system.contains("Engine-attested evidence for THIS attempt on node `critic`"),
            "system prompt must name this node's evidence block: {system}"
        );
        assert!(
            system.contains("4 frame(s)"),
            "system prompt must enumerate the frame count: {system}"
        );
        for path in &graph.evidence_paths {
            assert!(
                system.contains(path),
                "system prompt must list the engine-attested path {path}: {system}"
            );
        }
        assert!(
            system.contains("attempt 2"),
            "system prompt must name the producing attempt: {system}"
        );
        // No dep sheets, so the worktree-glob warning stays out of the
        // system prompt — the per-attempt evidence block is enough.
        assert!(
            !system.contains("AUTHORITATIVE; do not invalidate them by globbing"),
            "worktree-glob warning must only appear when dep sheets are attached: {system}"
        );
    }

    #[test]
    fn judge_system_prompt_authority_warning_appears_when_dep_sheets_attached() {
        // When dep sheets are attached, the system prompt must also
        // explicitly forbid invalidating them via workspace file_glob.
        let mut graph = judge_node_def("critic", &["build"]);
        graph.evidence_count = 1;
        graph.evidence_paths = vec!["reports/video/critic.png".into()];
        let system = judge_system_prompt(
            &graph,
            graph.reference.as_deref().unwrap(),
            &[(
                "build".to_string(),
                "data:image/png;base64,AAAA".to_string(),
            )],
        );
        assert!(
            system.contains("AUTHORITATIVE"),
            "authority label must appear when dep sheets are attached: {system}"
        );
        assert!(
            system.contains("do not invalidate them by globbing the bound worktree"),
            "worktree-glob warning must appear when dep sheets are attached: {system}"
        );
    }

    #[tokio::test]
    async fn judge_receives_all_dependency_sheets_in_stable_order() {
        let (state, mock) = test_state(95, 0).await;
        let mut graph = graph_with(vec![
            build_node("zeta", &[]),
            build_node("alpha", &[]),
            judge_node_def("judge", &["zeta", "alpha"]),
        ]);
        bind_test_graph(&state, &mut graph);
        let sheets = HashMap::from([
            ("zeta".to_string(), capture_data_url(200)),
            ("alpha".to_string(), capture_data_url(10)),
        ]);
        let dependency_sheets = dependency_sheets(&graph, 2, &sheets);
        let session_id = state.agents.reserve_session().await.unwrap();
        let result = spawn_critic_with_frames(
            &state,
            &graph,
            "JUDGE",
            "inspect the result",
            &dependency_sheets,
            &session_id,
        )
        .await
        .unwrap();
        assert_eq!(result["sessionId"], session_id);

        let requests = mock.requests.lock().unwrap();
        let body = requests
            .iter()
            .find(|body| body["messages"][0]["content"] == "JUDGE")
            .expect("judge request");
        let parts = body["messages"][1]["content"]
            .as_array()
            .expect("judge content is multimodal");
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[1]["text"], "Build dependency `alpha` contact sheet:");
        assert_eq!(parts[3]["text"], "Build dependency `zeta` contact sheet:");
        assert_eq!(
            parts[2]["image_url"]["url"],
            dependency_sheets[0].1.as_str()
        );
        assert_eq!(
            parts[4]["image_url"]["url"],
            dependency_sheets[1].1.as_str()
        );
    }

    #[tokio::test]
    async fn capture_from_a_foreign_session_is_ignored() {
        // Same shape as the attach test, but the frame arrives tagged with a
        // session id that is not the worker's — a concurrent user chat or
        // another graph's run. It must never become this node's evidence.
        let (state, mock) = test_state(95, 150).await;
        let root = graphs_root(&state.sessions_root);
        let graph = bound_two_node_graph(&state);
        save(&root, &graph).unwrap();

        let frame = capture_data_url(10);
        let bus = state.bus.clone();
        let mut rx = state.bus.subscribe();
        let injector = tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                if event["type"] == "graph.updated"
                    && event["phase"] == "node_started"
                    && event["nodeId"] == "build"
                {
                    // Sent inside the capture listener's window (it
                    // subscribed before node_started went out), so the only
                    // reason it can be absent from the monitor call is the
                    // session filter.
                    let _ = bus.send(json!({
                        "type": "agent.tool_finished",
                        "sessionId": "session-someoneelse",
                        "tool": "editor_capture_frame",
                        "result": { "dataUrl": frame }
                    }));
                    return;
                }
            }
        });

        let result = run(&state, &graph.graph_id, None).await.unwrap();
        injector.await.unwrap();
        assert_eq!(result["status"], "complete");

        // The foreign frame was dropped, so every message in every request
        // stays a plain string — same as when no capture happened at all.
        let requests = mock.requests.lock().unwrap();
        assert!(!requests.is_empty());
        for body in requests.iter() {
            for message in body["messages"].as_array().unwrap() {
                assert!(
                    message["content"].is_string(),
                    "foreign-session frame leaked into a model call: {message}"
                );
            }
        }
    }

    #[tokio::test]
    async fn monitor_and_judge_fall_back_to_text_without_a_capture() {
        let (state, mock) = test_state(95, 0).await;
        let root = graphs_root(&state.sessions_root);
        let graph = bound_two_node_graph(&state);
        save(&root, &graph).unwrap();

        let result = run(&state, &graph.graph_id, None).await.unwrap();
        assert_eq!(result["status"], "complete");

        // No capture happened, so every message in every request stays a
        // plain string — the pre-vision behaviour.
        let requests = mock.requests.lock().unwrap();
        assert!(!requests.is_empty());
        for body in requests.iter() {
            for message in body["messages"].as_array().unwrap() {
                assert!(
                    message["content"].is_string(),
                    "unexpected multimodal content: {message}"
                );
            }
        }
    }

    #[tokio::test]
    async fn run_bails_when_graph_is_already_running() {
        let (state, _mock) = test_state(95, 0).await;
        let root = graphs_root(&state.sessions_root);
        let graph = bound_two_node_graph(&state);
        save(&root, &graph).unwrap();

        let _flag = state.graphs.begin(&graph.graph_id).await.unwrap();
        let error = run(&state, &graph.graph_id, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("already running"), "{error}");
    }

    #[tokio::test]
    async fn run_recovers_a_persisted_in_flight_build_after_restart() {
        let (state, _mock) = test_state(95, 0).await;
        let root = graphs_root(&state.sessions_root);
        let mut graph = bound_two_node_graph(&state);
        graph.status = GraphStatus::Running;
        graph.nodes[0].status = NodeStatus::Monitoring;
        graph.nodes[0].attempts = 1;
        graph.nodes[0].session_id = Some("session-from-dead-core".into());
        save(&root, &graph).unwrap();

        let mut events = state.bus.subscribe();
        let result = run(&state, &graph.graph_id, None).await.unwrap();
        assert_eq!(result["status"], "complete");

        let recovered = events.recv().await.unwrap();
        assert_eq!(recovered["phase"], "recovered");
        assert_eq!(recovered["extra"]["nodes"][0], "build");
        let saved = load(&root, &graph.graph_id).unwrap();
        assert_eq!(saved.nodes[0].status, NodeStatus::Passed);
        assert_eq!(saved.nodes[0].attempts, 2);
        assert!(saved.nodes[0]
            .punch_list
            .iter()
            .all(|note| !note.contains("core stopped")));
    }

    #[tokio::test]
    async fn run_refuses_to_resume_a_cancelled_graph() {
        let (state, _mock) = test_state(95, 0).await;
        let root = graphs_root(&state.sessions_root);
        let mut graph = bound_two_node_graph(&state);
        graph.status = GraphStatus::Cancelled;
        graph.nodes[0].status = NodeStatus::Running;
        graph.nodes[0].attempts = 1;
        save(&root, &graph).unwrap();

        let error = run(&state, &graph.graph_id, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("is cancelled"), "{error}");
        let saved = load(&root, &graph.graph_id).unwrap();
        assert_eq!(saved.status, GraphStatus::Cancelled);
        assert_eq!(saved.nodes[0].status, NodeStatus::Running);
        assert!(!state.graphs.is_running(&graph.graph_id).await);
    }

    #[tokio::test]
    async fn run_refuses_a_legacy_unbound_graph_with_an_actionable_error() {
        let (state, _mock) = test_state(95, 0).await;
        let root = graphs_root(&state.sessions_root);
        let graph = two_node_graph();
        save(&root, &graph).unwrap();

        let error = run(&state, &graph.graph_id, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("owner session and workspace"), "{error}");
        assert!(
            !state.graphs.is_running(&graph.graph_id).await,
            "binding validation must happen before the run is registered"
        );
        assert_eq!(
            status(&state, &json!({ "graphId": graph.graph_id })).unwrap()["graphId"],
            graph.graph_id
        );
    }

    #[tokio::test]
    async fn cancel_stops_the_run_between_nodes() {
        // The provider sleeps 150ms per call, so cancelling on the first
        // node_started event lands while node 1 is in flight — the loop-top
        // check then stops the graph before node 2 starts.
        let (state, _mock) = test_state(95, 150).await;
        let root = graphs_root(&state.sessions_root);
        let mut graph = graph_with(vec![
            build_node("one", &[]),
            build_node("two", &["one"]),
            judge_node_def("judge", &["two"]),
        ]);
        bind_test_graph(&state, &mut graph);
        save(&root, &graph).unwrap();

        let mut rx = state.bus.subscribe();
        let graphs = state.graphs.clone();
        let graph_id = graph.graph_id.clone();
        let canceller = tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                if event["type"] == "graph.updated" && event["phase"] == "node_started" {
                    assert!(graphs.cancel(&graph_id).await);
                    return;
                }
            }
        });

        let result = run(&state, &graph.graph_id, None).await.unwrap();
        canceller.await.unwrap();
        assert_eq!(result["status"], "cancelled");

        let saved = load(&root, &graph.graph_id).unwrap();
        assert_eq!(saved.status, GraphStatus::Cancelled);
        assert_eq!(saved.nodes[1].attempts, 0, "node two never started");
        assert!(!state.graphs.is_running(&graph.graph_id).await);
    }

    // ---- parallel waves ----

    #[tokio::test]
    async fn independent_build_nodes_run_concurrently() {
        // Two dep-free Build nodes form one wave. Each provider call sleeps
        // 150ms, so the mock's in-flight high-water mark can only reach 2 if
        // the two workers' model calls overlapped in time.
        let (state, mock) = test_state(95, 150).await;
        let root = graphs_root(&state.sessions_root);
        let mut graph = graph_with(vec![
            build_node("x", &[]),
            build_node("y", &[]),
            judge_node_def("judge", &["x", "y"]),
        ]);
        bind_test_graph(&state, &mut graph);
        save(&root, &graph).unwrap();

        let result = run(&state, &graph.graph_id, None).await.unwrap();
        assert_eq!(result["status"], "complete");
        assert_eq!(result["passed"], 3);

        let saved = load(&root, &graph.graph_id).unwrap();
        assert_eq!(saved.nodes[0].attempts, 1);
        assert_eq!(saved.nodes[1].attempts, 1);
        assert!(
            mock.max_in_flight.load(std::sync::atomic::Ordering::SeqCst) >= 2,
            "the two build workers never overlapped"
        );
    }

    #[tokio::test]
    async fn build_wave_is_capped_at_max_parallel_nodes() {
        // Four dep-free Build nodes, but a wave admits at most
        // MAX_PARALLEL_NODES — and each worker runs one model call at a time,
        // so provider concurrency can never exceed the cap either.
        let (state, mock) = test_state(95, 150).await;
        let root = graphs_root(&state.sessions_root);
        let mut graph = graph_with(vec![
            build_node("a", &[]),
            build_node("b", &[]),
            build_node("c", &[]),
            build_node("d", &[]),
            judge_node_def("judge", &["a", "b", "c", "d"]),
        ]);
        bind_test_graph(&state, &mut graph);
        save(&root, &graph).unwrap();

        let result = run(&state, &graph.graph_id, None).await.unwrap();
        assert_eq!(result["status"], "complete");
        assert_eq!(result["passed"], 5);

        let max = mock.max_in_flight.load(std::sync::atomic::Ordering::SeqCst);
        assert!(max >= 2, "wave siblings never overlapped");
        assert!(max <= MAX_PARALLEL_NODES, "wave exceeded the cap: {max}");
    }

    #[tokio::test]
    async fn cancel_finishes_the_wave_then_stops_before_the_next() {
        // Cancel lands while the first wave (two independent builds) is in
        // flight: both started attempts run to completion, but the judge —
        // the next wave — never starts.
        let (state, mock) = test_state(95, 150).await;
        let root = graphs_root(&state.sessions_root);
        let mut graph = graph_with(vec![
            build_node("x", &[]),
            build_node("y", &[]),
            judge_node_def("judge", &["x", "y"]),
        ]);
        bind_test_graph(&state, &mut graph);
        save(&root, &graph).unwrap();

        let mut rx = state.bus.subscribe();
        let graphs = state.graphs.clone();
        let graph_id = graph.graph_id.clone();
        let canceller = tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                if event["type"] == "graph.updated" && event["phase"] == "node_started" {
                    assert!(graphs.cancel(&graph_id).await);
                    return;
                }
            }
        });

        let result = run(&state, &graph.graph_id, None).await.unwrap();
        canceller.await.unwrap();
        assert_eq!(result["status"], "cancelled");

        let saved = load(&root, &graph.graph_id).unwrap();
        assert_eq!(saved.status, GraphStatus::Cancelled);
        // Wave setup is synchronous, so both builds were already started when
        // the cancel flag rose; their attempts resolved.
        assert_eq!(saved.nodes[0].attempts, 1);
        assert_eq!(saved.nodes[1].attempts, 1);
        assert_eq!(saved.nodes[2].attempts, 0, "judge never started");
        assert_eq!(
            mock.judge_calls.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert!(!state.graphs.is_running(&graph.graph_id).await);
    }

    #[tokio::test]
    async fn judge_never_shares_a_wave_with_a_ready_build() {
        // After `a` passes, `b` (build) and `judge` are ready together — a
        // mixed set. The wave degrades to just `b`, and the judge then runs
        // alone, so no two model calls ever overlap in this graph.
        let (state, mock) = test_state(95, 100).await;
        let root = graphs_root(&state.sessions_root);
        let mut graph = graph_with(vec![
            build_node("a", &[]),
            build_node("b", &["a"]),
            judge_node_def("judge", &["a"]),
        ]);
        bind_test_graph(&state, &mut graph);
        save(&root, &graph).unwrap();

        let result = run(&state, &graph.graph_id, None).await.unwrap();
        assert_eq!(result["status"], "complete");
        assert_eq!(result["passed"], 3);

        let saved = load(&root, &graph.graph_id).unwrap();
        assert_eq!(saved.nodes[2].attempts, 1);
        assert_eq!(
            mock.max_in_flight.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the judge (or the mixed-wave build) overlapped another call"
        );
    }

    #[tokio::test]
    async fn plan_tool_saves_and_status_reads_back() {
        let (state, _mock) = test_state(95, 0).await;
        let owner = crate::sessions::load(&state.sessions_root, "session-graph-owner").unwrap();
        let planned = plan_tool(
            &state,
            &json!({
                "goal": "arena slice",
                "slug": "starter",
                "template": "aaa-fps",
                "ownerSession": "session-graph-owner",
                "workspaceRoot": owner["workspaceRoot"],
            }),
        )
        .await
        .unwrap();
        let graph_id = planned["graphId"].as_str().unwrap();
        assert_eq!(planned["status"], "planning");
        assert!(planned["nodes"].as_array().unwrap().len() >= 5);

        let read = status(&state, &json!({ "graphId": graph_id })).unwrap();
        assert_eq!(read["graphId"], graph_id);

        let listed = list_tool(&state, &json!({})).unwrap();
        assert_eq!(listed["graphs"].as_array().unwrap().len(), 1);
        let listed_all = list_tool(&state, &json!({})).unwrap();
        assert_eq!(listed_all["graphs"].as_array().unwrap().len(), 1);
        let listed_other = list_tool(&state, &json!({ "slug": "nope" })).unwrap();
        assert_eq!(listed_other["graphs"].as_array().unwrap().len(), 0);

        // cancel_tool on a non-running graph reports cancelled: false.
        let cancelled = cancel_tool(&state, &json!({ "graphId": graph_id }))
            .await
            .unwrap();
        assert_eq!(cancelled["cancelled"], false);
    }

    #[tokio::test]
    async fn plan_tool_prefers_explicit_nodes_over_empty_or_stray_template() {
        let nodes = json!([
            { "id": "gameplay", "title": "Gameplay", "kind": "build", "role": "coder",
              "instructions": "build gameplay", "acceptance": ["playable"], "deps": [] },
            { "id": "art", "title": "Art", "kind": "build", "role": "artist",
              "instructions": "build art", "acceptance": ["cohesive"], "deps": [] },
            { "id": "integrate", "title": "Integrate", "kind": "build", "role": "integrator",
              "instructions": "integrate", "acceptance": ["complete"], "deps": ["gameplay", "art"] },
            { "id": "judge", "title": "Judge", "kind": "judge", "role": "critic",
              "instructions": "judge", "acceptance": ["score 90"], "deps": ["integrate"],
              "reference": "Geometry Wars 3", "threshold": 90 }
        ]);

        for template in ["", "arcade-racer"] {
            let (state, _mock) = test_state(95, 0).await;
            let owner = crate::sessions::load(&state.sessions_root, "session-graph-owner").unwrap();
            let planned = plan_tool(
                &state,
                &json!({
                    "goal": "explicit fanout",
                    "slug": "starter",
                    "template": template,
                    "nodes": nodes,
                    "ownerSession": "session-graph-owner",
                    "workspaceRoot": owner["workspaceRoot"],
                    "reasoningEffort": "max",
                }),
            )
            .await
            .unwrap();
            assert_eq!(planned["template"], Value::Null);
            assert_eq!(planned["reasoningEffort"], "max");
            assert_eq!(planned["nodes"].as_array().unwrap().len(), 4);
            assert_eq!(planned["nodes"][0]["id"], "gameplay");
            assert_eq!(planned["nodes"][2]["deps"], json!(["gameplay", "art"]));
        }
    }

    #[tokio::test]
    async fn cancel_tool_unsticks_a_crashed_running_graph() {
        let (state, _mock) = test_state(95, 0).await;
        let root = graphs_root(&state.sessions_root);
        let mut graph = two_node_graph();
        graph.status = GraphStatus::Running; // as left by a crashed core
        save(&root, &graph).unwrap();

        let result = cancel_tool(&state, &json!({ "graphId": graph.graph_id }))
            .await
            .unwrap();
        assert_eq!(result["cancelled"], false);
        let saved = load(&root, &graph.graph_id).unwrap();
        assert_eq!(saved.status, GraphStatus::Cancelled);
    }
}
