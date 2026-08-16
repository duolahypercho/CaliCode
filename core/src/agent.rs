use crate::model::{self, ToolCall};
use crate::tools::{
    core_tool_defs, execute_core_tool_with_activity, take_internal_activity, to_openai_schema,
    ToolDef,
};
use crate::AppState;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

/// Idle sessions above this are evicted when a new one is created.
const MAX_SESSIONS: usize = 32;

/// Turn budget handed to `agent_chat` when the caller names none.
///
/// A turn is one provider request, and the loop already ends the moment the
/// model stops asking for tools — so this is not a task-size budget the user
/// is meant to tune. It exists only so a model stuck in a tool loop cannot
/// bill forever.
pub const DEFAULT_MAX_TURNS: usize = 200;

/// Permission mode handed to `agent_chat` when the caller names none.
///
/// Must stay the *strictest* mode, not a convenient one. The panel always
/// sends a mode explicitly, so the only callers that land on this default are
/// scripts and outside MCP clients — precisely the set that must not be handed
/// full access for staying silent. `permission_mode_default_fails_closed`
/// pins the property rather than the string.
pub const DEFAULT_PERMISSION_MODE: &str = "supervised";

/// Hard ceiling applied to any caller-supplied turn budget.
///
/// Runaway backstop, NOT a product limit: reaching it means the model never
/// converged, which is a bug or a pathological loop, not an ordinary task.
/// Raising a caller's request above this is never useful; lowering the value
/// silently truncates real work, which is the failure this constant replaced.
pub const MAX_TURNS_CEILING: usize = 1000;

/// A single assistant turn may fan out at most this many subagents; spawn
/// calls past the cap fail with an error result instead of forking.
const MAX_SPAWNS_PER_TURN: usize = 8;

/// Backstop on one tool result as it enters the message history.
///
/// A tool result is not paid for once. It sits in `messages` and is re-sent to
/// the model on every following turn until compaction, so an unbounded result
/// is a recurring charge. `file_read` bounds itself far below this (see
/// `crate::fileread`) and so do the search tools; this catches everything that
/// does not — above all MCP tools, whose output comes from a third-party
/// server that has no idea it is spending our context window.
///
/// Deliberately above every core tool's own ceiling: a specific tool should
/// hit its own tight, self-describing cap and explain how to page past it. By
/// the time a result reaches this one, nothing better is available.
const MAX_TOOL_RESULT_BYTES: usize = 192 * 1024;
/// Longest `data:image/...` string kept verbatim in a transcript. Real frames
/// run tens of thousands of characters; this leaves tiny placeholder URLs and
/// schema examples alone.
const MAX_INLINE_IMAGE_CHARS: usize = 512;
/// A drain failure is returned to graph/monitor callers, so keep provider
/// errors bounded even when a gateway returns a very large error body.
const MAX_DRAIN_REASON_CHARS: usize = 512;

/// Finalization directive appended to the schema-less drain call.
///
/// The instruction travels inside the same session-style snapshot the model
/// already saw, so the provider's prompt cache stays warm and the model
/// treats this as a terminal reply, not as another agentic turn. The judge
/// node continues to emit JSON when its system prompt asked for it; the
/// directive only forbids tool calls and provider tags, not JSON itself.
const FINALIZATION_INSTRUCTION: &str = "FINAL RESPONSE ONLY. Do not emit tool calls, tool-call \
     XML, or provider tags. Return the terminal format required by earlier instructions: plain \
     text unless they require JSON. Summarize concrete changes and evidence.";

/// Detects whether a provider returned a textual tool-call protocol inside
/// its `content` field instead of structured `tool_calls`.
///
/// Some providers emit a tool-call wrapper inline instead of a structured
/// call. The streaming parser correctly leaves that untrusted protocol in
/// `content`; the drain must not mistake it for a final report.
///
/// Patterns are plain ASCII so the live artifact matches byte-for-byte;
/// the matcher strips invisible Unicode (U+200B/C/D, U+FEFF) before
/// comparing so the detection still fires when a provider slips in a
/// zero-width space or BOM alongside the markup.
fn content_carries_textual_tool_protocol(content: &str) -> bool {
    let normalized = content
        .chars()
        .filter(|c| !is_invisible_unicode(*c))
        .collect::<String>()
        .to_ascii_lowercase();
    let provider_sentinel = normalized.contains("]<]minimax[>[")
        || normalized.contains("<|minimax|>")
        || normalized.contains("<|tool_call|>");
    let xml_tool_call = normalized.contains("<tool_call>")
        && (normalized.contains("<invoke name=")
            || normalized.contains("<invoke name =")
            || normalized.contains("</tool_call>"));
    provider_sentinel || xml_tool_call
}

/// Invisible Unicode characters that providers occasionally insert to
/// disguise tool-call markup; the matcher strips them so the plain-ASCII
/// patterns still match even when the wire payload is "decorated".
fn is_invisible_unicode(c: char) -> bool {
    matches!(c, '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}')
}

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Some tool-capable gateways occasionally emit `graph_plan({})` even though
/// the schema requires `goal`. Replaying that invalid assistant tool call can
/// make the same gateway reject the next request before it gets a chance to
/// read CaliCode's structured tool error. The latest user turn is the trusted
/// planning objective already in context, so restore only that required field
/// before the call is persisted; every other graph field still goes through
/// normal validation and must be supplied by the model.
fn repair_missing_graph_goal(tool_calls: &mut [ToolCall], messages: &[Value]) {
    let Some(goal) = messages.iter().rev().find_map(|message| {
        if message["role"] != "user" {
            return None;
        }
        message["content"]
            .as_str()
            .map(str::trim)
            .filter(|content| !content.is_empty())
            .map(str::to_string)
    }) else {
        return;
    };
    for call in tool_calls {
        if call.name != "graph_plan" {
            continue;
        }
        if call.arguments.is_null() {
            call.arguments = json!({});
        }
        let Some(arguments) = call.arguments.as_object_mut() else {
            continue;
        };
        let missing = arguments
            .get("goal")
            .and_then(Value::as_str)
            .map(str::trim)
            .is_none_or(str::is_empty);
        if missing {
            arguments.insert("goal".into(), json!(goal));
        }
    }
}

/// Add routing fields from trusted session state before a tool call is
/// recorded or executed. This keeps provider replay and the public tool-call
/// log aligned with what core actually dispatched, while preventing a model
/// from redirecting graph/report writes to a different project or loop.
fn bind_trusted_call_context(
    tool: &str,
    arguments: &mut Value,
    options: &AgentOptions,
    session_id: &str,
) {
    if tool == "graph_plan" {
        let Some(object) = arguments.as_object_mut() else {
            return;
        };
        let root_session = options.approval_session.as_deref().unwrap_or(session_id);
        object.insert("ownerSession".into(), json!(root_session));
        if let Some(project_slug) = options.project_slug.as_deref() {
            object.insert("slug".into(), json!(project_slug));
        }
        if let Some(workspace_root) = options.workspace_root.as_deref() {
            object.insert("workspaceRoot".into(), json!(workspace_root));
        }
        if let Some(reasoning_effort) = options.reasoning_effort.as_deref() {
            object.insert("reasoningEffort".into(), json!(reasoning_effort));
        }
        return;
    }
    if !matches!(
        tool,
        "loop_report_start" | "loop_report_iteration" | "loop_report_update" | "loop_report_open"
    ) {
        return;
    }
    if !arguments.is_object() {
        *arguments = json!({});
    }
    let Some(object) = arguments.as_object_mut() else {
        return;
    };
    if let Some(project_slug) = options.project_slug.as_deref() {
        object.insert("slug".into(), json!(project_slug));
    }
    if let Some(loop_id) = options.loop_id.as_deref() {
        object.insert("loopId".into(), json!(loop_id));
    }
}

/// Serialise `outcome` for the message history, bounded by
/// `MAX_TOOL_RESULT_BYTES`.
///
/// The overflow form stays valid JSON. Handing the model a JSON document cut
/// off mid-string would cost it a turn to discover the result is unparseable,
/// on top of the turn that produced it.
/// Replace base64 image payloads with a receipt, returning how many were cut.
///
/// A captured frame belongs to core, not to the conversation: core harvests it
/// from the tool event for the contact sheet the monitor and judge actually
/// look at, so the copy sitting in the transcript is read by nobody and costs
/// three ways — it is re-sent on every later turn of that agent, it evicts the
/// provider's cached prefix, and it can be most of the context window. One
/// measured node turn carried 220,229 base64 characters in a 264,264-character
/// request, and prefix reuse for that call fell to 16% from a 99% median.
fn elide_image_payloads(value: &mut Value) -> usize {
    match value {
        Value::String(text) => {
            if text.starts_with("data:image/") && text.len() > MAX_INLINE_IMAGE_CHARS {
                let bytes = text.len();
                *text = format!(
                    "<image elided: {bytes} base64 chars. Core already captured this frame as                      evidence; persist one with editor_persist_capture(path) instead of moving                      pixels through this conversation.>"
                );
                return 1;
            }
            0
        }
        Value::Array(items) => items.iter_mut().map(elide_image_payloads).sum(),
        Value::Object(fields) => fields.values_mut().map(elide_image_payloads).sum(),
        _ => 0,
    }
}

fn bound_tool_result(tool: &str, outcome: &Value, spill_dir: Option<&std::path::Path>) -> String {
    let mut elided = outcome.clone();
    let cut = elide_image_payloads(&mut elided);
    let outcome = if cut > 0 { &elided } else { outcome };
    let text = outcome.to_string();
    if text.len() <= MAX_TOOL_RESULT_BYTES {
        return text;
    }
    let preview = String::from_utf8_lossy(utf8_prefix(text.as_bytes(), MAX_TOOL_RESULT_BYTES / 2))
        .into_owned();
    // Keep the whole thing on disk when we can. "Here is the first half, now
    // narrow your call" is a dead end when the tail is the part that mattered:
    // the model cannot narrow a call whose output it has not seen, so it
    // guesses and pays for the same prefix again.
    let spilled = spill_dir.and_then(|dir| crate::spill::write(dir, tool, &text));
    let mut result = json!({
        "truncated": true,
        "tool": tool,
        "bytes": text.len(),
        "preview": preview,
    });
    let notice = match &spilled {
        Some(spill) => {
            result["outputId"] = json!(spill.id);
            result["totalBytes"] = json!(text.len());
            format!(
                "{tool} returned {} bytes, over the {}KB tool-result cap. The first half is in \
                 `preview`; the whole result is kept — read the rest with \
                 tool_output_read(outputId: \"{}\", offset: <byte>), passing each nextOffset back \
                 until it is null. Narrowing the original call is still cheaper if you know what \
                 you are looking for.",
                text.len(),
                MAX_TOOL_RESULT_BYTES / 1024,
                spill.id
            )
        }
        // Falling back rather than failing: losing the tail is bad, failing the
        // tool call outright is worse.
        None => format!(
            "{tool} returned {} bytes, over the {}KB tool-result cap; the first half is \
             below as text. Narrow the call — by path, pattern, or limit — rather than \
             repeating it.",
            text.len(),
            MAX_TOOL_RESULT_BYTES / 1024
        ),
    };
    result["notice"] = json!(notice);
    result.to_string()
}

/// Longest prefix of `bytes` within `max` that ends on a UTF-8 boundary.
fn utf8_prefix(bytes: &[u8], max: usize) -> &[u8] {
    if bytes.len() <= max {
        return bytes;
    }
    let mut end = max;
    while end > 0 && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    &bytes[..end]
}

/// Ids of the tool calls an assistant message issues (empty for every other
/// message shape).
fn tool_call_ids(message: &Value) -> impl Iterator<Item = &str> {
    message["tool_calls"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|call| call["id"].as_str())
}

/// Whether `suffix` can be appended to `compacted` without orphaning a tool
/// result.
///
/// Providers reject a transcript containing a `tool` message whose
/// `tool_call_id` no answer to any visible assistant `tool_calls` entry — and
/// they reject the whole request, not just that message, so the session is
/// bricked until someone truncates it by hand. Compaction can archive the
/// assistant message that issued a call while a concurrent turn appends the
/// result, which is exactly that shape. Ids introduced within the suffix
/// count, so a complete call/result pair appended during the summary merges
/// fine.
fn suffix_is_clean_tail(compacted: &[Value], suffix: &[Value]) -> bool {
    let mut issued: std::collections::HashSet<&str> =
        compacted.iter().flat_map(tool_call_ids).collect();
    for message in suffix {
        if message["role"] == "tool" {
            match message["tool_call_id"].as_str() {
                Some(id) if issued.contains(id) => {}
                _ => return false,
            }
        }
        issued.extend(tool_call_ids(message));
    }
    true
}

fn bound_drain_reason(text: &str) -> String {
    let mut chars = text.chars();
    let bounded: String = chars.by_ref().take(MAX_DRAIN_REASON_CHARS).collect();
    if chars.next().is_some() {
        format!("{bounded}…")
    } else {
        bounded
    }
}

#[derive(Clone)]
pub struct AgentManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<AgentSession>>>>>,
    events: tokio::sync::broadcast::Sender<Value>,
    /// Every pending approval, keyed by request id. Deliberately *not* in
    /// `AgentSession.pending`: an approval and a browser-tool waiter sharing a
    /// keyspace let one answer the other, and a tool result read as an approval
    /// answered "denied".
    ///
    /// Owned here rather than beside `AgentManager` in `AppState` so there can
    /// only ever be one registry — two instances would be a split brain in
    /// which the panel answers a request core is not waiting on.
    approvals: crate::approvals::Approvals,
    /// Cross-session, cross-restart token totals per model — the data behind
    /// Settings → Status. Owned here for the same reason as `approvals`: one
    /// registry, reachable only from the code that already records usage.
    usage: Arc<crate::usage::Ledger>,
}

/// Cooperative stop signal for the turn a session is currently running.
///
/// Aborting the client's HTTP request does not reach the loop: `chat` owns the
/// turn budget and keeps calling the provider and executing tools long after
/// nobody is reading the reply. This is the channel that actually reaches it.
///
/// A `watch` channel rather than `Notify` + flag on purpose — `wait_for`
/// inspects the current value before it parks, so a cancel that lands between
/// a caller's flag check and its await is still observed. With `Notify` that
/// interleaving parks until the *next* cancel, which for a stop button means
/// forever.
#[derive(Clone)]
pub struct CancellationToken {
    tx: Arc<tokio::sync::watch::Sender<bool>>,
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self {
            tx: Arc::new(tokio::sync::watch::channel(false).0),
        }
    }
}

impl CancellationToken {
    /// Request the running turn stop. Returns whether this call is the one
    /// that flipped it, so a second stop press is reported as a no-op rather
    /// than as a fresh cancellation.
    pub fn cancel(&self) -> bool {
        !self.tx.send_replace(true)
    }

    pub fn is_cancelled(&self) -> bool {
        *self.tx.borrow()
    }

    /// Clear the flag so the next turn is not killed by a stale stop. Called
    /// once as `chat` starts, never mid-turn.
    pub fn reset(&self) {
        self.tx.send_replace(false);
    }

    /// Resolves once cancelled, including when it already was.
    pub async fn cancelled(&self) {
        let mut rx = self.tx.subscribe();
        // The sender is held by this token, so the channel cannot close while
        // we wait; the error arm is unreachable in practice.
        let _ = rx.wait_for(|cancelled| *cancelled).await;
    }
}

pub struct AgentSession {
    pub id: String,
    pub messages: Vec<Value>,
    pub pending: HashMap<String, oneshot::Sender<Value>>,
    /// Stop signal for the in-flight turn. Lives on the session rather than in
    /// `chat`'s frame so `agent_cancel` can reach a turn it did not start.
    pub cancel: CancellationToken,
    /// Consecutive auto-compaction failures. Reset by any success.
    ///
    /// A failing compaction used to be retried on every turn forever, which is
    /// the worst shape available: the session keeps growing, and each turn pays
    /// for a summary call that cannot succeed, until the provider refuses the
    /// request outright — the exact failure compaction exists to prevent.
    pub compaction_failures: u32,
    /// The environment as last described to the model, so the next turn can
    /// send only what changed. `None` until the first turn establishes a
    /// baseline from the system prompt.
    pub world_state: Option<crate::world_state::WorldState>,
    /// Tools the user answered "always allow" for, by exact name.
    ///
    /// In-memory and session-scoped on purpose: a durable grant belongs in
    /// `~/.cali/config.yaml` under `permissions:`, where the user can see and
    /// revoke it. An approval click is consent for the work in front of them,
    /// not a permanent policy change made through a dialog.
    pub always_allow: Vec<String>,
    /// The active model's advertised context window, as last reported by the
    /// client for this session.
    ///
    /// Kept on the session, not on the turn's options, because
    /// `session_compact` arrives as its own RPC with no model attached — and a
    /// manual compaction that silently reverted to the 128k assumption would
    /// undo the whole point.
    pub context_length: Option<u32>,
    /// Cumulative token totals across every model call in this session.
    pub usage: model::Usage,
    /// Prompt tokens of the most recent model call — i.e. the current
    /// context occupancy. Overwritten per call, never reset.
    pub last_prompt_tokens: u64,
    /// Generation counter for wholesale rewrites of `messages` (compaction).
    ///
    /// Every other write to `messages` is an append, so this counter plus the
    /// length observed before an await is enough to classify what happened
    /// while the lock was dropped: same generation means the transcript only
    /// grew and the first `len` entries are untouched; a bumped generation
    /// means the head moved under us and nothing may be assumed.
    /// `compact_session` reads it before its multi-second summary call and
    /// re-checks it before swapping the result in.
    pub compactions: u64,
    /// What the operator last told `/compact` to preserve, if anything.
    ///
    /// Kept on the session so the *automatic* trigger obeys it too: someone
    /// who said "keep the repro steps and the failing test names" meant it for
    /// the compaction that fires at 3am on a loop, not only for the one they
    /// typed. Cleared with `/compact clear`.
    pub compaction_instructions: Option<String>,
}

/// What a `session_compact` call says about the operator's standing steer.
/// Absent from the request means "keep whatever this session already has" —
/// which is what the automatic trigger always sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactInstructions<'a> {
    Unchanged,
    Clear,
    Set(&'a str),
}

/// Who asked for this compaction. Only the report differs; the pipeline does
/// not, because an automatic compaction the operator cannot see is how a
/// transcript silently loses its middle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactTrigger {
    Manual,
    Auto,
}

impl CompactTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            CompactTrigger::Manual => "manual",
            CompactTrigger::Auto => "auto",
        }
    }
}

struct ToolExecutionContext<'a> {
    state: &'a AppState,
    registered: &'a HashMap<String, ToolDef>,
    session: Arc<Mutex<AgentSession>>,
    sid: &'a str,
    options: &'a AgentOptions,
}

impl AgentSession {
    /// Auto-compaction hook: fires once context occupancy met or crossed
    /// `context_budget_tokens`. The trigger's owner computes the budget from
    /// compaction config (e.g. threshold × context_length − reserved) and
    /// invokes `session_compact` when this returns true. A zero budget
    /// disables the check.
    pub fn should_compact(&self, context_budget_tokens: u64) -> bool {
        context_budget_tokens > 0 && self.occupancy() >= context_budget_tokens
    }

    /// How full the context is, in tokens.
    ///
    /// The provider's own count when there is one — it is authoritative, and
    /// includes the cached prefix, because a cache hit is cheaper rather than
    /// absent from the window.
    ///
    /// The estimate is the backstop, and it is not hypothetical: several
    /// OpenAI-compatible gateways return no `usage` block at all on a streamed
    /// response. `last_prompt_tokens` then stayed at zero for the life of the
    /// session, `should_compact` never fired, and the transcript grew until the
    /// provider rejected the whole request — the one failure mode compaction
    /// exists to prevent, reached by the route where nothing was watching.
    ///
    /// Only ever a fallback: a reported count is never second-guessed by an
    /// estimate that is characters divided by four.
    pub fn occupancy(&self) -> u64 {
        if self.last_prompt_tokens > 0 {
            return self.last_prompt_tokens;
        }
        crate::compaction::estimate_tokens(&self.messages) as u64
    }
}

/// How many times one tool call may return the byte-identical result before
/// the loop stops running it.
///
/// Three, because the first repeat is often a legitimate retry and the second
/// can be a deliberate re-check. A third identical answer to a third identical
/// question is not new information by any reading.
const MAX_IDENTICAL_TOOL_RESULTS: usize = 3;

/// Watches for a tool call that has stopped telling the model anything.
///
/// Keyed on the *outcome* as well as the call, which is what separates a doom
/// loop from ordinary polling: an agent watching `graph_status` issues
/// byte-identical calls forever and gets different answers, and must not be
/// interrupted. A call whose answer has not changed in three tries is the
/// failure mode — opencode raises a permission prompt at this point and xAI
/// streams a `doom_loop_check` event for it, so it is common enough that both
/// built a guard.
///
/// The response is to stop *executing* and hand back the answer it would have
/// produced anyway, with a notice. Refusing outright would cost the model a
/// tool result it is clearly still reasoning about; re-running costs the wall
/// clock and, for anything that writes, does the work again.
#[derive(Default)]
struct RepeatWatch {
    seen: HashMap<String, (u64, usize)>,
}

impl RepeatWatch {
    fn signature(call: &ToolCall) -> String {
        // `serde_json::Value` orders object keys, so this is stable across
        // calls that differ only in how the provider spelled the arguments.
        format!("{}\u{1}{}", call.name, call.arguments)
    }

    fn digest(outcome: &Value) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        outcome.to_string().hash(&mut hasher);
        hasher.finish()
    }

    /// The result to hand back without executing, if this call has gone stale.
    ///
    /// Deliberately does not replay the previous output: the transcript
    /// already holds that identical result three times over, so re-sending it
    /// a fourth would spend context to tell the model something it has said to
    /// itself repeatedly. Only the reason it was not run is new information.
    fn stalled_outcome(&self, call: &ToolCall) -> Option<Value> {
        let (_, repeats) = self.seen.get(&Self::signature(call))?;
        if *repeats < MAX_IDENTICAL_TOOL_RESULTS {
            return None;
        }
        Some(json!({
            "error": "repeated call not executed",
            "repeatedCall": format!(
                "{} has already returned the identical result {repeats} times this turn, so it \
                 was not run again — its output is already above, unchanged. Repeating it \
                 cannot produce anything new: change the arguments, try a different tool, or \
                 say plainly what is blocking you.",
                call.name
            ),
        }))
    }

    /// Record what a call produced. Returns the repeat count for this outcome.
    fn record(&mut self, call: &ToolCall, outcome: &Value) -> usize {
        let digest = Self::digest(outcome);
        let entry = self
            .seen
            .entry(Self::signature(call))
            .or_insert((digest, 0));
        if entry.0 == digest {
            entry.1 += 1;
        } else {
            *entry = (digest, 1);
        }
        entry.1
    }
}

/// The provider-shaped prefix recoverable from a durable session record.
///
/// The record is the panel's transcript, so it carries tool *rows* (UI objects
/// with a `tool` field and no provider identity) and turn markers alongside the
/// conversation. Those are dropped rather than translated: an assistant message
/// carrying `tool_calls` whose results cannot also be reconstructed makes the
/// provider reject the very next request, which would turn a recoverable
/// session into a permanently broken one.
///
/// Only user and assistant messages with real text survive, in order.
fn provider_messages_from_record(record: &Value) -> Vec<Value> {
    let Some(messages) = record.get("messages").and_then(Value::as_array) else {
        return Vec::new();
    };
    messages
        .iter()
        .filter_map(|message| {
            let role = message.get("role").and_then(Value::as_str)?;
            if role != "user" && role != "assistant" {
                return None;
            }
            // A tool row is stored with role "tool", but the panel also writes
            // assistant-role status lines that carry a `tool` marker; neither is
            // part of the model's conversation.
            if message.get("tool").is_some() || message.get("turnId").is_some() {
                return None;
            }
            let content = message.get("content").and_then(Value::as_str)?.trim();
            if content.is_empty() {
                return None;
            }
            Some(json!({ "role": role, "content": content }))
        })
        .collect()
}

/// Consecutive auto-compaction failures before the session stops trying.
///
/// Three, not one: a summary call can fail for reasons that pass on the next
/// turn — a 5xx, a rate limit, a transcript that moved mid-summary. What this
/// catches is the shape that never recovers, where every turn pays for a
/// summary that cannot succeed while the context keeps growing.
const MAX_COMPACTION_FAILURES: u32 = 3;

/// Whether this session has stopped attempting auto-compaction.
///
/// A named predicate rather than an inline comparison so the boundary is
/// testable: the difference between `>` and `>=` here is one extra doomed
/// summary call on every turn for the rest of the session.
fn compaction_breaker_tripped(failures: u32) -> bool {
    failures >= MAX_COMPACTION_FAILURES
}

/// Context length assumed when neither the config's `compaction.context_length`
/// override nor the active model's advertised limit says otherwise.
///
/// A last resort, not a norm. Applying it to every model is what made a
/// 1M-context model compact at 88k and a 32k model compact hundreds of turns
/// too late.
const DEFAULT_CONTEXT_LENGTH: u32 = 128_000;

/// Token budget that triggers (and bounds) compaction:
/// `threshold × context_length − reserved`, clamped at zero. A non-positive
/// result disables auto-compaction (`should_compact` treats 0 as off).
///
/// `model_context` is the active model's advertised window, which the client
/// resolves from models.dev and sends with the turn — core has no model
/// catalog of its own and must not grow one (see AGENTS.md). The config
/// override still wins: a user who wrote `compaction.context_length` meant it,
/// and is usually working around a model whose advertised limit is wrong.
fn context_budget_tokens(config: &crate::config::AppConfig, model_context: Option<u32>) -> u64 {
    let compaction = &config.compaction;
    let context_length = compaction
        .context_length
        .or(model_context)
        .unwrap_or(DEFAULT_CONTEXT_LENGTH)
        .max(1);
    let threshold = compaction.threshold.clamp(0.0, 1.0) as f64;
    let budget = (f64::from(context_length) * threshold) as u64;
    budget.saturating_sub(u64::from(compaction.reserved))
}

/// Which panel's work an agent is doing, published on
/// `agent.approval_request` as `ownerSession`.
///
/// Distinct from [`AgentOptions::approval_session`], which is only the address
/// the answer travels back on. A directly spawned subagent asks under a session
/// id no panel ever opened, so without an owner on the wire a panel had to
/// infer ownership from local state — and inference is what let one window
/// claim (and deny) another window's work.
///
/// [`ApprovalOwner::Unowned`] is deliberately not "this agent's own session": a
/// parentless spawn has nobody watching, and it must say so rather than name a
/// session a panel might match.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ApprovalOwner {
    /// Top-level turn: the human is watching this agent's own session.
    #[default]
    OwnSession,
    /// Spawned work: this ancestor session is the one on screen. Held by
    /// subagents (their root ancestor), graph nodes (the graph's
    /// `owner_session`), and client-initiated direct spawns (the calling
    /// panel's session).
    Ancestor(String),
    /// Nobody is watching. A `subagent_spawn` with no calling session, or a
    /// graph with no owner session, runs unattended; its approvals belong to no
    /// panel and must never be matched by one.
    Unowned,
}

impl ApprovalOwner {
    /// Build from an ancestor that may not exist. A missing or blank id means
    /// unattended — never "own session", which would invent an owner.
    pub fn from_ancestor(session: Option<String>) -> Self {
        match session
            .map(|session| session.trim().to_string())
            .filter(|session| !session.is_empty())
        {
            Some(session) => Self::Ancestor(session),
            None => Self::Unowned,
        }
    }

    /// The concrete watched session for an agent running as `session_id`, or
    /// `None` when this work is unattended.
    ///
    /// This is also what a child inherits: resolving *before* the spawn is what
    /// keeps `OwnSession` from silently re-pointing at the child's session.
    pub fn resolve<'a>(&'a self, session_id: &'a str) -> Option<&'a str> {
        match self {
            Self::OwnSession => Some(session_id),
            Self::Ancestor(session) => Some(session.as_str()),
            Self::Unowned => None,
        }
    }
}

#[derive(Clone, Default)]
pub struct AgentOptions {
    pub permission_mode: String,
    pub max_turns: usize,
    /// The active model's advertised context window, resolved by the client
    /// from models.dev. Recorded on the session so later compactions — including
    /// a manual `session_compact` — size themselves to the same model.
    pub context_length: Option<u32>,
    /// Bounded orchestration escape hatch: after the final allowed turn executes tools,
    /// make one schema-less provider call for a textual handoff. Public
    /// ordinary top-level/subagent callers leave this false. Graph workers
    /// and trusted `/loop` requests may enable it.
    pub final_response_drain: bool,
    /// Per-turn reasoning effort selected by the composer. It is forwarded
    /// only for this request, never written into the provider config.
    pub reasoning_effort: Option<String>,
    /// Active client-owned /loop identifier. Core injects this and the
    /// already-bound project slug into loop-report tool calls so a model does
    /// not have to retype opaque routing fields on every iteration.
    pub loop_id: Option<String>,
    pub system: Option<String>,
    /// Role keys this agent may be routed by, most specific first, matched
    /// against `model.roles` so a fan-out can put builders and judges on
    /// different models. Ordered because a judge node carries both the kind
    /// the engine gave it (`judge`) and the role its plan named (`critic`),
    /// and a user who mapped only one of them means it. Set by core from the
    /// spawn — never from a model-authored argument, which is what keeps
    /// provider choice with the user. Empty (a top-level chat) always runs
    /// the model picker's selection.
    pub model_roles: Vec<String>,
    pub project_slug: Option<String>,
    /// Immutable workspace selected by the durable session. Core file tools
    /// resolve here instead of following the project's mutable default.
    pub workspace_root: Option<String>,
    /// Session whose events and pending map carry this agent's approval
    /// requests. `None` means this agent's own session — the default for
    /// top-level chats. Subagents get their root ancestor's id here so the
    /// client (which only watches the session it opened) sees the prompt.
    pub approval_session: Option<String>,
    /// Which panel's work this agent is doing — published on
    /// `agent.approval_request` as `ownerSession`, and the key core uses to
    /// look up the window the prompt is addressed to. Distinct from
    /// `approval_session`, which is only an address for the answer.
    pub approval_owner: ApprovalOwner,
    /// The graph run this agent's work belongs to, published on
    /// `agent.approval_request` as `ownerGraph`. `None` for everything that is
    /// not a graph.
    ///
    /// It is inherited by every descendant, so a node's own subagent still
    /// names the run — which no `graph.updated` snapshot ever carries, and
    /// which is why a panel must never have to recognise a session id to know
    /// whose prompt this is. It is also the key `cancel_by_graph` uses when the
    /// run ends.
    pub owner_graph: Option<String>,
    /// How many `subagent_spawn` hops sit above this agent (0 = top level).
    /// Capped by `crate::tools::MAX_SUBAGENT_DEPTH`.
    pub subagent_depth: usize,
    /// Ordered permission rules from config (global first, then per-project
    /// so project rules win under last-match-wins). Evaluated before mode
    /// logic. Subagents must inherit their parent's rules, never looser.
    pub permission_rules: Vec<PermissionRule>,
}

/// Fans one model stream out onto the event bus as two distinct signals.
///
/// Visible text stays addressed to the session that produced it, unchanged.
/// Reasoning is addressed to the parent and carries `subagentSessionId` when a
/// subagent produced it — the same routing `agent.approval_request` uses, so a
/// subagent's thinking surfaces in the transcript the user is watching rather
/// than in a session no UI has open. Reasoning is never written to the
/// transcript; it exists only for the duration of this stream.
fn spawn_stream_forwarder(
    bus: tokio::sync::broadcast::Sender<Value>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<model::StreamChunk>,
    session_id: String,
    parent_session_id: String,
) {
    tokio::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            let event = match chunk {
                model::StreamChunk::Content(delta) => json!({
                    "type": "agent.delta",
                    "sessionId": session_id,
                    "delta": delta
                }),
                model::StreamChunk::Reasoning(delta) => {
                    let mut event = json!({
                        "type": "agent.reasoning",
                        "sessionId": parent_session_id,
                        "delta": delta
                    });
                    if parent_session_id != session_id {
                        event["subagentSessionId"] = json!(session_id);
                    }
                    event
                }
            };
            let _ = bus.send(event);
        }
    });
}

impl AgentManager {
    pub fn new(events: tokio::sync::broadcast::Sender<Value>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            approvals: crate::approvals::Approvals::new(events.clone()),
            usage: Arc::new(crate::usage::Ledger::default()),
            events,
        }
    }

    /// The one approval registry. Graph cancellation and the RPC surface reach
    /// it through here so nothing can construct a second one.
    pub fn approvals(&self) -> &crate::approvals::Approvals {
        &self.approvals
    }

    /// The per-model token ledger. Unattached until `main` points it at a
    /// file, so a manager built in a test counts in memory only.
    pub fn usage_ledger(&self) -> &Arc<crate::usage::Ledger> {
        &self.usage
    }

    /// Pre-allocate the in-memory half of a durable session. The UI uses this
    /// before the first turn so its editor/worktree binding already has the
    /// same id the model and outside MCP clients will use.
    pub async fn ensure_session(&self, id: &str) -> Result<()> {
        self.restore_session(id, &[]).await
    }

    pub async fn restore_session(&self, id: &str, messages: &[Value]) -> Result<()> {
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            anyhow::bail!("invalid session id");
        }
        let mut sessions = self.sessions.lock().await;
        sessions.entry(id.to_string()).or_insert_with(|| {
            Arc::new(Mutex::new(AgentSession {
                id: id.to_string(),
                messages: messages.to_vec(),
                pending: HashMap::new(),
                cancel: CancellationToken::default(),
                world_state: None,
                compaction_failures: 0,
                always_allow: Vec::new(),
                context_length: None,
                usage: model::Usage::default(),
                last_prompt_tokens: 0,
                compactions: 0,
                compaction_instructions: None,
            }))
        });
        Ok(())
    }

    /// Allocate a fresh session id before its first turn starts.
    ///
    /// Graph scheduling needs the id in its persisted `node_started` snapshot
    /// so the client can demultiplex the very first delta/tool event. Going
    /// through the same allocator as an unbound chat keeps MAX_SESSIONS
    /// eviction intact; `ensure_session` only inserts a caller-chosen id and
    /// deliberately does not run that lifecycle policy.
    pub async fn reserve_session(&self) -> Result<String> {
        let session = self.get_or_create(None).await?;
        let id = session.lock().await.id.clone();
        Ok(id)
    }

    /// Record an "always allow" answer for one tool on one session.
    ///
    /// Grants the *exact* tool name, never a glob. That is the whole discipline
    /// here, and it is opencode's arity table translated to a harness with no
    /// shell: an "always" must not grant more than the user was shown. Their
    /// version stops "always allow `git commit -m x`" from becoming `git *`;
    /// ours stops approving one `mcp__blender__execute_blender_code` from
    /// becoming `mcp__blender__*`.
    ///
    /// A tool that config *denies* can never be granted this way, mirroring
    /// `merge_permission_rules`: rules are last-match-wins, so an appended
    /// allow would otherwise beat a machine-wide `deny` — turning a dialog
    /// click into a way around the user's own policy.
    pub async fn always_allow(&self, session_id: &str, tool: &str) -> Result<bool> {
        if tool.trim().is_empty() {
            anyhow::bail!("cannot always-allow an unnamed tool");
        }
        let session = self.session(session_id).await?;
        let mut guard = session.lock().await;
        if guard.always_allow.iter().any(|known| known == tool) {
            return Ok(false);
        }
        guard.always_allow.push(tool.to_string());
        Ok(true)
    }

    /// Ask a session's in-flight turn to stop, leaving the session itself
    /// intact and resumable.
    ///
    /// Returns `(found, newly_cancelled)`. `found: false` is the ordinary
    /// answer for a session whose turn already finished, not an error — the
    /// stop button races the loop by nature.
    pub async fn cancel_session(&self, id: &str) -> (bool, bool) {
        let session = self.sessions.lock().await.get(id).cloned();
        let Some(session) = session else {
            return (false, false);
        };
        let token = {
            let guard = session.lock().await;
            guard.cancel.clone()
        };
        (true, token.cancel())
    }

    /// Remove the in-memory state for a deleted/archived durable session.
    ///
    /// Dropping the pending oneshot senders wakes browser-tool and approval
    /// calls immediately; otherwise an abandoned session remains reachable
    /// until each request's multi-minute timeout and keeps its entry in the
    /// manager map.
    pub async fn remove_session(&self, id: &str) -> (bool, usize) {
        let session = self.sessions.lock().await.remove(id);
        let Some(session) = session else {
            return (false, 0);
        };
        let cancelled = {
            let mut guard = session.lock().await;
            // A running turn holds its own Arc, so dropping the map entry does
            // not reach it. Without this, deleting a session leaves its loop
            // billing tokens against a transcript that no longer exists.
            guard.cancel.cancel();
            let pending = std::mem::take(&mut guard.pending);
            let cancelled = pending.len();
            drop(pending);
            cancelled
        };
        // Approvals live in their own registry now, so dropping `pending` no
        // longer wakes them. A removed session's prompts are dead work; leaving
        // them would park the asking agent for the full 300s.
        let approvals = self.approvals.cancel_by_session(id).await;
        (true, cancelled + approvals)
    }

    async fn record_usage(
        &self,
        session: &Arc<Mutex<AgentSession>>,
        session_id: &str,
        usage: Option<model::Usage>,
        model: &crate::config::ModelConfig,
    ) {
        // Ledger first, and outside the session lock: the per-model totals
        // outlive this session, so a caller that drops the session mid-turn
        // must not also drop the accounting for a call it already paid for.
        if let Some(usage) = usage.as_ref() {
            self.usage.record(&model.provider, &model.default, usage);
        }
        let mut guard = session.lock().await;
        if let Some(usage) = usage {
            guard.usage.prompt_tokens += usage.prompt_tokens;
            guard.usage.completion_tokens += usage.completion_tokens;
            guard.usage.cache_read_tokens += usage.cache_read_tokens;
            guard.usage.cache_write_tokens += usage.cache_write_tokens;
            guard.usage.total_tokens += usage.total_tokens;
            // Current context occupancy includes cached prefix tokens; cache
            // hits are cheaper, not absent from the window.
            guard.last_prompt_tokens = usage
                .prompt_tokens
                .saturating_add(usage.cache_read_tokens)
                .saturating_add(usage.cache_write_tokens);
        }
        let _ = self.events.send(json!({
            "type": "agent.usage",
            "sessionId": session_id,
            "usage": {
                "promptTokens": guard.usage.prompt_tokens,
                "completionTokens": guard.usage.completion_tokens,
                "cacheReadTokens": guard.usage.cache_read_tokens,
                "cacheWriteTokens": guard.usage.cache_write_tokens,
                "totalTokens": guard.usage.total_tokens,
                // Occupancy rather than the raw field, so the meter still
                // moves for a provider that reports no usage at all.
                "lastPromptTokens": guard.occupancy(),
                "lastCacheReadTokens": usage.map(|value| value.cache_read_tokens).unwrap_or(0)
            }
        }));
    }

    /// Ask the provider once for a report after the final tool turn. The
    /// snapshot is the same reserved session transcript, but `tools: None`
    /// guarantees a report cannot trigger another mutation.
    async fn final_response_drain(
        &self,
        state: &AppState,
        session: &Arc<Mutex<AgentSession>>,
        session_id: &str,
        options: &AgentOptions,
    ) -> Result<model::ChatResult> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<model::StreamChunk>();
        spawn_stream_forwarder(
            self.events.clone(),
            rx,
            session_id.to_string(),
            options
                .approval_session
                .clone()
                .unwrap_or_else(|| session_id.to_string()),
        );
        let mut config = { state.config.read().await.clone() };
        crate::config::apply_role_model(&mut config, &options.model_roles);
        let mut snapshot = {
            let guard = session.lock().await;
            guard.messages.clone()
        };
        // Same session history: the snapshot the model receives is the
        // resolved transcript plus one finalization directive. Keeping the
        // prefix intact preserves the provider's prompt-cache prefix; the
        // appended user message is the only thing that changes on the wire.
        snapshot.push(json!({
            "role": "user",
            "content": FINALIZATION_INSTRUCTION,
        }));
        let result = model::chat_with_effort_session_once(
            &config,
            &snapshot,
            None,
            Some(&tx),
            options.reasoning_effort.as_deref(),
            Some(session_id),
        )
        .await;
        drop(tx);
        result
    }

    pub async fn chat(
        &self,
        state: &AppState,
        registered_tools: &HashMap<String, ToolDef>,
        session_id: Option<&str>,
        messages: &[Value],
        mut options: AgentOptions,
    ) -> Result<Value> {
        let session = match self.get_or_create(session_id).await {
            Ok(session) => session,
            // A named session core no longer holds is the ordinary case after a
            // restart or an eviction, not a dead end: bring it back from disk
            // rather than letting the caller fork a new one.
            Err(missing) => match session_id {
                Some(id) => {
                    self.rehydrate_from_disk(state, id)
                        .await
                        .map_err(|_| missing)?;
                    self.get_or_create(Some(id)).await?
                }
                None => return Err(missing),
            },
        };
        let current_session_id = {
            let guard = session.lock().await;
            guard.id.clone()
        };
        {
            let mut guard = session.lock().await;
            // Only overwrite when the caller actually knows: a subagent or
            // graph turn that never learned the window must not erase what the
            // panel already reported for this session.
            if options.context_length.is_some() {
                guard.context_length = options.context_length;
            }
            if options.system.is_some() && guard.messages.is_empty() {
                guard.messages.push(json!({
                    "role": "system",
                    "content": options.system.clone().unwrap_or_default()
                }));
            }
            for message in messages {
                guard.messages.push(message.clone());
            }
        }
        let mut turns = 0usize;
        let max_turns = options.max_turns.clamp(1, MAX_TURNS_CEILING);
        let mut tool_calls_log: Vec<Value> = Vec::new();
        // Cleared here, never mid-turn: a stop pressed against the *previous*
        // turn must not kill this one.
        let cancel = {
            let guard = session.lock().await;
            guard.cancel.clone()
        };
        cancel.reset();
        // Fold this session's "always allow" answers into the turn's rules.
        // Appended last so they beat the *mode* logic, and screened first so
        // they can never beat a `deny`: rules are last-match-wins, and an
        // appended allow would otherwise let a dialog click override the
        // machine-wide policy the user wrote down.
        {
            let granted = { session.lock().await.always_allow.clone() };
            for tool in granted {
                if rule_decision(&options.permission_rules, &tool) == Some(RuleAction::Deny) {
                    tracing::warn!(
                        %tool,
                        "ignoring an always-allow for a tool config denies"
                    );
                    continue;
                }
                options.permission_rules.push(PermissionRule {
                    pattern: tool,
                    action: "allow".into(),
                });
            }
        }
        let mut cancelled = false;
        let mut over_budget: Option<(u64, u64)> = None;
        // Read once per call: re-reading config every turn would let a mid-run
        // edit change the answer halfway through a loop.
        let budget_tokens = {
            let config = state.config.read().await;
            config.budget.session_tokens.filter(|limit| *limit > 0)
        };
        // Scoped to this `chat` call: a fresh user message is a new intent, and
        // repeating a tool that was stale during the previous turn is often
        // exactly right once the question has changed.
        let mut repeats = RepeatWatch::default();

        loop {
            if turns >= max_turns {
                break;
            }
            if cancel.is_cancelled() {
                cancelled = true;
                break;
            }
            // Spend ceiling, checked before committing to another provider
            // request rather than after paying for one. `max_turns` bounds the
            // number of requests, which is not the thing anyone is worried
            // about — two hundred cheap turns and two hundred expensive ones
            // are the same count and very different bills.
            if let Some(limit) = budget_tokens {
                let spent = { session.lock().await.usage.total_tokens };
                if spent >= limit {
                    over_budget = Some((spent, limit));
                    break;
                }
            }
            turns += 1;
            let defs = self.build_tools(registered_tools, &options.permission_rules);
            let schemas: Vec<Value> = defs.iter().map(to_openai_schema).collect();
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<model::StreamChunk>();
            spawn_stream_forwarder(
                self.events.clone(),
                rx,
                current_session_id.clone(),
                options
                    .approval_session
                    .clone()
                    .unwrap_or_else(|| current_session_id.clone()),
            );
            // Clone rather than hold the guard across the streaming model
            // call. Tokio's RwLock is fair, so a queued model_switch writer
            // blocks every later reader — a switch during a subagent run was
            // measured starving the whole harness for >270s.
            let mut config = { state.config.read().await.clone() };
            crate::config::apply_role_model(&mut config, &options.model_roles);
            // Auto-compaction: when the previous call's prompt crossed the
            // configured budget, compact before growing the context further.
            // Failure is non-fatal — the turn proceeds uncompacted.
            if config.compaction.auto {
                let wants = {
                    let guard = session.lock().await;
                    let budget = context_budget_tokens(&config, guard.context_length);
                    guard.should_compact(budget)
                };
                // Stop trying once it has failed repeatedly. Retrying every
                // turn forever is the worst of both: the transcript still
                // grows, and each turn buys another failed summary call.
                let tripped = compaction_breaker_tripped(session.lock().await.compaction_failures);
                if wants && tripped {
                    tracing::warn!(
                        session = %current_session_id,
                        "auto-compaction disabled for this session after \
                         {MAX_COMPACTION_FAILURES} consecutive failures"
                    );
                }
                if wants && !tripped {
                    match self
                        .compact_session(
                            state,
                            &current_session_id,
                            CompactInstructions::Unchanged,
                            CompactTrigger::Auto,
                        )
                        .await
                    {
                        Ok(_) => {
                            // Any success clears the count: the breaker is for
                            // a persistently broken transcript, not for one
                            // unlucky provider hiccup.
                            session.lock().await.compaction_failures = 0;
                        }
                        Err(error) => {
                            let failures = {
                                let mut guard = session.lock().await;
                                guard.compaction_failures += 1;
                                guard.compaction_failures
                            };
                            tracing::warn!(%error, session = %current_session_id, failures,
                                "auto-compaction failed; continuing uncompacted");
                        }
                    }
                }
            }
            // Tell the model what moved since it was last told, and nothing
            // else. The system prompt describes the world once, on the first
            // turn, and is never revised — so without this the model spends a
            // long session reasoning about a project that stopped existing the
            // moment it made its first edit.
            if let Some(slug) = options.project_slug.as_deref() {
                let editor_tools: Vec<String> = registered_tools
                    .values()
                    .filter(|def| def.kind == crate::tools::ToolKind::Browser)
                    .map(|def| def.name.clone())
                    .collect();
                let current = crate::world_state::capture(
                    &crate::rpc::project_digest(&state.projects_root, slug),
                    &editor_tools,
                    options.workspace_root.as_deref(),
                );
                let mut guard = session.lock().await;
                if let Some(text) = crate::world_state::diff(guard.world_state.as_ref(), &current) {
                    guard.messages.push(crate::world_state::message(&text));
                }
                guard.world_state = Some(current);
            }
            let snapshot = {
                let guard = session.lock().await;
                guard.messages.clone()
            };
            // Racing the provider call rather than polling around it: dropping
            // the losing future closes the in-flight HTTP request, so a stop
            // during a long stream ends the request instead of paying for a
            // completion nobody will read.
            let mut result = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    drop(tx);
                    cancelled = true;
                    break;
                }
                result = model::chat_with_effort_session(
                    &config,
                    &snapshot,
                    Some(&schemas),
                    Some(&tx),
                    options.reasoning_effort.as_deref(),
                    Some(&current_session_id),
                ) => result?,
            };
            drop(tx);
            // Discard the turn wholesale when the stop landed while the
            // response was arriving. Pushing the assistant message here would
            // leave tool calls with no results — a transcript the provider
            // rejects on the next request, which would make the session
            // unresumable rather than merely stopped.
            if cancel.is_cancelled() {
                cancelled = true;
                break;
            }
            repair_missing_graph_goal(&mut result.tool_calls, &snapshot);
            for call in &mut result.tool_calls {
                bind_trusted_call_context(
                    &call.name,
                    &mut call.arguments,
                    &options,
                    &current_session_id,
                );
            }
            // Cumulative token accounting: fold this call's usage (when the
            // provider reported any) into the session totals, then publish
            // them so the client can render a context meter and the
            // compaction auto-trigger can compare against its budget
            // (`AgentSession::should_compact`).
            self.record_usage(&session, &current_session_id, result.usage, &config.model)
                .await;
            if result.content.is_empty() && result.tool_calls.is_empty() {
                // `model::chat_with_effort` retries/falls back empty
                // completions. Keep this guard for a future provider parser
                // regression, but never turn an opaque success into a fake
                // assistant sentence: the RPC error is actionable and the
                // session remains resumable.
                anyhow::bail!(
                    "model returned an empty completion (no content or tool calls) after retries"
                );
            }

            if result.tool_calls.is_empty() {
                {
                    let mut guard = session.lock().await;
                    guard
                        .messages
                        .push(json!({ "role": "assistant", "content": result.content.clone() }));
                }
                return Ok(json!({
                    "sessionId": current_session_id,
                    "reply": result.content,
                    "toolCalls": tool_calls_log,
                    "turns": turns,
                    "status": "completed",
                    "completed": true
                }));
            }

            {
                let mut guard = session.lock().await;
                guard.messages.push(json!({
                    "role": "assistant",
                    "content": result.content,
                    "tool_calls": result.tool_calls.iter().map(assistant_tool_call).collect::<Vec<_>>()
                }));
            }

            // The fan-out cap counts spawns in call order BEFORE anything
            // runs, so it cannot race execution: the first N spawn calls by
            // position run, later ones are refused deterministically.
            let mut spawn_seen = 0usize;
            let over_caps: Vec<bool> = result
                .tool_calls
                .iter()
                .map(|call| {
                    if call.name == "subagent_spawn" {
                        spawn_seen += 1;
                        spawn_seen > MAX_SPAWNS_PER_TURN
                    } else {
                        false
                    }
                })
                .collect();
            // Each log entry starts as the attempted call. Outcomes pair
            // with `result.tool_calls` in provider order, so we patch the
            // freshly-pushed suffix once execution finishes — a failed
            // loop_report_iteration is otherwise indistinguishable from a
            // completed one when the client only sees the attempt list.
            let log_attempt_start = tool_calls_log.len();
            for call in &result.tool_calls {
                tool_calls_log.push(json!({
                    "name": call.name,
                    "arguments": call.arguments,
                    "id": call.id
                }));
            }
            // Stateful calls must observe provider order: a generated asset
            // has to exist before promotion, PIE must have started before a
            // capture, and browser approvals/cancellation must not leave
            // later calls racing the first one. The one explicit fan-out
            // contract is a batch made entirely of subagent_spawn calls;
            // graph waves provide the other parallel orchestration path.
            let outcomes = if result
                .tool_calls
                .iter()
                .all(|call| call.name == "subagent_spawn")
            {
                let started_at_ms: Vec<u64> =
                    result.tool_calls.iter().map(|_| unix_time_ms()).collect();
                for (call, started_at_ms) in result.tool_calls.iter().zip(&started_at_ms) {
                    self.emit_tool_started(&current_session_id, call, *started_at_ms, &options);
                }
                let sid_ref = &current_session_id;
                let options_ref = &options;
                futures::future::join_all(
                    result
                        .tool_calls
                        .iter()
                        .zip(over_caps)
                        .zip(started_at_ms)
                        .map(|((call, over_cap), started_at_ms)| {
                            let session = session.clone();
                            async move {
                                let context = ToolExecutionContext {
                                    state,
                                    registered: registered_tools,
                                    session,
                                    sid: sid_ref,
                                    options: options_ref,
                                };
                                self.execute_tool_call_outcome(
                                    &context,
                                    call,
                                    over_cap,
                                    started_at_ms,
                                )
                                .await
                            }
                        }),
                )
                .await
            } else {
                let mut outcomes = Vec::with_capacity(result.tool_calls.len());
                let context = ToolExecutionContext {
                    state,
                    registered: registered_tools,
                    session: session.clone(),
                    sid: &current_session_id,
                    options: &options,
                };
                for (call, over_cap) in result.tool_calls.iter().zip(over_caps) {
                    // Every issued call still needs a result message, so a
                    // stop mid-batch refuses the remainder instead of
                    // abandoning it: skipping the push would orphan the tool
                    // call and break the next request on this session.
                    if cancel.is_cancelled() {
                        outcomes.push(json!({ "error": "cancelled by user before this tool ran" }));
                        continue;
                    }
                    // A call that has answered identically three times running
                    // is not going to answer differently on the fourth. Stop
                    // paying the wall clock — and, for anything that writes,
                    // stop doing the work again.
                    if let Some(stalled) = repeats.stalled_outcome(call) {
                        outcomes.push(stalled);
                        continue;
                    }
                    let started_at_ms = unix_time_ms();
                    self.emit_tool_started(&current_session_id, call, started_at_ms, &options);
                    let outcome = self
                        .execute_tool_call_outcome(&context, call, over_cap, started_at_ms)
                        .await;
                    repeats.record(call, &outcome);
                    outcomes.push(outcome);
                }
                outcomes
            };
            {
                let spill_dir = crate::spill::dir_for(&state.sessions_root);
                let mut guard = session.lock().await;
                for (call, outcome) in result.tool_calls.iter().zip(&outcomes) {
                    guard.messages.push(json!({
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": bound_tool_result(&call.name, outcome, Some(&spill_dir))
                    }));
                }
            }
            // Stamp the just-executed suffix of `tool_calls_log` with its
            // terminal status. The client loop correlates by tool call id,
            // so it can finally tell a `loop_report_iteration` that
            // returned `{"error": "..."}` from one that succeeded.
            for (entry, outcome) in tool_calls_log
                .iter_mut()
                .skip(log_attempt_start)
                .zip(&outcomes)
            {
                entry["status"] = json!(if outcome.get("error").is_some() {
                    "error"
                } else {
                    "done"
                });
            }

            // A graph worker may spend its last counted turn on tools. Give
            // it exactly one schema-less request to report what those tools
            // accomplished, but never execute a tool call returned by this
            // bounded drain.
            if turns >= max_turns && options.final_response_drain {
                let drain = self
                    .final_response_drain(state, &session, &current_session_id, &options)
                    .await;
                match drain {
                    Ok(result) if content_carries_textual_tool_protocol(&result.content) => {
                        // Tool protocol embedded in `content` is not a final
                        // report: the provider parsed no structured
                        // tool_calls, so nothing would be dispatched, but
                        // pretending the markup is a report would silently
                        // hide a confused model from the graph monitor.
                        let reason = "final response drain returned a textual tool-call \
                             protocol (provider did not emit structured tool_calls); no drain \
                             tools were executed"
                            .to_string();
                        return Ok(self
                            .max_turns_result(
                                &session,
                                &current_session_id,
                                max_turns,
                                tool_calls_log,
                                Some(reason),
                            )
                            .await);
                    }
                    Ok(result)
                        if !result.content.trim().is_empty() && result.tool_calls.is_empty() =>
                    {
                        self.record_usage(
                            &session,
                            &current_session_id,
                            result.usage,
                            &config.model,
                        )
                        .await;
                        let reply = result.content;
                        let mut guard = session.lock().await;
                        guard
                            .messages
                            .push(json!({ "role": "assistant", "content": reply.clone() }));
                        return Ok(json!({
                            "sessionId": current_session_id,
                            "reply": reply,
                            "toolCalls": tool_calls_log,
                            "turns": turns,
                            "status": "completed",
                            "completed": true
                        }));
                    }
                    Ok(result) if !result.tool_calls.is_empty() => {
                        let reason = "final response drain requested more tools; no drain tools were executed"
                            .to_string();
                        return Ok(self
                            .max_turns_result(
                                &session,
                                &current_session_id,
                                max_turns,
                                tool_calls_log,
                                Some(reason),
                            )
                            .await);
                    }
                    Ok(_) => {
                        let reason =
                            "final response drain returned no textual report; no additional tools were executed"
                                .to_string();
                        return Ok(self
                            .max_turns_result(
                                &session,
                                &current_session_id,
                                max_turns,
                                tool_calls_log,
                                Some(reason),
                            )
                            .await);
                    }
                    Err(error) => {
                        let reason = format!(
                            "final response drain failed: {}; no additional tools were executed",
                            bound_drain_reason(&error.to_string())
                        );
                        return Ok(self
                            .max_turns_result(
                                &session,
                                &current_session_id,
                                max_turns,
                                tool_calls_log,
                                Some(reason),
                            )
                            .await);
                    }
                }
            }
        }

        if let Some((spent, limit)) = over_budget {
            return Ok(self
                .over_budget_result(
                    &session,
                    &current_session_id,
                    turns,
                    tool_calls_log,
                    spent,
                    limit,
                )
                .await);
        }

        if cancelled {
            return Ok(self
                .cancelled_result(&session, &current_session_id, turns, tool_calls_log)
                .await);
        }

        Ok(self
            .max_turns_result(
                &session,
                &current_session_id,
                max_turns,
                tool_calls_log,
                None,
            )
            .await)
    }

    /// Terminal result for a session that reached its spend ceiling.
    ///
    /// Distinct from the turn-budget backstop: hitting `max_turns` means the
    /// model failed to converge and is worth reporting as a runaway, while
    /// hitting a spend ceiling means the user's own limit did exactly what they
    /// set it to do. Reporting the second in the first's words would misplace
    /// whose decision it was.
    async fn over_budget_result(
        &self,
        session: &Arc<Mutex<AgentSession>>,
        session_id: &str,
        turns: usize,
        tool_calls_log: Vec<Value>,
        spent: u64,
        limit: u64,
    ) -> Value {
        let reply = format!(
            "Stopped: this session has used {spent} tokens, at or past the {limit}-token ceiling \
             set by `budget.session_tokens` in ~/.cali/config.yaml. Nothing is lost — raise the \
             ceiling, or start a new chat, to carry on."
        );
        {
            let mut guard = session.lock().await;
            guard
                .messages
                .push(json!({ "role": "assistant", "content": reply.clone() }));
        }
        json!({
            "sessionId": session_id,
            "reply": reply,
            "toolCalls": tool_calls_log,
            "turns": turns,
            "status": "over_budget",
            "completed": false,
            "terminalReason": "over_budget",
            "tokensSpent": spent,
            "tokenLimit": limit,
        })
    }

    /// Terminal result for a turn the user stopped.
    ///
    /// Distinct from `max_turns_result` because the two mean opposite things:
    /// a turn budget running out is a runaway the user should hear about, and
    /// a stop is the user getting exactly what they asked for. Sharing the
    /// backstop's wording would report every stop as a malfunction.
    async fn cancelled_result(
        &self,
        session: &Arc<Mutex<AgentSession>>,
        session_id: &str,
        turns: usize,
        tool_calls_log: Vec<Value>,
    ) -> Value {
        let reply = "Stopped at your request.".to_string();
        {
            let mut guard = session.lock().await;
            guard
                .messages
                .push(json!({ "role": "assistant", "content": reply.clone() }));
        }
        json!({
            "sessionId": session_id,
            "reply": reply,
            "toolCalls": tool_calls_log,
            "turns": turns,
            "status": "cancelled",
            "completed": false,
            "cancelled": true,
            "terminalReason": "cancelled"
        })
    }

    async fn max_turns_result(
        &self,
        session: &Arc<Mutex<AgentSession>>,
        session_id: &str,
        max_turns: usize,
        tool_calls_log: Vec<Value>,
        reason: Option<String>,
    ) -> Value {
        let reply = match reason.as_deref() {
            Some(reason) => format!(
                "Stopped after {max_turns} turns without a final answer — this is CaliCode's \
                 runaway backstop, not a limit you configured. {reason}. Send another message \
                 to continue."
            ),
            None => format!(
                "Stopped after {max_turns} turns without a final answer — this is CaliCode's \
                 runaway backstop, not a limit you configured. Send another message to continue."
            ),
        };
        {
            let mut guard = session.lock().await;
            guard
                .messages
                .push(json!({ "role": "assistant", "content": reply.clone() }));
        }
        let mut result = json!({
            "sessionId": session_id,
            "reply": reply,
            "toolCalls": tool_calls_log,
            "turns": max_turns,
            "status": "max_turns",
            "completed": false,
            "terminalReason": "max_turns",
            "maxTurns": max_turns
        });
        if let Some(reason) = reason {
            result["reason"] = json!(reason);
        }
        result
    }

    pub async fn submit_tool_result(
        &self,
        session_id: &str,
        request_id: &str,
        result: Value,
    ) -> Result<Value> {
        let session = self.session(session_id).await?;
        let mut guard = session.lock().await;
        if let Some(tx) = guard.pending.remove(request_id) {
            let _ = tx.send(result);
            Ok(json!({ "accepted": true }))
        } else {
            anyhow::bail!("no pending request {}", request_id)
        }
    }

    /// Compact one session in place: prune stale tool results, summarize the
    /// middle of the transcript with a single model call, and rewrite
    /// `messages` as `[head, summary, tail]` (`compaction::apply`). Replaced
    /// turns are soft-archived under the session file's `archived` key before
    /// the rewrite, so nothing is destroyed. Serves both the
    /// `session_compact` RPC and the auto-trigger in the chat loop.
    ///
    /// The summary is a multi-second model call made with the session lock
    /// dropped, and core is an HTTP API: a second turn can append to the same
    /// session meanwhile (the client-side busy guard only covers one client).
    /// So the swap is conditional. The transcript's length and generation are
    /// captured before the await and re-checked under the lock after it; a
    /// clean appended tail is re-merged onto the compacted result, and
    /// anything else refuses with a "transcript moved" error rather than
    /// destroying the appended turns. Dropping an appended assistant
    /// `tool_calls` message is the expensive case — the next turn would push
    /// tool results answering a call the provider can no longer see, and the
    /// whole session 400s.
    pub async fn compact_session(
        &self,
        state: &AppState,
        session_id: &str,
        instructions: CompactInstructions<'_>,
        trigger: CompactTrigger,
    ) -> Result<Value> {
        use crate::compaction;
        let session = self.session(session_id).await?;
        let config = { state.config.read().await.clone() };
        let (mut messages, snapshot_len, generation, model_context, steer) = {
            let mut guard = session.lock().await;
            // The steer is stored before any work: it outlives this call and
            // shapes the automatic compactions that follow it.
            match instructions {
                CompactInstructions::Unchanged => {}
                CompactInstructions::Clear => guard.compaction_instructions = None,
                CompactInstructions::Set(text) => {
                    guard.compaction_instructions = Some(text.trim().to_string())
                }
            }
            (
                guard.messages.clone(),
                guard.messages.len(),
                guard.compactions,
                guard.context_length,
                guard.compaction_instructions.clone(),
            )
        };
        let budget = context_budget_tokens(&config, model_context).max(1) as usize;
        let tokens_before = compaction::estimate_tokens(&messages);
        let Some(bounds) = compaction::select_boundaries(&messages, budget) else {
            return Ok(json!({
                "sessionId": session_id,
                "compacted": false,
                "reason": "nothing to compact",
                "estimatedTokens": tokens_before,
                "trigger": trigger.as_str(),
                "instructions": steer,
            }));
        };
        // Try phase 1 on its own first. Pruning stale tool results costs no
        // model call at all, and when it is enough on its own the whole
        // summarization — a multi-second request, its tokens, and the
        // information the summary inevitably loses — is avoided. Previously
        // pruning only ever ran as a way to shrink the summary request, so
        // every crossing of the budget paid for a summary even when simply
        // dropping yesterday's tool output would have done.
        //
        // Done under the lock with no await inside, so there is no window for
        // a concurrent turn to append between the decision and the swap.
        // Pruned on the local copy first, never on the session. Pruning is
        // lossy, and every path below this can still refuse — a refusal that
        // had already truncated the user's tool results would degrade the
        // transcript as the price of doing nothing.
        let pruned = compaction::prune_old_tool_results(&mut messages, bounds.tail_start);
        let pruned_tokens = compaction::estimate_tokens(&messages);
        if pruned > 0 && pruned_tokens <= budget {
            // Enough on its own, so the summarization is skipped entirely: no
            // model call, no tokens, and none of the detail a summary
            // inevitably loses. Previously pruning only ever shrank the summary
            // request, so crossing the budget always paid for a summary even
            // when dropping yesterday's tool output would have done.
            //
            // Applied in place under the lock rather than swapping the copy in:
            // a concurrent turn may have appended past `snapshot_len`, and
            // those messages sit beyond `tail_start` where pruning does not
            // reach. No await inside, so the check and the write are atomic.
            let mut guard = session.lock().await;
            if guard.compactions != generation || guard.messages.len() < snapshot_len {
                anyhow::bail!(
                    "transcript moved during compaction of session {session_id}: another \
                     compaction rewrote it while pruning; retry"
                );
            }
            let applied =
                compaction::prune_old_tool_results(&mut guard.messages, bounds.tail_start);
            let after = compaction::estimate_tokens(&guard.messages);
            let result = json!({
                "sessionId": session_id,
                "compacted": true,
                "strategy": "prune",
                "prunedToolResults": applied,
                "estimatedTokensBefore": tokens_before,
                "estimatedTokensAfter": after,
                "estimatedTokens": after,
                "summarized": false,
                "trigger": trigger.as_str(),
                "instructions": steer,
            });
            // Pruning is a compaction too. Without this event the transcript
            // showed nothing at all for the cheap path, so an auto-compaction
            // that only pruned looked like a context meter dropping on its own.
            let mut event = result.clone();
            event["type"] = json!("agent.compacted");
            let _ = self.events.send(event);
            return Ok(result);
        }
        let request = compaction::build_summary_request(&messages, &bounds, steer.as_deref());
        let summary = model::chat(&config, &request, None, None).await?.content;
        let summary = summary.trim();
        if summary.is_empty() {
            anyhow::bail!("compaction summary model call returned no content");
        }
        let archived: Vec<Value> = messages[bounds.head_end..bounds.tail_start].to_vec();
        let mut merged = compaction::apply(&messages, &bounds, summary);

        // Everything below runs under the lock, archive write included, so
        // the re-check and the swap are one atomic step: a turn that appends
        // between them would otherwise be dropped by exactly the race this
        // guards. The write is a small local JSON file and this session is
        // already stalled behind the summary call.
        let mut guard = session.lock().await;
        if guard.compactions != generation || guard.messages.len() < snapshot_len {
            anyhow::bail!(
                "transcript moved during compaction of session {session_id}: another \
                 compaction rewrote it while the summary was in flight; retry"
            );
        }
        let appended = guard.messages.len() - snapshot_len;
        if appended > 0 {
            // Re-merge rather than refuse when the appended suffix is a clean
            // tail — a concurrent turn's work survives and the ordering is
            // exactly what it would have been.
            if !suffix_is_clean_tail(&merged, &guard.messages[snapshot_len..]) {
                anyhow::bail!(
                    "transcript moved during compaction of session {session_id}: {appended} \
                     message(s) appended while the summary was in flight answer tool calls \
                     that compaction removed, so they cannot be re-merged; retry"
                );
            }
            merged.extend_from_slice(&guard.messages[snapshot_len..]);
        }
        let tokens_after = compaction::estimate_tokens(&merged);
        // Archive before swapping the live transcript: if the disk write
        // fails, the session keeps its full history and the user can retry.
        crate::sessions::archive_turns(&state.sessions_root, session_id, &archived)
            .context("archiving compacted turns")?;
        guard.messages = merged;
        guard.compactions += 1;
        // Estimate the new occupancy so the auto-trigger doesn't refire
        // until a real model call reports fresh usage.
        guard.last_prompt_tokens = tokens_after as u64;
        drop(guard);

        let result = json!({
            "sessionId": session_id,
            "compacted": true,
            "strategy": "summarize",
            "archivedMessages": archived.len(),
            "remergedMessages": appended,
            "prunedToolResults": pruned,
            "estimatedTokensBefore": tokens_before,
            "estimatedTokensAfter": tokens_after,
            "trigger": trigger.as_str(),
            "instructions": steer,
        });
        let mut event = result.clone();
        event["type"] = json!("agent.compacted");
        let _ = self.events.send(event);
        Ok(result)
    }

    pub async fn sessions(&self) -> Vec<Value> {
        let guard = self.sessions.lock().await;
        guard
            .iter()
            .map(|(id, session)| json!({ "id": id, "messages": session.try_lock().map(|s| s.messages.len()).unwrap_or(0) }))
            .collect()
    }

    async fn get_or_create(&self, session_id: Option<&str>) -> Result<Arc<Mutex<AgentSession>>> {
        let mut guard = self.sessions.lock().await;
        if let Some(id) = session_id {
            if let Some(session) = guard.get(id) {
                return Ok(session.clone());
            }
            anyhow::bail!("session {} not found", id);
        }
        // Sessions were never evicted - including ones created by a chat that
        // failed on its first model call, since get_or_create runs before
        // model::chat. A long-lived core accumulated them along with their
        // full message history, base64 screenshots included.
        if guard.len() >= MAX_SESSIONS {
            // An idle-looking session is not necessarily idle. A session
            // parked on a browser-tool oneshot holds no lock — it registered
            // its sender in `pending` and released — so try_lock alone happily
            // evicts it, after which agent_tool_result answers "session not
            // found" and the tool hangs to its 300s timeout. Non-empty
            // `pending` means somebody is waiting on a reply: never a victim.
            //
            // Approvals are no longer in that map, so they have to be asked
            // about separately or an approval-parked session looks idle.
            let mut candidates: Vec<String> = guard
                .iter()
                .filter(|(_, session)| {
                    session
                        .try_lock()
                        .is_ok_and(|session| session.pending.is_empty())
                })
                .map(|(id, _)| id.clone())
                .collect();
            candidates.sort();
            let wanted = guard.len() + 1 - MAX_SESSIONS;
            let mut victims: Vec<String> = Vec::with_capacity(wanted);
            for id in candidates {
                if victims.len() >= wanted {
                    break;
                }
                if self.approvals.waits_on_session(&id).await {
                    continue;
                }
                victims.push(id);
            }
            for id in victims {
                guard.remove(&id);
            }
            tracing::debug!(sessions = guard.len(), "evicted idle agent sessions");
        }

        let id = format!("session-{}", Uuid::new_v4().simple());
        let session = Arc::new(Mutex::new(AgentSession {
            id: id.clone(),
            messages: Vec::new(),
            pending: HashMap::new(),
            cancel: CancellationToken::default(),
            always_allow: Vec::new(),
            world_state: None,
            compaction_failures: 0,
            context_length: None,
            usage: model::Usage::default(),
            last_prompt_tokens: 0,
            compactions: 0,
            compaction_instructions: None,
        }));
        guard.insert(id, session.clone());
        Ok(session)
    }

    async fn session(&self, session_id: &str) -> Result<Arc<Mutex<AgentSession>>> {
        let guard = self.sessions.lock().await;
        guard.get(session_id).cloned().context("session not found")
    }

    /// Bring a durable session back into memory after core forgot it.
    ///
    /// In-memory sessions do not survive a core restart, and `MAX_SESSIONS`
    /// eviction retires them long before that. Without this the resumed id
    /// simply failed, and the client's recovery path created a *different*
    /// session and replayed into it — so the file the user thought they were
    /// resuming was orphaned mid-conversation, and the work continued under an
    /// id their history list never showed.
    ///
    /// What comes back is what was persisted: the durable record holds the
    /// panel's own user/assistant transcript, never provider-shaped tool calls,
    /// so tool results are gone either way. Continuing the same conversation
    /// under the same id is the part that was recoverable and was being lost.
    async fn rehydrate_from_disk(&self, state: &AppState, id: &str) -> Result<()> {
        let record = crate::sessions::load(&state.sessions_root, id).with_context(|| {
            format!("session {id} is not in memory and has no saved transcript to restore")
        })?;
        let messages = provider_messages_from_record(&record);
        tracing::info!(
            session = %id,
            messages = messages.len(),
            "rehydrated a durable session core had forgotten"
        );
        self.restore_session(id, &messages).await
    }

    fn build_tools(
        &self,
        registered: &HashMap<String, ToolDef>,
        rules: &[PermissionRule],
    ) -> Vec<ToolDef> {
        let mut defs = core_tool_defs();
        defs.extend(registered.values().cloned());
        // Provider selection is global application state. Only the user's
        // model picker may mutate it; exposing model_switch to one agent let
        // that task silently reroute every other session and persist the
        // change across restarts.
        defs.retain(|def| def.name != "model_switch" && def.name != "editor_model_switch");
        // A live editor owns the transaction around image-to-3D generation:
        // it saves first, reopens the generated metadata, and only then
        // exposes the asset to the scene. Hiding the raw core schema prevents
        // an attached model from choosing the split-brain path; headless
        // sessions still receive `image3d_mesh` when no browser wrapper exists.
        let has_live_image3d_wrapper = registered.values().any(|def| {
            def.name == "editor_image3d_mesh" && def.kind == crate::tools::ToolKind::Browser
        });
        if has_live_image3d_wrapper {
            defs.retain(|def| def.name != "image3d_mesh");
        }
        // The editor wrapper captures and persists in one browser call. The
        // raw core schema requires replaying a multi-megabyte data URL through
        // the model, where result bounding can truncate it and providers may
        // reject the payload. Keep the raw tool for headless callers only.
        let has_live_capture_wrapper = registered.values().any(|def| {
            def.name == "editor_persist_capture" && def.kind == crate::tools::ToolKind::Browser
        });
        if has_live_capture_wrapper {
            defs.retain(|def| def.name != "capture_persist");
        }
        // `deny` rules hide the tool from the model entirely; the gate in
        // execute_tool_call is the backstop for hallucinated calls.
        defs.retain(|def| rule_decision(rules, &def.name) != Some(RuleAction::Deny));
        // HashMap iteration is randomized per process. Provider prompt caches
        // key the serialized prefix, so a different browser/MCP tool order on
        // restart invalidates the whole otherwise-identical system prefix.
        // Exact-name sorting also makes snapshots and provider traces stable.
        defs.sort_by(|left, right| left.name.cmp(&right.name));
        defs
    }

    fn emit_tool_started(
        &self,
        session_id: &str,
        call: &ToolCall,
        started_at_ms: u64,
        options: &AgentOptions,
    ) {
        let _ = self.events.send(json!({
            "type": "agent.tool_started",
            "sessionId": session_id,
            "tool": call.name,
            "toolCallId": call.id,
            "startedAtMs": started_at_ms,
            "projectSlug": options.project_slug,
            "workspaceRoot": options.workspace_root,
            "arguments": call.arguments
        }));
    }

    async fn execute_tool_call_outcome(
        &self,
        context: &ToolExecutionContext<'_>,
        call: &ToolCall,
        over_cap: bool,
        started_at_ms: u64,
    ) -> Value {
        let outcome = if over_cap {
            Err(anyhow::anyhow!(
                "subagent fan-out cap reached: at most {MAX_SPAWNS_PER_TURN} subagent_spawn calls per turn"
            ))
        } else {
            self.execute_tool_call(
                context.state,
                context.registered,
                &context.session,
                context.sid,
                call,
                context.options,
            )
            .await
        };
        let mut outcome = match outcome {
            Ok(value) => value,
            Err(error) => json!({ "error": error.to_string() }),
        };
        let activity = take_internal_activity(&mut outcome);
        let finished_at_ms = unix_time_ms();
        let mut event = json!({
            "type": "agent.tool_finished",
            "sessionId": context.sid,
            "tool": call.name,
            "toolCallId": call.id,
            "startedAtMs": started_at_ms,
            "finishedAtMs": finished_at_ms,
            "projectSlug": context.options.project_slug,
            "workspaceRoot": context.options.workspace_root,
            "result": outcome
        });
        if let Some(activity) = activity {
            event["activity"] = activity;
        }
        let _ = self.events.send(event);
        outcome
    }

    async fn execute_tool_call(
        &self,
        state: &AppState,
        registered: &HashMap<String, ToolDef>,
        session: &Arc<Mutex<AgentSession>>,
        sid: &str,
        call: &ToolCall,
        options: &AgentOptions,
    ) -> Result<Value> {
        // Before anything is looked up: arguments that never parsed must not
        // reach a tool as an empty object. The tool would then report whatever
        // field it checks first as missing, which sends the model back to fix
        // an argument it actually sent.
        if let Some(raw) = call.unparsed_arguments.as_deref() {
            let max_tokens = state.config.read().await.model.max_tokens;
            anyhow::bail!(unparsed_arguments_error(&call.name, raw, max_tokens));
        }
        // Backstop the schema filter above: a provider can hallucinate a
        // tool name that was never advertised, and that must not become a
        // path to changing global model state.
        if call.name == "model_switch" || call.name == "editor_model_switch" {
            anyhow::bail!(
                "model selection is user-controlled; choose a model from the CaliCode model picker"
            );
        }
        let core_def = core_tool_defs().into_iter().find(|d| d.name == call.name);
        let def = if let Some(def) = core_def {
            def
        } else {
            registered
                .get(&call.name)
                .cloned()
                .context("tool not registered")?
        };

        // Approvals surface on the root ancestor's session when this agent is
        // a subagent — the client only watches the session it opened, so a
        // prompt emitted under a child session id would hang unanswered.
        let root_sid = options
            .approval_session
            .clone()
            .unwrap_or_else(|| sid.to_string());
        // Whose panel this work belongs to. Resolved once, here, because
        // `OwnSession` means *this* agent's session and must not be re-pointed
        // by anything downstream.
        let owner_sid = options.approval_owner.resolve(sid);

        // Plan mode is a dispatch gate, not an approval question: outside
        // the read-only whitelist nothing runs — not even under an `allow`
        // rule — and the model gets a refusal tool result to plan around.
        if options.permission_mode == "plan" && !plan_mode_allows(&def.name) {
            anyhow::bail!(
                "plan mode: tool '{}' is unavailable (read-only inspection only) — describe the intended change instead of applying it",
                def.name
            );
        }

        let mcp_trusted =
            def.kind == crate::tools::ToolKind::Mcp && state.mcp.is_trusted(&def.name).await;
        // Config permission rules run BEFORE mode logic (last match wins):
        // `deny` rejects outright, `allow` skips the prompt, `ask` forces
        // one; only unmatched tools fall through to the mode's own policy.
        let needs_approval = match tool_gate(
            &options.permission_rules,
            &options.permission_mode,
            &def.name,
            mcp_trusted,
        ) {
            Gate::Deny => anyhow::bail!("tool '{}' is denied by permission rules", def.name),
            Gate::Prompt => true,
            Gate::Run => false,
        };
        if needs_approval {
            // The one window that may answer. Keyed on the *owner* session, not
            // the answer address: the owner is the panel that asked for this
            // work. Deliberately without the browser-tool path's extra
            // project/workspace re-check — `editor_attach` already refuses to
            // record an attachment whose session is bound elsewhere
            // (`rpc.rs`), so a second check here would only add a way for a
            // graph node whose options spell the workspace differently to
            // produce `targetClientId: null` and park every node.
            let target_client_id = match owner_sid {
                Some(owner) => state
                    .editor_attachment
                    .read()
                    .await
                    .get(owner)
                    .map(|attachment| attachment.client_id.clone()),
                None => None,
            };
            // The answer address stays the root ancestor's session so an older
            // client that still keys on it is not misled; the registry holds it
            // as data, so there is no parent session handle to find.
            let outcome = self
                .approvals
                .request(crate::approvals::ApprovalRequest {
                    answer_session: &root_sid,
                    target_client_id,
                    owner_session: owner_sid.map(str::to_string),
                    owner_graph: options.owner_graph.clone(),
                    asking_session: sid,
                    tool: &def.name,
                    arguments: call.arguments.clone(),
                })
                .await;
            match outcome {
                crate::approvals::ApprovalOutcome::Approved => {}
                // A human clicked Deny. The only sentence in core that may say
                // "denied".
                crate::approvals::ApprovalOutcome::Denied(reason) => match reason {
                    // The words are the point. A bare denial teaches the model
                    // only that the door is shut, so it tries the same door;
                    // "not that file, edit the config instead" redirects it.
                    Some(reason) => anyhow::bail!(
                        "approval denied for {}. The user said: {reason}. Treat that as the \
                         instruction — do not retry this call unchanged.",
                        def.name
                    ),
                    None => anyhow::bail!("approval denied for {}", def.name),
                },
                // Nobody answered. Naming the real cause keeps a cancelled run
                // and a timeout from being reported to the model — and read
                // back by a human in the transcript — as a decision somebody
                // made.
                crate::approvals::ApprovalOutcome::Abandoned(reason) => {
                    anyhow::bail!("approval for {} was abandoned ({reason})", def.name)
                }
            }
        }

        if def.kind == crate::tools::ToolKind::Core {
            if def.name == "subagent_spawn" {
                // Children inherit this agent's permission mode — never wider
                // — and route their approvals to the same root session. Going
                // through execute_core_tool here would run the child at the
                // legacy full-access default.
                let parent = crate::tools::SpawnParent {
                    permission_mode: options.permission_mode.clone(),
                    reasoning_effort: options.reasoning_effort.clone(),
                    approval_session: root_sid,
                    // Resolved here, not in the child: `OwnSession` means
                    // *this* agent's session, and handing the variant down
                    // would re-point it at the child's own id.
                    owner_session: owner_sid.map(str::to_string),
                    // A graph node's own subagent is still the graph's work.
                    // Without this the grandchild's prompts named no run.
                    owner_graph: options.owner_graph.clone(),
                    depth: options.subagent_depth,
                    permission_rules: options.permission_rules.clone(),
                    workspace_root: options.workspace_root.clone(),
                    context_length: options.context_length,
                };
                return crate::tools::spawn_subagent_for_parent(state, &call.arguments, parent)
                    .await;
            }
            return execute_core_tool_with_activity(
                &def,
                &call.arguments,
                state,
                &state.projects_root,
                options.workspace_root.as_deref().map(std::path::Path::new),
                true,
            )
            .await;
        }

        // MCP tools proxy to their server; the per-server timeout_secs is
        // applied inside the client, so no wrapper here.
        if def.kind == crate::tools::ToolKind::Mcp {
            return state.mcp.call(&def.name, &call.arguments).await;
        }

        let request_id = format!("tool-{}", Uuid::new_v4().simple());
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = session.lock().await;
            guard.pending.insert(request_id.clone(), tx);
        }
        // Broadcast is shared by every open frontend. Include the owner
        // client when the session is attached so foreign panels ignore this
        // request instead of racing to answer the pending oneshot.
        let target_client_id = {
            let attachments = state.editor_attachment.read().await;
            attachments.get(&root_sid).and_then(|attachment| {
                let project_matches = options
                    .project_slug
                    .as_deref()
                    .is_some_and(|project| project == attachment.project_slug);
                let workspace_matches = options.workspace_root.as_deref().is_some_and(|root| {
                    crate::editor_bridge::same_path(root, &attachment.workspace_root)
                });
                (project_matches && workspace_matches).then(|| attachment.client_id.clone())
            })
        };
        let mut event = json!({
            "type": "agent.tool_request",
            "sessionId": sid,
            "targetSessionId": root_sid,
            "projectSlug": options.project_slug,
            "workspaceRoot": options.workspace_root,
            "requestId": request_id,
            "tool": def.name,
            "arguments": call.arguments
        });
        if let Some(client_id) = target_client_id {
            event["targetClientId"] = json!(client_id);
        }
        let _ = self.events.send(event);
        match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
            Ok(inner) => inner.context("browser tool channel closed"),
            Err(_) => {
                session.lock().await.pending.remove(&request_id);
                anyhow::bail!("browser tool {} timed out", def.name)
            }
        }
    }
}

/// What to tell the model when its own tool call did not arrive as JSON.
///
/// The two causes need different advice, and the parser can tell them apart:
/// text that ends while a value is still open was cut off in flight — almost
/// always the turn reaching its output-token cap partway through a long
/// argument — while text that is complete but malformed is the model's own
/// mistake. Naming the cap matters because retrying the same call unchanged
/// hits the same ceiling at the same place.
fn unparsed_arguments_error(tool: &str, raw: &str, max_tokens: Option<u32>) -> String {
    let cut_off = serde_json::from_str::<Value>(raw)
        .err()
        .is_some_and(|error| error.classify() == serde_json::error::Category::Eof);
    if !cut_off {
        return format!(
            "the arguments for {tool} were not valid JSON ({} bytes), so nothing ran. Send the \
             call again with a well-formed arguments object.",
            raw.len()
        );
    }
    let cap = match max_tokens {
        Some(limit) => format!(" This turn's output cap is {limit} tokens (model.max_tokens)."),
        None => String::new(),
    };
    format!(
        "the arguments for {tool} arrived cut off — {} bytes ending mid-value — so nothing ran.{cap} \
         Retrying the same call unchanged will stop in the same place: split the work into smaller \
         calls (write a short first chunk, then extend it with file_edit), or ask the user to raise \
         the cap.",
        raw.len()
    )
}

fn assistant_tool_call(call: &ToolCall) -> Value {
    json!({
        "id": call.id,
        "type": "function",
        "function": {
            "name": call.name,
            "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".into())
        }
    })
}

/// One entry under config `permissions:` — `pattern` is a tool-name glob
/// (`*` matches any run, `?` one char, `[abc]`/`[a-z]`/`[!abc]` character
/// classes), `action` is `allow` | `ask` | `deny`. Matching is
/// [`crate::mcp::glob_match`], the one glob dialect shared with MCP tool
/// filters — a pattern means the same thing in both places.
/// Rules are evaluated in order and the LAST match wins, so
/// specific rules belong after broad ones and per-project rules (appended
/// after global ones by the config merge) override them naturally.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct PermissionRule {
    pub pattern: String,
    pub action: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleAction {
    Allow,
    Ask,
    Deny,
}

/// Last matching rule wins; `None` means no rule matched and the mode's own
/// logic decides. An unrecognized action fails closed to `Ask` rather than
/// silently allowing (or bricking) the tool.
pub fn rule_decision(rules: &[PermissionRule], tool: &str) -> Option<RuleAction> {
    let mut decision = None;
    for rule in rules {
        if crate::mcp::glob_match(&rule.pattern, tool) {
            decision = Some(match rule.action.as_str() {
                "allow" => RuleAction::Allow,
                "deny" => RuleAction::Deny,
                _ => RuleAction::Ask,
            });
        }
    }
    decision
}

/// Rule layer stacked over mode layer: what actually happens to a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gate {
    Deny,
    Prompt,
    Run,
}

fn tool_gate(rules: &[PermissionRule], mode: &str, tool: &str, mcp_trusted: bool) -> Gate {
    match rule_decision(rules, tool) {
        Some(RuleAction::Deny) => Gate::Deny,
        Some(RuleAction::Allow) => Gate::Run,
        Some(RuleAction::Ask) => Gate::Prompt,
        None if requires_approval(mode, tool, mcp_trusted) => Gate::Prompt,
        None => Gate::Run,
    }
}

/// Every tool plan mode may dispatch, by exact name. Kept in
/// `is_destructive`'s module so the two classifications evolve together.
///
/// Membership means all three of: reads only, touches nothing outside the
/// projects root, and makes no network request. Names are exact because the
/// list is a security boundary — see `plan_mode_allows`.
///
/// Deliberately absent, and why:
/// - `asset_search` — its `polyhaven` source is an outbound HTTP query, so a
///   "read-only" planning turn would still send the project's vocabulary to a
///   third party and burn quota. Plan mode is where a user expects *nothing*
///   to leave the machine; local discovery (`file_glob`, `asset_usage`) still
///   works, and the search runs the moment they leave plan mode.
/// - `project_open` stays in: unlike `asset_search` it is a pure local read of
///   `<root>/<slug>` with no egress.
/// - `graph_plan`, `test_baseline_save`, `asset_hash_dedupe`,
///   `asset_export_gltf` — each persists something under the projects root.
/// - `editor_select_entity`, `editor_asset_builder_open` — cheap, but they
///   move the user's editor out from under them mid-plan.
/// - anything under `mcp__` — the core cannot know what a third-party server
///   does with a call, trusted or not.
const PLAN_MODE_TOOLS: &[&str] = &[
    // Core: local reads.
    "file_read",
    "file_list",
    "file_grep",
    "file_glob",
    "skill_list",
    "skill_load",
    "model_list",
    "project_list",
    "project_open",
    "graph_status",
    "graph_list",
    "loop_report_list",
    "loop_report_open",
    "template_list",
    "asset_usage",
    "test_baseline_compare",
    "image3d_validate",
    // Browser/editor: the inspect-and-report corner of that namespace.
    // The rest of `editor_*` mutates the scene, writes files, or spends
    // money on generation. Mirrors client/src/lib/useBrowserTools.ts.
    "editor_scene_inspect",
    "editor_capture_frame",
    "editor_asset_builder_state",
    "editor_console_log",
    // The browser's read-only half. Research is exactly what plan mode is
    // for, so reading the web is admitted — but not `browser_click`,
    // `browser_type`, `browser_key` or `browser_eval`, which act on someone
    // else's server and can post, buy, or delete on the far side of a page
    // this gate cannot see. `browser_look` is out too — it is read-only, but
    // it spends on a vision call, and the whitelist and `is_destructive` are
    // held disjoint by a test.
    "browser_navigate",
    "browser_search",
    "browser_snapshot",
    "browser_scroll",
    "browser_console",
];

/// Whether plan mode may dispatch this tool at all.
///
/// Exact names only — no prefix or substring rule. This used to admit any
/// `editor_*` tool whose name contained "inspect"/"capture" or ended in
/// `_state`/`_log`, which reads the tool's *name* as if it were its
/// contract: a later `editor_capture_and_overwrite` or
/// `editor_inspect_and_repair` would have walked straight through the
/// read-only gate on the day it was registered. No prefix in this harness is
/// provably safe — `editor_` and `file_` each span readers and writers, and
/// `mcp__` is opaque by definition — so the gate fails closed and a new
/// read-only tool must be added to `PLAN_MODE_TOOLS` by hand.
pub fn plan_mode_allows(tool: &str) -> bool {
    PLAN_MODE_TOOLS.contains(&tool)
}

/// Tools that change something outside the current scene, or that cost money.
/// These are what a permission mode is actually protecting.
///
/// MCP tools are destructive unless their server is configured `trust: true` —
/// the core cannot know what a third-party tool does.
fn is_destructive(tool: &str, mcp_trusted: bool) -> bool {
    if tool.starts_with(crate::mcp::MCP_PREFIX) {
        return !mcp_trusted;
    }
    // Core tools answer from their own definition, so the classification lives
    // beside the tool rather than in a list somewhere else that a new tool can
    // be added without touching. `ToolDef::access` is a required field, which
    // is what makes that impossible rather than merely unlikely.
    if let Some(access) = crate::tools::core_tool_access(tool) {
        return access == crate::tools::Access::Guarded;
    }
    // Everything below is registered at runtime — editor tools over
    // `tool_register`, plus RPC-only surfaces that never appear in
    // `core_tool_defs` — so there is no literal to enforce and the name is all
    // there is to go on.
    matches!(
        tool,
        "project_save" | "project_create" | "project_asset_write"
    ) || tool.starts_with("workspace_file_write")
        || tool.starts_with("devserver_")
}

/// Whether a tool call needs the user to say yes first.
///
/// This used to be inverted and half-decorative. `auto-accept-edits`
/// auto-accepted `file_write`, `project_checkpoint`, and every scene-mutating
/// browser tool while prompting only for revert and image3d; and `auto` and
/// `full-access` both fell through to the same `_ => false`, so the "Auto"
/// entry in the UI dropdown changed nothing at all.
fn requires_approval(mode: &str, tool: &str, mcp_trusted: bool) -> bool {
    match mode {
        // Ask before every tool call.
        "supervised" => true,
        // Scene edits flow; anything that writes outside the scene asks.
        "auto-accept-edits" => is_destructive(tool, mcp_trusted),
        // Ask only for the genuinely irreversible ones — plus untrusted MCP
        // tools, whose behavior the core cannot vouch for, and the dev server,
        // which runs a script out of the workspace's own package.json. Nothing
        // here is a sandbox: an unprompted `devserver_start` is arbitrary code
        // execution from a cloned repo, on the user's account, so it asks.
        "auto" => {
            matches!(tool, "project_revert" | "file_write" | "file_edit")
                || tool.starts_with("workspace_file_write")
                || tool.starts_with("devserver_")
                || (tool.starts_with(crate::mcp::MCP_PREFIX) && !mcp_trusted)
        }
        // No prompts. Explicitly opted into.
        "full-access" => false,
        // Plan mode: dispatch is already restricted to the read-only
        // whitelist upstream; whitelisted tools flow without prompts, and
        // anything else stays fail-closed should a caller skip that gate.
        "plan" => !plan_mode_allows(tool),
        // Unknown modes fail closed rather than silently granting everything.
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AppConfig, ModelConfig};
    use axum::extract::State;
    use axum::response::sse::{Event, Sse};
    use axum::routing::post;
    use axum::Router;
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn missing_graph_goal_is_repaired_from_latest_user_turn_only() {
        let mut calls = vec![ToolCall {
            id: "call-plan".into(),
            name: "graph_plan".into(),
            arguments: Value::Null,
            unparsed_arguments: None,
        }];
        repair_missing_graph_goal(
            &mut calls,
            &[
                json!({ "role": "user", "content": "old objective" }),
                json!({ "role": "assistant", "content": "working" }),
                json!({ "role": "user", "content": "  build Neon Relay  " }),
            ],
        );
        assert_eq!(calls[0].arguments["goal"], json!("build Neon Relay"));
        assert_eq!(calls[0].arguments.as_object().unwrap().len(), 1);
    }

    #[test]
    fn graph_goal_repair_preserves_provider_goal_and_ignores_other_tools() {
        let mut calls = vec![
            ToolCall {
                id: "call-plan".into(),
                name: "graph_plan".into(),
                arguments: json!({ "goal": "provider goal", "nodes": [] }),
                unparsed_arguments: None,
            },
            ToolCall {
                id: "call-list".into(),
                name: "project_list".into(),
                arguments: json!({}),
                unparsed_arguments: None,
            },
        ];
        repair_missing_graph_goal(
            &mut calls,
            &[json!({ "role": "user", "content": "different user goal" })],
        );
        assert_eq!(calls[0].arguments["goal"], json!("provider goal"));
        assert_eq!(calls[0].arguments["nodes"], json!([]));
        assert_eq!(calls[1].arguments, json!({}));
    }

    #[test]
    fn trusted_loop_context_is_injected_and_cannot_be_spoofed() {
        let options = AgentOptions {
            project_slug: Some("active-project".into()),
            loop_id: Some("loop-active".into()),
            ..Default::default()
        };
        let mut arguments = json!({
            "slug": "other-project",
            "loopId": "loop-other",
            "iteration": { "outcome": "passed" }
        });
        bind_trusted_call_context(
            "loop_report_iteration",
            &mut arguments,
            &options,
            "session-owner",
        );
        assert_eq!(arguments["slug"], "active-project");
        assert_eq!(arguments["loopId"], "loop-active");
        assert_eq!(arguments["iteration"]["outcome"], "passed");
    }

    #[test]
    fn trusted_loop_context_repairs_non_object_arguments() {
        let options = AgentOptions {
            project_slug: Some("active-project".into()),
            loop_id: Some("loop-active".into()),
            ..Default::default()
        };
        let mut arguments = Value::Null;
        bind_trusted_call_context(
            "loop_report_open",
            &mut arguments,
            &options,
            "session-owner",
        );
        assert_eq!(
            arguments,
            json!({ "slug": "active-project", "loopId": "loop-active" })
        );
    }

    fn mock_chat_stream(
        has_tool_result: bool,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let events = if has_tool_result {
            vec![
                Ok(Event::default()
                    .data(r#"{"choices":[{"delta":{"role":"assistant","content":"Echo: "}}]}"#)),
                Ok(Event::default().data(r#"{"choices":[{"delta":{"content":"hello-agent"}}]}"#)),
                Ok(Event::default().data("[DONE]")),
            ]
        } else {
            vec![
                Ok(Event::default().data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"editor_echo","arguments":"{\"message\":\"hello-agent\"}"}}]}}]}"#)),
                Ok(Event::default().data(r#"{"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}]}"#)),
                Ok(Event::default().data("[DONE]")),
            ]
        };
        Sse::new(futures::stream::iter(events))
    }

    async fn mock_provider(
        State(calls): State<Arc<AtomicUsize>>,
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let has_tool_result = body
            .get("messages")
            .and_then(|m| m.as_array())
            .map(|messages| messages.iter().any(|m| m["role"] == "tool"))
            .unwrap_or(false);
        calls.fetch_add(1, Ordering::SeqCst);
        mock_chat_stream(has_tool_result)
    }

    async fn missing_graph_goal_provider(
        State(requests): State<Arc<std::sync::Mutex<Vec<Value>>>>,
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        requests.lock().unwrap().push(body.clone());
        let messages = body["messages"].as_array().cloned().unwrap_or_default();
        let has_tool_result = messages.iter().any(|message| message["role"] == "tool");
        let events = if has_tool_result {
            content_stream("retry safely")
        } else {
            vec![
                Ok(Event::default().data(
                    r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-plan","function":{"name":"graph_plan","arguments":"{}"}}]}}]}"#,
                )),
                Ok(Event::default().data(
                    r#"{"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}]}"#,
                )),
                Ok(Event::default().data("[DONE]")),
            ]
        };
        Sse::new(futures::stream::iter(events))
    }

    #[tokio::test]
    async fn missing_graph_goal_is_repaired_before_provider_history_replay() {
        let requests: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
        let app = Router::new()
            .route("/v1/chat/completions", post(missing_graph_goal_provider))
            .with_state(requests.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (bus, _) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::new();
        let state = make_state(addr, bus, agents.clone(), tools.clone());
        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "Build Neon Relay" })],
                AgentOptions {
                    permission_mode: "full-access".into(),
                    max_turns: 2,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(result["reply"], json!("retry safely"));
        assert_eq!(result["toolCalls"][0]["status"], json!("error"));
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let replayed_call = requests[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["role"] == "assistant" && message["tool_calls"].is_array())
            .expect("assistant tool call replayed");
        let arguments = replayed_call["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("tool arguments are JSON text");
        assert_eq!(
            serde_json::from_str::<Value>(arguments).unwrap()["goal"],
            json!("Build Neon Relay")
        );
        let error = requests[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["role"] == "tool")
            .and_then(|message| message["content"].as_str())
            .unwrap_or_default();
        assert!(error.contains("provide either template"));
    }

    /// Shared state for the drain-mock provider. Tracks every request, lets
    /// the test flip `malicious_drain` to make the schema-less drain call
    /// return a tool call that must not be executed.
    struct DrainMockState {
        requests: std::sync::Mutex<Vec<Value>>,
        malicious_drain: AtomicBool,
        textual_tool_protocol: AtomicBool,
    }

    /// Mock that distinguishes the schema-less drain call from normal calls.
    ///
    /// The drain request omits the `tools` array entirely (see `chat_once`
    /// in `model.rs`); a normal chat request always carries it. The mock
    /// uses that as the boundary and records every call so the test can
    /// assert call count and shape.
    async fn drain_provider(
        State(state): State<Arc<DrainMockState>>,
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let has_tools = body["tools"].is_array();
        let has_tool_result = body
            .get("messages")
            .and_then(|m| m.as_array())
            .map(|messages| messages.iter().any(|m| m["role"] == "tool"))
            .unwrap_or(false);
        // Record the last message so the test can prove the finalization
        // directive was appended to the snapshot before the schema-less
        // drain request went out.
        let last_message = body
            .get("messages")
            .and_then(|m| m.as_array())
            .and_then(|msgs| msgs.last())
            .and_then(|m| m["content"].as_str())
            .unwrap_or("")
            .to_string();
        state.requests.lock().unwrap().push(json!({
            "hasTools": has_tools,
            "hasToolResult": has_tool_result,
            "lastMessage": last_message,
        }));
        let events: Vec<Result<Event, Infallible>> = if !has_tools {
            // Schema-less drain call. A confused or hostile model may still
            // return a tool call here; `final_response_drain` must ignore
            // it (never execute) regardless of which branch the mock picks.
            if state.malicious_drain.load(Ordering::SeqCst) {
                vec![
                    Ok(Event::default().data(
                        r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-malicious","function":{"name":"editor_echo","arguments":"{\"message\":\"never-runs\"}"}}]}}]}"#,
                    )),
                    Ok(Event::default()
                        .data(r#"{"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}]}"#)),
                    Ok(Event::default().data("[DONE]")),
                ]
            } else if state.textual_tool_protocol.load(Ordering::SeqCst) {
                // MiniMax-style: provider tool protocol sits inside the
                // `content` delta and no structured tool_calls are emitted.
                let content = "]<]minimax[>[<tool_call>]<]minimax[>[<invoke name=\"file_read\">\
                     <path>/tmp/cali-final.json</path></invoke></tool_call>";
                vec![
                    Ok(Event::default().data(
                        json!({"choices":[{"delta":{"role":"assistant","content": content}}]})
                            .to_string(),
                    )),
                    Ok(Event::default().data("[DONE]")),
                ]
            } else {
                vec![
                    Ok(Event::default().data(
                        json!({"choices":[{"delta":{"role":"assistant","content":"drained report"}}]})
                            .to_string(),
                    )),
                    Ok(Event::default().data("[DONE]")),
                ]
            }
        } else if has_tool_result {
            // Post-tool normal call: this path is never reached under
            // max_turns=1 because the loop exits for the drain, but the
            // helper still classifies it so the trace is readable if a
            // future test bumps the budget.
            vec![
                Ok(Event::default().data(
                    json!({"choices":[{"delta":{"role":"assistant","content":"normal report"}}]})
                        .to_string(),
                )),
                Ok(Event::default().data("[DONE]")),
            ]
        } else {
            // Initial call: editor_echo tool call.
            vec![
                Ok(Event::default().data(
                    r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-echo","function":{"name":"editor_echo","arguments":"{\"message\":\"hello\"}"}}]}}]}"#,
                )),
                Ok(Event::default()
                    .data(r#"{"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}]}"#)),
                Ok(Event::default().data("[DONE]")),
            ]
        };
        Sse::new(futures::stream::iter(events))
    }
    fn make_state(
        addr: std::net::SocketAddr,
        bus: tokio::sync::broadcast::Sender<Value>,
        agents: AgentManager,
        tools: HashMap<String, ToolDef>,
    ) -> crate::AppState {
        let config = AppConfig {
            model: ModelConfig {
                default: "mock".into(),
                provider: "mock".into(),
                base_url: format!("http://{}/v1", addr),
                api_key_env: "CALI_MOCK_KEY".into(),
                temperature: 0.0,
                max_tokens: Some(128),
                roles: Default::default(),
            },
            providers: vec![],
            ..Default::default()
        };
        crate::AppState {
            config: std::sync::Arc::new(tokio::sync::RwLock::new(config)),
            projects_root: tempfile::tempdir().unwrap().path().to_path_buf(),
            sessions_root: tempfile::tempdir().unwrap().path().to_path_buf(),
            agents,
            bus: bus.clone(),
            workspaces: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::workspace::Registry::new(),
            )),
            dev_servers: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::devserver::Servers::new(),
            )),
            terminals: crate::terminal::Terminals::default(),
            browsers: crate::browser::Browsers::new(),
            shutdown: std::sync::Arc::new(tokio::sync::watch::channel(false).0),
            tools: std::sync::Arc::new(tokio::sync::RwLock::new(tools)),
            editor_bridge: crate::editor_bridge::EditorBridge::new(bus.clone()),
            editor_attachment: std::sync::Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            graphs: crate::graph::GraphManager::new(),
            mcp: std::sync::Arc::new(crate::mcp::McpManager::default()),
            asset_catalog: std::sync::Arc::new(tokio::sync::RwLock::new(Vec::new())),
        }
    }

    fn content_stream(text: &str) -> Vec<Result<Event, Infallible>> {
        vec![
            Ok(Event::default().data(
                json!({"choices":[{"delta":{"role":"assistant","content": text}}]}).to_string(),
            )),
            Ok(Event::default().data("[DONE]")),
        ]
    }

    /// Answers with plain text and no tool calls, so a turn ends immediately.
    async fn plain_provider() -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        Sse::new(futures::stream::iter(content_stream("done")))
    }

    async fn reasoning_provider() -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        Sse::new(futures::stream::iter(vec![
            Ok(Event::default().data(
                json!({"choices":[{"delta":{"reasoning_content":"weighing the options"}}]})
                    .to_string(),
            )),
            Ok(Event::default().data(
                json!({"choices":[{"delta":{"role":"assistant","content":"visible answer"}}]})
                    .to_string(),
            )),
            Ok(Event::default().data("[DONE]")),
        ]))
    }

    #[tokio::test]
    async fn a_session_stops_at_its_spend_ceiling_and_says_whose_limit_it_was() {
        let app = Router::new().route("/v1/chat/completions", post(plain_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (bus, _rx) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::new();
        let state = make_state(addr, bus, agents.clone(), tools.clone());
        {
            let mut config = state.config.write().await;
            config.budget.session_tokens = Some(100);
        }

        // A fresh session is under the ceiling and runs normally.
        let first = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "hello" })],
                AgentOptions {
                    permission_mode: "full-access".into(),
                    max_turns: 1,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let session_id = first["sessionId"].as_str().unwrap().to_string();
        assert_eq!(first["status"], json!("completed"));

        // Push the session past the ceiling the way real usage would.
        {
            let session = agents.session(&session_id).await.unwrap();
            session.lock().await.usage.total_tokens = 250;
        }

        let stopped = agents
            .chat(
                &state,
                &tools,
                Some(&session_id),
                &[json!({ "role": "user", "content": "keep going" })],
                AgentOptions {
                    permission_mode: "full-access".into(),
                    max_turns: 5,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(stopped["status"], json!("over_budget"));
        assert_eq!(stopped["tokensSpent"], json!(250));
        assert_eq!(stopped["tokenLimit"], json!(100));
        // Not reported as a runaway: this is the user's own limit doing what
        // they set it to do, and it says how to carry on.
        assert_ne!(stopped["terminalReason"], json!("max_turns"));
        let reply = stopped["reply"].as_str().unwrap();
        assert!(reply.contains("budget.session_tokens"), "{reply}");
        assert!(reply.contains("Nothing is lost"), "{reply}");
        // Refused before paying for another request, not after.
        assert_eq!(stopped["turns"], json!(0));
    }

    #[tokio::test]
    async fn no_ceiling_is_the_default_and_a_zero_ceiling_is_not_a_ceiling() {
        let app = Router::new().route("/v1/chat/completions", post(plain_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (bus, _rx) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::new();
        let state = make_state(addr, bus, agents.clone(), tools.clone());
        assert_eq!(
            state.config.read().await.budget.session_tokens,
            None,
            "a multi-day loop is a legitimate way to spend a lot; off is the right default"
        );
        {
            // Zero must read as "no ceiling" rather than "stop immediately",
            // which is what a bare `> 0` check would otherwise produce.
            let mut config = state.config.write().await;
            config.budget.session_tokens = Some(0);
        }

        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "hello" })],
                AgentOptions {
                    permission_mode: "full-access".into(),
                    max_turns: 1,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(result["status"], json!("completed"));
    }

    #[tokio::test]
    async fn a_second_turn_is_told_what_changed_in_the_project() {
        // The whole point, end to end: the system prompt describes the world
        // once, so without a diff the model spends a long session reasoning
        // about a project that stopped existing after its first edit.
        let app = Router::new().route("/v1/chat/completions", post(plain_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let projects = tempfile::tempdir().unwrap();
        crate::store::create_project(projects.path(), "demo", "Demo").unwrap();

        let (bus, _rx) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::new();
        let mut state = make_state(addr, bus, agents.clone(), tools.clone());
        state.projects_root = projects.path().to_path_buf();

        let options = || AgentOptions {
            permission_mode: "full-access".into(),
            max_turns: 1,
            project_slug: Some("demo".into()),
            ..Default::default()
        };

        let first = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "start" })],
                options(),
            )
            .await
            .unwrap();
        let session_id = first["sessionId"].as_str().unwrap().to_string();

        let reminders = |messages: &[Value]| -> usize {
            messages
                .iter()
                .filter(|m| {
                    m["content"]
                        .as_str()
                        .is_some_and(|c| c.contains("Since you were last told"))
                })
                .count()
        };

        let session = agents.session(&session_id).await.unwrap();
        assert_eq!(
            reminders(&session.lock().await.messages),
            0,
            "the first turn's prompt already described the world"
        );

        // Nothing changed: a second turn must cost nothing extra.
        agents
            .chat(
                &state,
                &tools,
                Some(&session_id),
                &[json!({ "role": "user", "content": "again" })],
                options(),
            )
            .await
            .unwrap();
        assert_eq!(
            reminders(&session.lock().await.messages),
            0,
            "an unchanged world must not produce a reminder"
        );

        // Now change the project out from under the session, the way the
        // agent's own edits do.
        let mut project = crate::store::read_project(projects.path(), "demo").unwrap();
        project["entities"] = json!([{ "name": "Platform" }, { "name": "Hero" }]);
        crate::store::write_project(projects.path(), "demo", &project).unwrap();

        agents
            .chat(
                &state,
                &tools,
                Some(&session_id),
                &[json!({ "role": "user", "content": "carry on" })],
                options(),
            )
            .await
            .unwrap();

        let guard = session.lock().await;
        assert_eq!(
            reminders(&guard.messages),
            1,
            "a changed project must be reported exactly once"
        );
        let text = guard
            .messages
            .iter()
            .find_map(|m| {
                m["content"]
                    .as_str()
                    .filter(|c| c.contains("Since you were last told"))
            })
            .unwrap();
        assert!(text.contains("project is now:"), "{text}");
        assert!(text.contains("Platform"), "{text}");
    }

    #[tokio::test]
    async fn streamed_reasoning_is_published_separately_and_stays_out_of_the_transcript() {
        let app = Router::new().route("/v1/chat/completions", post(reasoning_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (bus, mut rx) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::new();
        let state = make_state(addr, bus, agents.clone(), tools.clone());
        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "think then answer" })],
                AgentOptions {
                    permission_mode: "full-access".into(),
                    max_turns: 2,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let session_id = result["sessionId"].as_str().unwrap().to_string();
        assert_eq!(result["reply"], json!("visible answer"));

        let mut reasoning = Vec::new();
        let mut deltas = Vec::new();
        while let Ok(event) = rx.try_recv() {
            match event["type"].as_str() {
                Some("agent.reasoning") => reasoning.push(event),
                Some("agent.delta") => deltas.push(event),
                _ => {}
            }
        }
        assert_eq!(reasoning.len(), 1, "reasoning events: {reasoning:?}");
        assert_eq!(reasoning[0]["sessionId"], json!(session_id));
        assert_eq!(reasoning[0]["delta"], json!("weighing the options"));
        assert!(
            reasoning[0].get("subagentSessionId").is_none(),
            "a top-level session is its own parent"
        );
        assert!(deltas
            .iter()
            .all(|event| event["delta"] != json!("weighing the options")));

        // Display-only: nothing the model deliberated with may be replayed on
        // the next request or shown as part of the answer.
        let session = agents.session(&session_id).await.unwrap();
        let transcript = {
            let guard = session.lock().await;
            serde_json::to_string(&guard.messages).unwrap()
        };
        assert!(
            !transcript.contains("weighing the options"),
            "reasoning leaked into the transcript: {transcript}"
        );
    }

    #[tokio::test]
    async fn subagent_reasoning_is_addressed_to_the_parent_session() {
        let (bus, mut events) = tokio::sync::broadcast::channel(16);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        spawn_stream_forwarder(bus, rx, "sub-1".into(), "root-1".into());
        tx.send(model::StreamChunk::Reasoning("thinking".into()))
            .unwrap();
        tx.send(model::StreamChunk::Content("answer".into()))
            .unwrap();
        drop(tx);

        let reasoning = events.recv().await.unwrap();
        assert_eq!(reasoning["type"], json!("agent.reasoning"));
        assert_eq!(reasoning["sessionId"], json!("root-1"));
        assert_eq!(reasoning["subagentSessionId"], json!("sub-1"));
        assert_eq!(reasoning["delta"], json!("thinking"));

        // Visible deltas keep naming the producing session, as they always have.
        let delta = events.recv().await.unwrap();
        assert_eq!(delta["type"], json!("agent.delta"));
        assert_eq!(delta["sessionId"], json!("sub-1"));
        assert!(delta.get("subagentSessionId").is_none());
    }

    #[test]
    fn textual_tool_protocol_detector_matches_live_markup_without_rejecting_ordinary_xml() {
        assert!(content_carries_textual_tool_protocol(
            "]<]minimax[>[<tool_call>]<]minimax[>[<invoke name=\"file_read\">"
        ));
        assert!(content_carries_textual_tool_protocol(
            "]<]\u{200b}minimax[>[<\u{200b}tool_call><invoke name=\"file_read\">"
        ));
        assert!(content_carries_textual_tool_protocol(
            "<tool_call><invoke name=\"file_read\"></invoke></tool_call>"
        ));
        assert!(!content_carries_textual_tool_protocol(
            "Edited the <invoke name=\"example\"> XML element in docs."
        ));
        assert!(!content_carries_textual_tool_protocol(
            "Return <tool_call> as escaped documentation without an invocation."
        ));
    }

    /// Parent (no system prompt) delegates via subagent_spawn; the child
    /// (spawned with a system prompt) calls the browser tool editor_echo,
    /// then both finish with plain content after their tool results land.
    async fn subagent_flow_provider(
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let empty = vec![];
        let messages = body["messages"].as_array().unwrap_or(&empty);
        let is_child = messages.iter().any(|m| m["role"] == "system");
        let has_tool = messages.iter().any(|m| m["role"] == "tool");
        let events = if has_tool {
            content_stream(if is_child {
                "child done"
            } else {
                "parent done"
            })
        } else if is_child {
            vec![
                Ok(Event::default().data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-echo","function":{"name":"editor_echo","arguments":"{\"message\":\"hi\"}"}}]}}]}"#)),
                Ok(Event::default().data(r#"{"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}]}"#)),
                Ok(Event::default().data("[DONE]")),
            ]
        } else {
            vec![
                Ok(Event::default().data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-spawn","function":{"name":"subagent_spawn","arguments":"{\"role\":\"helper\",\"instructions\":\"echo something\",\"maxTurns\":3}"}}]}}]}"#)),
                Ok(Event::default().data(r#"{"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}]}"#)),
                Ok(Event::default().data("[DONE]")),
            ]
        };
        Sse::new(futures::stream::iter(events))
    }

    /// Parent (no system prompt) fans out nine subagent_spawn calls in one
    /// turn; children (system prompt present) reply immediately.
    async fn fanout_provider(
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let empty = vec![];
        let messages = body["messages"].as_array().unwrap_or(&empty);
        let is_child = messages.iter().any(|m| m["role"] == "system");
        let has_tool = messages.iter().any(|m| m["role"] == "tool");
        let events = if is_child || has_tool {
            content_stream(if is_child {
                "child done"
            } else {
                "parent done"
            })
        } else {
            let calls: Vec<Value> = (0..9)
                .map(|i| {
                    json!({
                        "index": i,
                        "id": format!("call-{i}"),
                        "function": {
                            "name": "subagent_spawn",
                            "arguments": "{\"role\":\"helper\",\"instructions\":\"work\",\"maxTurns\":1}"
                        }
                    })
                })
                .collect();
            vec![
                Ok(Event::default()
                    .data(json!({"choices":[{"delta":{"tool_calls": calls}}]}).to_string())),
                Ok(Event::default()
                    .data(r#"{"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}]}"#)),
                Ok(Event::default().data("[DONE]")),
            ]
        };
        Sse::new(futures::stream::iter(events))
    }

    #[tokio::test]
    async fn browser_tool_loop_completes() {
        let app = Router::new()
            .route("/v1/chat/completions", post(mock_provider))
            .with_state(Arc::new(AtomicUsize::new(0)));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let config = AppConfig {
            model: ModelConfig {
                default: "mock".into(),
                provider: "mock".into(),
                base_url: format!("http://{}/v1", addr),
                api_key_env: "CALI_MOCK_KEY".into(),
                temperature: 0.0,
                max_tokens: Some(128),
                roles: Default::default(),
            },
            providers: vec![],
            ..Default::default()
        };
        let (bus, _) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::from([(
            "editor_echo".to_string(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}),
                kind: crate::tools::ToolKind::Browser,
                access: crate::tools::Access::Guarded,
            },
        )]);
        let state = crate::AppState {
            config: std::sync::Arc::new(tokio::sync::RwLock::new(config)),
            projects_root: tempfile::tempdir().unwrap().path().to_path_buf(),
            sessions_root: tempfile::tempdir().unwrap().path().to_path_buf(),
            agents: agents.clone(),
            bus: bus.clone(),
            workspaces: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::workspace::Registry::new(),
            )),
            dev_servers: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::devserver::Servers::new(),
            )),
            terminals: crate::terminal::Terminals::default(),
            browsers: crate::browser::Browsers::new(),
            shutdown: std::sync::Arc::new(tokio::sync::watch::channel(false).0),
            tools: std::sync::Arc::new(tokio::sync::RwLock::new(tools.clone())),
            editor_bridge: crate::editor_bridge::EditorBridge::new(bus.clone()),
            editor_attachment: std::sync::Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            graphs: crate::graph::GraphManager::new(),
            mcp: std::sync::Arc::new(crate::mcp::McpManager::default()),
            asset_catalog: std::sync::Arc::new(tokio::sync::RwLock::new(Vec::new())),
        };

        let responder_agents = agents.clone();
        let responder = tokio::spawn(async move {
            let mut rx = bus.subscribe();
            while let Ok(event) = rx.recv().await {
                if event["type"] == "agent.tool_request" {
                    let session_id = event["sessionId"].as_str().unwrap().to_string();
                    let request_id = event["requestId"].as_str().unwrap().to_string();
                    responder_agents
                        .submit_tool_result(
                            &session_id,
                            &request_id,
                            json!({ "message": "hello-agent" }),
                        )
                        .await
                        .unwrap();
                }
            }
        });

        let options = AgentOptions {
            permission_mode: "full-access".into(),
            max_turns: 5,
            ..Default::default()
        };
        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "call editor_echo" })],
                options,
            )
            .await
            .unwrap();
        assert_eq!(result["toolCalls"].as_array().unwrap().len(), 1);
        assert!(result["reply"].as_str().unwrap().contains("hello-agent"));
        assert_eq!(result["status"], "completed");
        assert_eq!(result["completed"], true);
        // The browser loop correlates each entry by tool call id, so the
        // attempt and terminal status must travel together on the same row.
        let entry = &result["toolCalls"][0];
        assert_eq!(entry["name"], "editor_echo");
        assert_eq!(entry["id"], "call-1");
        assert!(entry["arguments"].is_object());
        assert_eq!(entry["status"], "done");
        responder.abort();
    }

    #[tokio::test]
    async fn max_turns_returns_an_actionable_terminal_status() {
        // A tool-only turn consumes the one allowed model turn. The previous
        // implementation returned the generic "Turn limit reached..." (or a
        // stale assistant reply), giving the caller no reliable way to tell
        // whether work finished. The result must be explicit and resumable.
        let app = Router::new()
            .route("/v1/chat/completions", post(mock_provider))
            .with_state(Arc::new(AtomicUsize::new(0)));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let (bus, _) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::from([(
            "editor_echo".to_string(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}),
                kind: crate::tools::ToolKind::Browser,
                access: crate::tools::Access::Guarded,
            },
        )]);
        let state = make_state(addr, bus.clone(), agents.clone(), tools.clone());

        let responder_agents = agents.clone();
        let responder = tokio::spawn(async move {
            let mut rx = bus.subscribe();
            while let Ok(event) = rx.recv().await {
                if event["type"] == "agent.tool_request" {
                    let session_id = event["sessionId"].as_str().unwrap().to_string();
                    let request_id = event["requestId"].as_str().unwrap().to_string();
                    responder_agents
                        .submit_tool_result(
                            &session_id,
                            &request_id,
                            json!({ "message": "hello-agent" }),
                        )
                        .await
                        .unwrap();
                }
            }
        });

        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "call editor_echo" })],
                AgentOptions {
                    permission_mode: "full-access".into(),
                    max_turns: 1,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        responder.abort();

        assert_eq!(result["status"], "max_turns");
        assert_eq!(result["completed"], false);
        assert_eq!(result["terminalReason"], "max_turns");
        assert_eq!(result["maxTurns"], 1);
        let reply = result["reply"].as_str().unwrap();
        assert!(
            reply.contains("Stopped after 1 turns without a final answer"),
            "unexpected reply: {reply}"
        );
        assert!(
            reply.contains("runaway backstop"),
            "unexpected reply: {reply}"
        );
        assert!(!reply.contains("Turn limit reached before the agent finished"));
    }

    #[tokio::test]
    async fn final_response_drain_false_preserves_old_max_turns_status() {
        let mock = Arc::new(DrainMockState {
            requests: std::sync::Mutex::new(Vec::new()),
            malicious_drain: AtomicBool::new(false),
            textual_tool_protocol: AtomicBool::new(false),
        });
        let app = Router::new()
            .route("/v1/chat/completions", post(drain_provider))
            .with_state(mock.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let (bus, _) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::from([(
            "editor_echo".to_string(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}),
                kind: crate::tools::ToolKind::Browser,
                access: crate::tools::Access::Guarded,
            },
        )]);
        let state = make_state(addr, bus.clone(), agents.clone(), tools.clone());

        let responder_agents = agents.clone();
        let responder = tokio::spawn(async move {
            let mut rx = bus.subscribe();
            while let Ok(event) = rx.recv().await {
                if event["type"] == "agent.tool_request" {
                    let session_id = event["sessionId"].as_str().unwrap().to_string();
                    let request_id = event["requestId"].as_str().unwrap().to_string();
                    responder_agents
                        .submit_tool_result(
                            &session_id,
                            &request_id,
                            json!({ "message": "hello-agent" }),
                        )
                        .await
                        .unwrap();
                }
            }
        });

        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "call editor_echo" })],
                AgentOptions {
                    permission_mode: "full-access".into(),
                    max_turns: 1,
                    final_response_drain: false,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        responder.abort();

        assert_eq!(result["status"], "max_turns");
        assert_eq!(result["completed"], false);
        assert_eq!(result["terminalReason"], "max_turns");
        assert_eq!(result["maxTurns"], 1);
        let reply = result["reply"].as_str().unwrap();
        assert!(
            reply.contains("Stopped after 1 turns without a final answer"),
            "unexpected reply: {reply}"
        );
        assert!(
            reply.contains("runaway backstop"),
            "unexpected reply: {reply}"
        );
        let requests = mock.requests.lock().unwrap();
        assert_eq!(requests.len(), 1, "drain must not fire when flag is false");
        assert_eq!(requests[0]["hasTools"], json!(true));
        assert_eq!(requests[0]["hasToolResult"], json!(false));
    }

    #[tokio::test]
    async fn final_response_drain_returns_schema_less_report() {
        let mock = Arc::new(DrainMockState {
            requests: std::sync::Mutex::new(Vec::new()),
            malicious_drain: AtomicBool::new(false),
            textual_tool_protocol: AtomicBool::new(false),
        });
        let app = Router::new()
            .route("/v1/chat/completions", post(drain_provider))
            .with_state(mock.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let (bus, _) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::from([(
            "editor_echo".to_string(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}),
                kind: crate::tools::ToolKind::Browser,
                access: crate::tools::Access::Guarded,
            },
        )]);
        let state = make_state(addr, bus.clone(), agents.clone(), tools.clone());

        let responder_agents = agents.clone();
        let responder = tokio::spawn(async move {
            let mut rx = bus.subscribe();
            while let Ok(event) = rx.recv().await {
                if event["type"] == "agent.tool_request" {
                    let session_id = event["sessionId"].as_str().unwrap().to_string();
                    let request_id = event["requestId"].as_str().unwrap().to_string();
                    responder_agents
                        .submit_tool_result(
                            &session_id,
                            &request_id,
                            json!({ "message": "hello-agent" }),
                        )
                        .await
                        .unwrap();
                }
            }
        });

        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "call editor_echo" })],
                AgentOptions {
                    permission_mode: "full-access".into(),
                    max_turns: 1,
                    final_response_drain: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        responder.abort();

        assert_eq!(result["status"], "completed");
        assert_eq!(result["completed"], true);
        assert_eq!(result["reply"], "drained report");

        let requests = mock.requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            2,
            "expected exactly one tool-bearing turn plus one schema-less drain"
        );
        assert_eq!(requests[0]["hasTools"], json!(true));
        assert_eq!(requests[0]["hasToolResult"], json!(false));
        assert_eq!(requests[1]["hasTools"], json!(false));
        assert_eq!(
            requests[1]["hasToolResult"],
            json!(true),
            "drain call must run with the tool result already in history"
        );
        assert_eq!(requests[1]["lastMessage"], FINALIZATION_INSTRUCTION);
    }

    #[tokio::test]
    async fn final_response_drain_rejects_live_minimax_textual_tool_protocol() {
        let mock = Arc::new(DrainMockState {
            requests: std::sync::Mutex::new(Vec::new()),
            malicious_drain: AtomicBool::new(false),
            textual_tool_protocol: AtomicBool::new(true),
        });
        let app = Router::new()
            .route("/v1/chat/completions", post(drain_provider))
            .with_state(mock.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let (bus, _) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::from([(
            "editor_echo".to_string(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}),
                kind: crate::tools::ToolKind::Browser,
                access: crate::tools::Access::Guarded,
            },
        )]);
        let state = make_state(addr, bus.clone(), agents.clone(), tools.clone());
        let responder_agents = agents.clone();
        let responder = tokio::spawn(async move {
            let mut rx = bus.subscribe();
            while let Ok(event) = rx.recv().await {
                if event["type"] == "agent.tool_request" {
                    responder_agents
                        .submit_tool_result(
                            event["sessionId"].as_str().unwrap(),
                            event["requestId"].as_str().unwrap(),
                            json!({ "message": "hello-agent" }),
                        )
                        .await
                        .unwrap();
                }
            }
        });

        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "call editor_echo" })],
                AgentOptions {
                    permission_mode: "full-access".into(),
                    max_turns: 1,
                    final_response_drain: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        responder.abort();

        assert_eq!(result["status"], "max_turns");
        assert_eq!(result["completed"], false);
        let reason = result["reason"].as_str().unwrap_or_default();
        assert!(reason.contains("textual tool-call protocol"), "{reason}");
        assert!(reason.contains("no drain tools were executed"), "{reason}");
        let requests = mock.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1]["hasTools"], json!(false));
        assert_eq!(requests[1]["lastMessage"], FINALIZATION_INSTRUCTION);
    }

    #[tokio::test]
    async fn final_response_drain_malicious_tool_call_is_not_dispatched() {
        let mock = Arc::new(DrainMockState {
            requests: std::sync::Mutex::new(Vec::new()),
            malicious_drain: AtomicBool::new(true),
            textual_tool_protocol: AtomicBool::new(false),
        });
        let app = Router::new()
            .route("/v1/chat/completions", post(drain_provider))
            .with_state(mock.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let (bus, _) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::from([(
            "editor_echo".to_string(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}),
                kind: crate::tools::ToolKind::Browser,
                access: crate::tools::Access::Guarded,
            },
        )]);
        let state = make_state(addr, bus.clone(), agents.clone(), tools.clone());
        let mut rx = bus.subscribe();

        let responder_agents = agents.clone();
        let responder = tokio::spawn(async move {
            let mut rx = bus.subscribe();
            while let Ok(event) = rx.recv().await {
                if event["type"] == "agent.tool_request" {
                    let session_id = event["sessionId"].as_str().unwrap().to_string();
                    let request_id = event["requestId"].as_str().unwrap().to_string();
                    responder_agents
                        .submit_tool_result(
                            &session_id,
                            &request_id,
                            json!({ "message": "hello-agent" }),
                        )
                        .await
                        .unwrap();
                }
            }
        });

        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "call editor_echo" })],
                AgentOptions {
                    permission_mode: "full-access".into(),
                    max_turns: 1,
                    final_response_drain: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        responder.abort();

        assert_eq!(result["status"], "max_turns");
        assert_eq!(result["completed"], false);
        assert_eq!(result["terminalReason"], "max_turns");
        let reason = result["reason"].as_str().unwrap_or_default();
        assert!(
            reason.contains("final response drain requested more tools"),
            "unexpected reason: {reason}"
        );
        assert!(
            reason.contains("no drain tools were executed"),
            "reason must promise no drain tools ran: {reason}"
        );

        let mut malicious_seen = false;
        let mut finished_for = std::collections::HashSet::new();
        while let Ok(event) = rx.try_recv() {
            if event["type"] == "agent.tool_finished" {
                let id = event["toolCallId"].as_str().unwrap_or("").to_string();
                finished_for.insert(id);
                if event["toolCallId"] == "call-malicious" {
                    malicious_seen = true;
                }
            }
        }
        assert!(!malicious_seen, "drain tool call must never be dispatched");
        assert_eq!(finished_for.len(), 1);
        assert!(finished_for.contains("call-echo"));

        let requests = mock.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1]["hasTools"], json!(false));
    }

    #[tokio::test]
    async fn supervised_approval_flow_completes() {
        let app = Router::new()
            .route("/v1/chat/completions", post(mock_provider))
            .with_state(Arc::new(AtomicUsize::new(0)));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let config = AppConfig {
            model: ModelConfig {
                default: "mock".into(),
                provider: "mock".into(),
                base_url: format!("http://{}/v1", addr),
                api_key_env: "CALI_MOCK_KEY".into(),
                temperature: 0.0,
                max_tokens: Some(128),
                roles: Default::default(),
            },
            providers: vec![],
            ..Default::default()
        };
        let (bus, _) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::from([(
            "editor_echo".to_string(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}),
                kind: crate::tools::ToolKind::Browser,
                access: crate::tools::Access::Guarded,
            },
        )]);
        let state = crate::AppState {
            config: std::sync::Arc::new(tokio::sync::RwLock::new(config)),
            projects_root: tempfile::tempdir().unwrap().path().to_path_buf(),
            sessions_root: tempfile::tempdir().unwrap().path().to_path_buf(),
            agents: agents.clone(),
            bus: bus.clone(),
            workspaces: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::workspace::Registry::new(),
            )),
            dev_servers: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::devserver::Servers::new(),
            )),
            terminals: crate::terminal::Terminals::default(),
            browsers: crate::browser::Browsers::new(),
            shutdown: std::sync::Arc::new(tokio::sync::watch::channel(false).0),
            tools: std::sync::Arc::new(tokio::sync::RwLock::new(tools.clone())),
            editor_bridge: crate::editor_bridge::EditorBridge::new(bus.clone()),
            editor_attachment: std::sync::Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            graphs: crate::graph::GraphManager::new(),
            mcp: std::sync::Arc::new(crate::mcp::McpManager::default()),
            asset_catalog: std::sync::Arc::new(tokio::sync::RwLock::new(Vec::new())),
        };

        // A prompt is addressed to exactly one window, so the test has to be
        // that window: reserve the session, attach a client id to it, and run
        // the turn on it. Answering from the event's own `targetClientId` is
        // what a panel does, and it is the only thing core accepts.
        let session_id = agents.reserve_session().await.unwrap();
        state.editor_attachment.write().await.insert(
            session_id.clone(),
            crate::editor_bridge::EditorAttachment {
                client_id: "window-under-test".into(),
                session_id: session_id.clone(),
                project_slug: "demo".into(),
                workspace_root: "/tmp/demo".into(),
            },
        );

        let responder_agents = agents.clone();
        let responder = tokio::spawn(async move {
            let mut rx = bus.subscribe();
            while let Ok(event) = rx.recv().await {
                if event["type"] == "agent.approval_request" {
                    let request_id = event["requestId"].as_str().unwrap().to_string();
                    let client_id = event["targetClientId"]
                        .as_str()
                        .expect("core must address the prompt at the attached window")
                        .to_string();
                    responder_agents
                        .approvals()
                        .respond(&request_id, Some(&client_id), true, None)
                        .await
                        .unwrap();
                }
                if event["type"] == "agent.tool_request" {
                    let session_id = event["sessionId"].as_str().unwrap().to_string();
                    let request_id = event["requestId"].as_str().unwrap().to_string();
                    responder_agents
                        .submit_tool_result(
                            &session_id,
                            &request_id,
                            json!({ "message": "hello-agent" }),
                        )
                        .await
                        .unwrap();
                }
            }
        });

        let options = AgentOptions {
            permission_mode: "supervised".into(),
            max_turns: 5,
            ..Default::default()
        };
        let result = agents
            .chat(
                &state,
                &tools,
                Some(&session_id),
                &[json!({ "role": "user", "content": "call editor_echo" })],
                options,
            )
            .await
            .unwrap();
        assert_eq!(result["toolCalls"].as_array().unwrap().len(), 1);
        assert!(result["reply"].as_str().unwrap().contains("hello-agent"));
        responder.abort();
    }

    #[test]
    fn permission_modes_are_distinct_and_ordered() {
        // "auto" and "full-access" both fell through to `_ => false`, so the
        // Auto entry in the UI dropdown was pure decoration.
        let modes = ["supervised", "auto-accept-edits", "auto", "full-access"];
        let counts: Vec<usize> = modes
            .iter()
            .map(|mode| {
                [
                    "project_revert",
                    "file_write",
                    "model_switch",
                    "editor_object_add",
                    "project_list",
                ]
                .iter()
                .filter(|tool| requires_approval(mode, tool, false))
                .count()
            })
            .collect();

        // Strictly loosening as you move down the list.
        assert!(
            counts.windows(2).all(|pair| pair[0] > pair[1]),
            "each mode must prompt for strictly fewer tools than the last: {counts:?}"
        );
        assert_eq!(*counts.last().unwrap(), 0, "full-access must never prompt");
    }

    #[test]
    fn auto_accept_edits_lets_scene_edits_through_but_gates_writes() {
        // The semantics used to be inverted: it auto-accepted file_write and
        // every scene-mutating browser tool, and prompted only for revert and
        // image3d.
        assert!(!requires_approval(
            "auto-accept-edits",
            "editor_object_add",
            false
        ));
        assert!(!requires_approval(
            "auto-accept-edits",
            "editor_update_transform",
            false
        ));
        assert!(requires_approval("auto-accept-edits", "file_write", false));
        assert!(requires_approval(
            "auto-accept-edits",
            "project_revert",
            false
        ));
        assert!(requires_approval(
            "auto-accept-edits",
            "subagent_spawn",
            false
        ));
        assert!(requires_approval(
            "auto-accept-edits",
            "devserver_start",
            false
        ));
    }

    #[test]
    fn rehydration_keeps_only_what_the_provider_can_accept() {
        let record = json!({
            "id": "session-1",
            "messages": [
                { "role": "user", "content": "add a platform" },
                // A turn marker and tool rows: panel bookkeeping, not conversation.
                { "role": "tool", "tool": "turn", "turnId": "t1", "content": "" },
                { "role": "tool", "tool": "file_write", "content": "wrote level.js" },
                { "role": "assistant", "content": "Added it." },
                // Status lines the panel writes carry a tool marker even at
                // assistant role.
                { "role": "assistant", "tool": "note", "content": "■ Stopping" },
                { "role": "assistant", "content": "   " },
                { "role": "system", "content": "ignored" }
            ]
        });

        let messages = provider_messages_from_record(&record);
        assert_eq!(
            messages,
            vec![
                json!({ "role": "user", "content": "add a platform" }),
                json!({ "role": "assistant", "content": "Added it." }),
            ]
        );
        // Nothing may carry tool_calls: their results cannot be reconstructed,
        // and an unanswered call makes the provider reject the next request —
        // turning a recoverable session into a permanently broken one.
        assert!(messages
            .iter()
            .all(|message| message.get("tool_calls").is_none()));
    }

    #[test]
    fn rehydration_of_a_record_with_no_messages_is_empty_not_an_error() {
        assert!(provider_messages_from_record(&json!({ "id": "s" })).is_empty());
        assert!(provider_messages_from_record(&json!({ "messages": [] })).is_empty());
    }

    #[tokio::test]
    async fn a_forgotten_session_comes_back_under_its_own_id() {
        let sessions = tempfile::tempdir().unwrap();
        crate::sessions::save(
            sessions.path(),
            &json!({
                "id": "session-resumed",
                "messages": [
                    { "role": "user", "content": "keep going" },
                    { "role": "assistant", "content": "will do" }
                ]
            }),
        )
        .unwrap();

        let (bus, _rx) = tokio::sync::broadcast::channel(8);
        let mut state = make_state(
            "127.0.0.1:1".parse().unwrap(),
            bus.clone(),
            AgentManager::new(bus),
            HashMap::new(),
        );
        state.sessions_root = sessions.path().to_path_buf();

        // Core has never heard of it — the state after a restart or an eviction.
        assert!(state.agents.session("session-resumed").await.is_err());

        state
            .agents
            .rehydrate_from_disk(&state, "session-resumed")
            .await
            .expect("a saved transcript must come back");

        let session = state
            .agents
            .session("session-resumed")
            .await
            .expect("the id itself must survive; forking to a new one orphans the file");
        let guard = session.lock().await;
        assert_eq!(guard.id, "session-resumed");
        assert_eq!(guard.messages.len(), 2);
    }

    #[tokio::test]
    async fn rehydrating_a_session_that_was_never_saved_still_fails() {
        let sessions = tempfile::tempdir().unwrap();
        let (bus, _rx) = tokio::sync::broadcast::channel(8);
        let mut state = make_state(
            "127.0.0.1:1".parse().unwrap(),
            bus.clone(),
            AgentManager::new(bus),
            HashMap::new(),
        );
        state.sessions_root = sessions.path().to_path_buf();

        let error = state
            .agents
            .rehydrate_from_disk(&state, "never-existed")
            .await
            .expect_err("no record means no recovery");
        assert!(format!("{error:#}").contains("never-existed"));
    }

    #[test]
    fn compaction_budget_follows_the_active_model_not_a_fixed_128k() {
        let mut config = crate::config::AppConfig::default();
        config.compaction.threshold = 0.8;
        config.compaction.reserved = 0;
        config.compaction.context_length = None;

        // The defect: every model was assumed to be 128k, so a 1M model
        // compacted at 88k and a 32k model hundreds of turns too late.
        let big = context_budget_tokens(&config, Some(1_000_000));
        let small = context_budget_tokens(&config, Some(32_000));
        assert_eq!(big, 800_000);
        assert_eq!(small, 25_600);
        assert!(big > small);

        // Unknown model: the fixed assumption is the last resort, not the norm.
        assert_eq!(
            context_budget_tokens(&config, None),
            (f64::from(DEFAULT_CONTEXT_LENGTH) * 0.8) as u64
        );

        // An explicit config override outranks the advertised limit — someone
        // who wrote it down is usually correcting a model whose metadata lies.
        config.compaction.context_length = Some(50_000);
        assert_eq!(context_budget_tokens(&config, Some(1_000_000)), 40_000);
    }

    #[test]
    fn the_compaction_breaker_trips_only_after_repeated_failure() {
        // One unlucky summary call — a 5xx, a rate limit, a transcript that
        // moved mid-summary — must not disable compaction for the session.
        assert!(!compaction_breaker_tripped(0));
        assert!(!compaction_breaker_tripped(1));
        assert!(!compaction_breaker_tripped(MAX_COMPACTION_FAILURES - 1));
        // And it must trip eventually: retrying forever means the transcript
        // keeps growing while every turn buys another failed summary. The
        // boundary is inclusive — an off-by-one here is one extra doomed call
        // per turn for the rest of the session.
        assert!(compaction_breaker_tripped(MAX_COMPACTION_FAILURES));
        assert!(compaction_breaker_tripped(MAX_COMPACTION_FAILURES + 10));
    }

    #[tokio::test]
    async fn a_successful_compaction_clears_the_failure_count() {
        // The breaker is for a persistently broken transcript, not a bad
        // minute; without the reset a session that recovered would stop
        // compacting for the rest of its life.
        let (bus, _rx) = tokio::sync::broadcast::channel(8);
        let agents = AgentManager::new(bus);
        agents.ensure_session("breaker").await.unwrap();
        let session = agents.session("breaker").await.unwrap();

        session.lock().await.compaction_failures = MAX_COMPACTION_FAILURES;
        assert!(session.lock().await.compaction_failures >= MAX_COMPACTION_FAILURES);

        // What the success arm in `chat` does.
        session.lock().await.compaction_failures = 0;
        assert_eq!(session.lock().await.compaction_failures, 0);
    }

    #[test]
    fn compaction_still_fires_when_the_provider_reports_no_usage() {
        // Several OpenAI-compatible gateways return no `usage` block on a
        // streamed response. Keyed on the reported count alone, occupancy sat
        // at zero forever and the transcript grew until the provider rejected
        // it — compaction's own failure mode, reached because nothing was
        // watching.
        let mut session = AgentSession {
            id: "no-usage".into(),
            messages: (0..200)
                .map(|i| json!({ "role": "user", "content": format!("{i} {}", "x".repeat(400)) }))
                .collect(),
            pending: HashMap::new(),
            cancel: CancellationToken::default(),
            always_allow: Vec::new(),
            world_state: None,
            compaction_failures: 0,
            context_length: None,
            usage: model::Usage::default(),
            last_prompt_tokens: 0,
            compactions: 0,
            compaction_instructions: None,
        };
        assert_eq!(session.last_prompt_tokens, 0, "the provider said nothing");
        assert!(
            session.occupancy() > 10_000,
            "the estimate must see the transcript"
        );
        assert!(session.should_compact(10_000));

        // A reported count is authoritative and is never second-guessed by an
        // estimate of characters over four.
        session.last_prompt_tokens = 500;
        assert_eq!(session.occupancy(), 500);
        assert!(!session.should_compact(10_000));

        // A zero budget still disables the check entirely.
        session.last_prompt_tokens = 0;
        assert!(!session.should_compact(0));
    }

    #[test]
    fn an_empty_session_never_asks_to_compact() {
        let session = AgentSession {
            id: "fresh".into(),
            messages: Vec::new(),
            pending: HashMap::new(),
            cancel: CancellationToken::default(),
            always_allow: Vec::new(),
            world_state: None,
            compaction_failures: 0,
            context_length: None,
            usage: model::Usage::default(),
            last_prompt_tokens: 0,
            compactions: 0,
            compaction_instructions: None,
        };
        assert_eq!(session.occupancy(), 0);
        assert!(!session.should_compact(1));
    }

    #[test]
    fn every_plan_mode_tool_is_classified_read_only() {
        // The two lists answer different questions but cannot disagree: plan
        // mode's contract is "reads only, touches nothing outside the projects
        // root, no network", so a tool in it that is `Guarded` means one of the
        // two is wrong. Before the classification lived on the definition there
        // was nothing to compare, and drift between them was invisible.
        //
        // Plan mode also admits `editor_*` tools, which the client registers
        // over `tool_register` and which therefore have no literal — the count
        // assertion at the end keeps that from quietly becoming *every* entry
        // and hollowing the check out.
        let mut checked_against_a_literal = 0;
        for tool in PLAN_MODE_TOOLS {
            // Holds for every plan-mode tool, including the editor ones the
            // client registers at runtime, which have no literal to classify.
            assert!(
                !is_destructive(tool, false),
                "{tool} is dispatchable in plan mode but gated for approval"
            );
            // The stronger form, wherever there is a definition to check.
            if let Some(access) = crate::tools::core_tool_access(tool) {
                checked_against_a_literal += 1;
                assert_eq!(
                    access,
                    crate::tools::Access::ReadOnly,
                    "{tool} is dispatchable in plan mode but classified {access:?}"
                );
            }
        }
        assert!(
            checked_against_a_literal >= 10,
            "the strong check covered only {checked_against_a_literal} tools; \
             plan mode's core entries should not have moved out of core_tool_defs"
        );
    }

    #[test]
    fn the_guarded_set_is_exactly_what_it_was() {
        // Moving the classification onto `ToolDef` must not have moved any
        // tool across the line. Pinned by name so a future change is a visible
        // edit to this list rather than a silent shift in what auto mode runs.
        let guarded: std::collections::BTreeSet<String> = crate::tools::core_tool_defs()
            .into_iter()
            .filter(|def| def.access == crate::tools::Access::Guarded)
            .map(|def| def.name)
            .collect();
        let expected: std::collections::BTreeSet<String> = [
            "asset_pick",
            "browser_look",
            "browser_screenshot",
            "file_edit",
            "file_write",
            "graph_cancel",
            "graph_run",
            "image3d_mesh",
            "loop_report_iteration",
            "loop_report_start",
            "loop_report_update",
            "model_switch",
            "project_revert",
            "subagent_spawn",
            "video_contact_sheet",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(guarded, expected);
    }

    #[test]
    fn an_unclassified_tool_fails_closed() {
        // A tool arriving without a classification — a browser tool over
        // `tool_register`, or a literal someone forgot — must ask, not run.
        assert_eq!(
            crate::tools::Access::default(),
            crate::tools::Access::Guarded
        );
        // And a name core has never heard of is gated by the mode logic, not
        // waved through by a missing entry.
        assert!(crate::tools::core_tool_access("not_a_tool").is_none());
        assert!(requires_approval("supervised", "not_a_tool", false));
    }

    #[test]
    fn permission_mode_default_fails_closed() {
        // `agent_chat` used to default an omitted mode to "full-access" — the
        // one fail-open path in a harness that fails closed everywhere else.
        // Pin the property, not the string, so renaming the mode cannot
        // quietly reintroduce it.
        for tool in [
            "file_write",
            "project_revert",
            "subagent_spawn",
            "devserver_start",
        ] {
            assert!(
                requires_approval(DEFAULT_PERMISSION_MODE, tool, false),
                "the default mode must still prompt for {tool}"
            );
        }
        assert_ne!(DEFAULT_PERMISSION_MODE, "full-access");
    }

    #[test]
    fn unknown_permission_modes_fail_closed() {
        assert!(requires_approval("", "file_write", false));
        assert!(requires_approval("typo-mode", "editor_object_add", false));
    }

    #[test]
    fn provider_tool_schema_order_is_deterministic() {
        let (bus, _) = tokio::sync::broadcast::channel(8);
        let manager = AgentManager::new(bus);
        let registered = HashMap::from([
            (
                "editor_zebra".to_string(),
                ToolDef {
                    name: "editor_zebra".into(),
                    description: "z".into(),
                    parameters: json!({"type":"object"}),
                    kind: crate::tools::ToolKind::Browser,
                    access: crate::tools::Access::Guarded,
                },
            ),
            (
                "editor_alpha".to_string(),
                ToolDef {
                    name: "editor_alpha".into(),
                    description: "a".into(),
                    parameters: json!({"type":"object"}),
                    kind: crate::tools::ToolKind::Browser,
                    access: crate::tools::Access::Guarded,
                },
            ),
        ]);

        let first: Vec<String> = manager
            .build_tools(&registered, &[])
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        let second: Vec<String> = manager
            .build_tools(&registered, &[])
            .into_iter()
            .map(|tool| tool.name)
            .collect();

        assert_eq!(first, second);
        assert!(first.windows(2).all(|pair| pair[0] <= pair[1]));
    }

    #[test]
    fn live_image3d_wrapper_hides_raw_core_schema() {
        let (bus, _) = tokio::sync::broadcast::channel(8);
        let manager = AgentManager::new(bus);
        let wrapper = ToolDef {
            name: "editor_image3d_mesh".into(),
            description: "Transactional live image-to-3D mesh".into(),
            parameters: json!({"type":"object"}),
            kind: crate::tools::ToolKind::Browser,
            access: crate::tools::Access::Guarded,
        };
        let registered = HashMap::from([(wrapper.name.clone(), wrapper)]);

        let live_names: Vec<String> = manager
            .build_tools(&registered, &[])
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert!(live_names.iter().any(|name| name == "editor_image3d_mesh"));
        assert!(
            !live_names.iter().any(|name| name == "image3d_mesh"),
            "the raw image3d_mesh schema must not compete with the live wrapper"
        );

        let headless_names: Vec<String> = manager
            .build_tools(&HashMap::new(), &[])
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert!(
            headless_names.iter().any(|name| name == "image3d_mesh"),
            "headless sessions still need the raw core image3d_mesh tool"
        );
        assert!(
            !headless_names.iter().any(|name| name == "model_switch"),
            "global model selection belongs to the user-facing RPC, never an agent schema"
        );
    }

    #[test]
    fn live_capture_wrapper_hides_the_raw_data_url_schema() {
        let (bus, _) = tokio::sync::broadcast::channel(8);
        let manager = AgentManager::new(bus);
        let wrapper = ToolDef {
            name: "editor_persist_capture".into(),
            description: "Capture and persist one live frame".into(),
            parameters: json!({"type":"object"}),
            kind: crate::tools::ToolKind::Browser,
            access: crate::tools::Access::Guarded,
        };
        let registered = HashMap::from([(wrapper.name.clone(), wrapper)]);

        let live_names: Vec<String> = manager
            .build_tools(&registered, &[])
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert!(live_names
            .iter()
            .any(|name| name == "editor_persist_capture"));
        assert!(!live_names.iter().any(|name| name == "capture_persist"));

        let headless_names: Vec<String> = manager
            .build_tools(&HashMap::new(), &[])
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert!(headless_names.iter().any(|name| name == "capture_persist"));
    }

    #[test]
    fn agents_never_receive_the_global_model_switch_tool() {
        let (bus, _) = tokio::sync::broadcast::channel(8);
        let manager = AgentManager::new(bus);
        let names: Vec<String> = manager
            .build_tools(&HashMap::new(), &[])
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert!(names.iter().any(|name| name == "model_list"));
        assert!(!names.iter().any(|name| name == "model_switch"));
        assert!(
            core_tool_defs()
                .iter()
                .any(|tool| tool.name == "model_switch"),
            "the user-facing RPC still owns model_switch"
        );
    }

    #[test]
    fn agents_never_receive_a_browser_model_switch_alias() {
        let (bus, _) = tokio::sync::broadcast::channel(8);
        let manager = AgentManager::new(bus);
        let browser_switch = ToolDef {
            name: "editor_model_switch".into(),
            description: "unsafe alias".into(),
            parameters: json!({"type":"object"}),
            kind: crate::tools::ToolKind::Browser,
            access: crate::tools::Access::Guarded,
        };
        let registered = HashMap::from([(browser_switch.name.clone(), browser_switch)]);
        let names: Vec<String> = manager
            .build_tools(&registered, &[])
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert!(!names.iter().any(|name| name == "editor_model_switch"));
    }

    #[tokio::test]
    async fn subagent_approvals_route_to_parent_session() {
        // A supervised parent spawns a child; the child inherits supervised
        // (never wider) and its editor_echo approval prompt must surface
        // under the PARENT session id — the one the client is watching.
        let app = Router::new().route("/v1/chat/completions", post(subagent_flow_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let (bus, _) = tokio::sync::broadcast::channel(256);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::from([(
            "editor_echo".to_string(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}),
                kind: crate::tools::ToolKind::Browser,
                access: crate::tools::Access::Guarded,
            },
        )]);
        let state = make_state(addr, bus.clone(), agents.clone(), tools.clone());
        // The parent session is the one on screen, so it is the one with a
        // window attached. The child's prompts inherit that owner, which is the
        // property under test: a grandchild session no panel has ever seen
        // still addresses its prompt at this window.
        let parent_session = agents.reserve_session().await.unwrap();
        state.editor_attachment.write().await.insert(
            parent_session.clone(),
            crate::editor_bridge::EditorAttachment {
                client_id: "window-under-test".into(),
                session_id: parent_session.clone(),
                project_slug: "demo".into(),
                workspace_root: "/tmp/demo".into(),
            },
        );

        let recorded: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
        let recorder = recorded.clone();
        let responder_agents = agents.clone();
        let responder_bus = bus.clone();
        let responder = tokio::spawn(async move {
            let mut rx = responder_bus.subscribe();
            while let Ok(event) = rx.recv().await {
                recorder.lock().unwrap().push(event.clone());
                let sid = event["sessionId"].as_str().unwrap_or("").to_string();
                let rid = event["requestId"].as_str().unwrap_or("").to_string();
                if event["type"] == "agent.approval_request" {
                    let client_id = event["targetClientId"]
                        .as_str()
                        .expect("every prompt in this flow is addressed to the parent's window")
                        .to_string();
                    responder_agents
                        .approvals()
                        .respond(&rid, Some(&client_id), true, None)
                        .await
                        .unwrap();
                }
                if event["type"] == "agent.tool_request" {
                    responder_agents
                        .submit_tool_result(&sid, &rid, json!({ "message": "hi" }))
                        .await
                        .unwrap();
                }
            }
        });

        let options = AgentOptions {
            permission_mode: "supervised".into(),
            max_turns: 5,
            ..Default::default()
        };
        let result = agents
            .chat(
                &state,
                &tools,
                Some(&parent_session),
                &[json!({ "role": "user", "content": "delegate the echo" })],
                options,
            )
            .await
            .unwrap();
        responder.abort();
        assert!(result["reply"].as_str().unwrap().contains("parent done"));
        let parent_sid = result["sessionId"].as_str().unwrap().to_string();

        let events = recorded.lock().unwrap().clone();
        let approvals: Vec<&Value> = events
            .iter()
            .filter(|e| e["type"] == "agent.approval_request")
            .collect();
        // The parent asked before spawning at all (supervised gates
        // subagent_spawn itself).
        assert!(
            approvals
                .iter()
                .any(|e| e["tool"] == "subagent_spawn" && e["sessionId"] == json!(parent_sid)),
            "missing parent spawn approval: {approvals:?}"
        );
        // The child's own tool call ALSO asked — proof it did not run
        // full-access — and the prompt carried the parent's session id.
        let child_approval = approvals
            .iter()
            .find(|e| e["tool"] == "editor_echo")
            .expect("child approval event missing: child escaped supervision");
        assert_eq!(child_approval["sessionId"], json!(parent_sid));
        let child_sid = child_approval["subagentSessionId"].as_str().unwrap();
        assert_ne!(child_sid, parent_sid);
    }

    #[tokio::test]
    async fn subagent_fanout_is_capped_per_turn() {
        let app = Router::new().route("/v1/chat/completions", post(fanout_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let (bus, _) = tokio::sync::broadcast::channel(256);
        let agents = AgentManager::new(bus.clone());
        let tools: HashMap<String, ToolDef> = HashMap::new();
        let state = make_state(addr, bus.clone(), agents.clone(), tools.clone());
        let mut rx = bus.subscribe();

        let options = AgentOptions {
            permission_mode: "full-access".into(),
            max_turns: 3,
            ..Default::default()
        };
        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "fan out" })],
                options,
            )
            .await
            .unwrap();
        assert!(result["reply"].as_str().unwrap().contains("parent done"));
        assert_eq!(result["toolCalls"].as_array().unwrap().len(), 9);

        let (mut spawned, mut capped) = (0usize, 0usize);
        while let Ok(event) = rx.try_recv() {
            if event["type"] == "agent.tool_finished" && event["tool"] == "subagent_spawn" {
                match event["result"].get("error").and_then(Value::as_str) {
                    Some(message) => {
                        assert!(message.contains("fan-out cap"), "unexpected: {message}");
                        capped += 1;
                    }
                    None => spawned += 1,
                }
            }
        }
        assert_eq!(spawned, MAX_SPAWNS_PER_TURN, "first eight spawns must run");
        assert_eq!(capped, 1, "the ninth spawn must be refused");
    }

    #[test]
    fn permission_rules_last_match_wins() {
        let rules = vec![
            PermissionRule {
                pattern: "*".into(),
                action: "deny".into(),
            },
            PermissionRule {
                pattern: "file_*".into(),
                action: "allow".into(),
            },
            PermissionRule {
                pattern: "file_write".into(),
                action: "ask".into(),
            },
        ];
        // Broad deny, overridden per-prefix, overridden per-tool — in order.
        assert_eq!(
            rule_decision(&rules, "editor_object_add"),
            Some(RuleAction::Deny)
        );
        assert_eq!(rule_decision(&rules, "file_read"), Some(RuleAction::Allow));
        assert_eq!(rule_decision(&rules, "file_write"), Some(RuleAction::Ask));
        assert_eq!(rule_decision(&[], "anything"), None);
        // Unrecognized actions fail closed to a prompt.
        let weird = vec![PermissionRule {
            pattern: "x".into(),
            action: "yolo".into(),
        }];
        assert_eq!(rule_decision(&weird, "x"), Some(RuleAction::Ask));
    }

    #[test]
    fn glob_patterns_match_tool_names() {
        // Permission rules and MCP tool filters share ONE glob dialect:
        // there is no agent-local implementation to drift from mcp's.
        use crate::mcp::glob_match;
        assert!(glob_match("*", "anything"));
        assert!(glob_match("file_*", "file_write"));
        assert!(!glob_match("file_*", "project_save"));
        assert!(glob_match("mcp__*__write", "mcp__fs__write"));
        assert!(glob_match("file_????", "file_read"));
        assert!(!glob_match("file_????", "file_write"));
        assert!(!glob_match("file", "file_read"));
        assert!(glob_match("*_write", "file_write"));
    }

    #[test]
    fn permission_rules_honor_character_classes() {
        // Regression: permission rules used to run a weaker glob with no
        // `[...]` support, so this deny matched nothing and silently let the
        // servers through while the identical pattern worked in mcp filters.
        let rules = vec![PermissionRule {
            pattern: "mcp__[ab]*".into(),
            action: "deny".into(),
        }];
        assert_eq!(
            rule_decision(&rules, "mcp__alpha__write"),
            Some(RuleAction::Deny)
        );
        assert_eq!(
            rule_decision(&rules, "mcp__blender__execute"),
            Some(RuleAction::Deny)
        );
        assert_eq!(rule_decision(&rules, "mcp__zeta__read"), None);
        // Negation and ranges come along with the shared dialect.
        let ranged = vec![PermissionRule {
            pattern: "tool_[!0-9]".into(),
            action: "ask".into(),
        }];
        assert_eq!(rule_decision(&ranged, "tool_x"), Some(RuleAction::Ask));
        assert_eq!(rule_decision(&ranged, "tool_7"), None);
    }

    #[test]
    fn rules_override_mode_logic_in_both_directions() {
        let allow_writes = vec![PermissionRule {
            pattern: "file_write".into(),
            action: "allow".into(),
        }];
        // supervised would prompt; the allow rule runs it straight through —
        // but only for the matched tool.
        assert_eq!(
            tool_gate(&allow_writes, "supervised", "file_write", false),
            Gate::Run
        );
        assert_eq!(
            tool_gate(&allow_writes, "supervised", "project_save", false),
            Gate::Prompt
        );
        // full-access never prompts; an ask rule still forces one.
        let ask_lists = vec![PermissionRule {
            pattern: "project_list".into(),
            action: "ask".into(),
        }];
        assert_eq!(
            tool_gate(&ask_lists, "full-access", "project_list", false),
            Gate::Prompt
        );
        // Last match wins across allow-then-deny stacks.
        let deny_spawn = vec![
            PermissionRule {
                pattern: "*".into(),
                action: "allow".into(),
            },
            PermissionRule {
                pattern: "subagent_*".into(),
                action: "deny".into(),
            },
        ];
        assert_eq!(
            tool_gate(&deny_spawn, "full-access", "subagent_spawn", false),
            Gate::Deny
        );
        assert_eq!(
            tool_gate(&deny_spawn, "supervised", "editor_object_add", false),
            Gate::Run
        );
    }

    #[test]
    fn plan_mode_whitelist_is_read_only() {
        assert!(plan_mode_allows("file_read"));
        assert!(plan_mode_allows("file_grep"));
        assert!(plan_mode_allows("file_glob"));
        assert!(plan_mode_allows("editor_scene_inspect"));
        assert!(plan_mode_allows("editor_capture_frame"));
        assert!(plan_mode_allows("editor_asset_builder_state"));
        assert!(plan_mode_allows("editor_console_log"));
        assert!(!plan_mode_allows("file_write"));
        assert!(!plan_mode_allows("editor_object_add"));
        assert!(!plan_mode_allows("editor_script_write"));
        assert!(!plan_mode_allows("editor_project_save"));
        assert!(!plan_mode_allows("subagent_spawn"));
        assert!(!plan_mode_allows("devserver_start"));
        assert!(!plan_mode_allows("mcp__x__y"));
        // Whitelisted tools run without prompts; everything else stays
        // fail-closed even if the dispatch gate were somehow skipped.
        assert!(!requires_approval("plan", "file_read", false));
        assert!(requires_approval("plan", "file_write", false));
    }

    /// The whole point of the exact-name list: a tool whose *name* reads
    /// read-only but whose body writes must not be admitted. Under the old
    /// substring heuristic every one of these passed.
    #[test]
    fn plan_mode_refuses_tools_that_only_look_read_only() {
        for tool in [
            "editor_capture_and_overwrite",
            "editor_inspect_and_repair",
            "editor_scene_inspect_apply",
            "editor_rebuild_state",
            "editor_wipe_log",
            "file_read_write",
        ] {
            assert!(
                !plan_mode_allows(tool),
                "{tool} must not pass the read-only gate on the strength of its name"
            );
        }
        // Trailing/leading whitespace or casing is not a match either.
        assert!(!plan_mode_allows("File_Read"));
        assert!(!plan_mode_allows("file_read "));
    }

    /// Network egress is not read-only. `asset_search` queries PolyHaven, so
    /// plan mode refuses it even though it writes nothing locally.
    #[test]
    fn plan_mode_refuses_network_egress() {
        assert!(!plan_mode_allows("asset_search"));
        assert!(requires_approval("plan", "asset_search", false));
        // Its local-read sibling is still available for planning.
        assert!(plan_mode_allows("asset_usage"));
        assert!(plan_mode_allows("project_open"));
    }

    /// Accuracy pass: an exact-name list rots silently when a tool is renamed
    /// or removed. Every core name in it must still be a registered core
    /// tool, and none of them may be classified destructive.
    #[test]
    fn plan_mode_whitelist_names_are_real_and_nondestructive() {
        let registered: Vec<String> = crate::tools::core_tool_defs()
            .into_iter()
            .map(|def| def.name)
            .collect();
        for tool in PLAN_MODE_TOOLS {
            if !tool.starts_with("editor_") {
                assert!(
                    registered.iter().any(|name| name == tool),
                    "{tool} is whitelisted for plan mode but is not a registered core tool"
                );
            }
            assert!(
                !is_destructive(tool, false),
                "{tool} is both plan-mode-allowed and destructive"
            );
        }
    }

    #[test]
    fn denied_tools_are_filtered_from_defs() {
        let (bus, _) = tokio::sync::broadcast::channel(8);
        let agents = AgentManager::new(bus);
        let tools = HashMap::from([(
            "editor_echo".to_string(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object"}),
                kind: crate::tools::ToolKind::Browser,
                access: crate::tools::Access::Guarded,
            },
        )]);
        let rules = vec![PermissionRule {
            pattern: "editor_*".into(),
            action: "deny".into(),
        }];
        let filtered = agents.build_tools(&tools, &rules);
        assert!(filtered.iter().all(|d| d.name != "editor_echo"));
        assert!(!filtered.is_empty(), "core tools must survive the filter");
        let unfiltered = agents.build_tools(&tools, &[]);
        assert!(unfiltered.iter().any(|d| d.name == "editor_echo"));
    }

    /// First round: the model asks for file_write. In plan mode that must
    /// come back as a refusal tool result (nothing executes), after which
    /// the model finishes with plain content.
    async fn plan_flow_provider(
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let empty = vec![];
        let messages = body["messages"].as_array().unwrap_or(&empty);
        let has_tool = messages.iter().any(|m| m["role"] == "tool");
        let events = if has_tool {
            content_stream("plan ready")
        } else {
            vec![
                Ok(Event::default().data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-write","function":{"name":"file_write","arguments":"{\"path\":\"notes.txt\",\"content\":\"x\"}"}}]}}]}"#)),
                Ok(Event::default().data(r#"{"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}]}"#)),
                Ok(Event::default().data("[DONE]")),
            ]
        };
        Sse::new(futures::stream::iter(events))
    }

    async fn activity_write_provider(
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let empty = vec![];
        let messages = body["messages"].as_array().unwrap_or(&empty);
        let has_tool = messages.iter().any(|message| message["role"] == "tool");
        let events = if has_tool {
            content_stream("write complete")
        } else {
            vec![
                Ok(Event::default().data(
                    r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-write","function":{"name":"file_write","arguments":"{\"slug\":\"demo\",\"path\":\"notes.txt\",\"content\":\"hello\"}"}}]}}]}"#,
                )),
                Ok(Event::default().data(
                    r#"{"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}]}"#,
                )),
                Ok(Event::default().data("[DONE]")),
            ]
        };
        Sse::new(futures::stream::iter(events))
    }

    #[tokio::test]
    async fn plan_mode_refuses_file_write() {
        let app = Router::new().route("/v1/chat/completions", post(plan_flow_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let (bus, _) = tokio::sync::broadcast::channel(256);
        let agents = AgentManager::new(bus.clone());
        let tools: HashMap<String, ToolDef> = HashMap::new();
        let state = make_state(addr, bus.clone(), agents.clone(), tools.clone());
        let mut rx = bus.subscribe();

        let options = AgentOptions {
            permission_mode: "plan".into(),
            max_turns: 3,
            project_slug: Some("demo".into()),
            workspace_root: Some("/tmp/cali-plan-workspace".into()),
            ..Default::default()
        };
        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "write the file" })],
                options,
            )
            .await
            .unwrap();
        assert!(result["reply"].as_str().unwrap().contains("plan ready"));
        // The refused file_write must show up in the tool-call log with
        // `status: "error"`, otherwise the loop worker cannot tell this
        // attempt apart from one that succeeded.
        assert_eq!(result["toolCalls"].as_array().unwrap().len(), 1);
        let entry = &result["toolCalls"][0];
        assert_eq!(entry["name"], "file_write");
        assert_eq!(entry["id"], "call-write");
        assert_eq!(entry["status"], "error");

        let mut refusal = None;
        let mut finished = None;
        while let Ok(event) = rx.try_recv() {
            if event["type"] == "agent.tool_finished" && event["tool"] == "file_write" {
                refusal = event["result"]["error"].as_str().map(String::from);
                finished = Some(event);
            }
        }
        let refusal = refusal.expect("file_write must produce an error tool result");
        assert!(
            refusal.contains("plan mode"),
            "unexpected refusal: {refusal}"
        );
        let finished = finished.expect("tool_finished event");
        assert_eq!(finished["toolCallId"], "call-write");
        assert!(finished["startedAtMs"].is_u64());
        assert!(finished["finishedAtMs"].is_u64());
        assert!(
            finished["finishedAtMs"].as_u64().unwrap() >= finished["startedAtMs"].as_u64().unwrap()
        );
        assert_eq!(finished["projectSlug"], "demo");
        assert_eq!(finished["workspaceRoot"], "/tmp/cali-plan-workspace");
        assert!(finished["result"]
            .get(crate::tools::INTERNAL_ACTIVITY_KEY)
            .is_none());
    }

    /// Streams a `file_write` whose argument JSON stops mid-`content`, the
    /// shape a response takes when it reaches its output-token cap partway
    /// through a long argument.
    async fn truncated_call_provider(
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let empty = vec![];
        let messages = body["messages"].as_array().unwrap_or(&empty);
        let has_tool = messages.iter().any(|message| message["role"] == "tool");
        let events = if has_tool {
            content_stream("smaller pieces next time")
        } else {
            let cut_off =
                "{\"slug\":\"demo\",\"path\":\"notes.txt\",\"content\":\"the first half of a long";
            vec![
                Ok(Event::default().data(
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-cut","function":{"name":"file_write","arguments": cut_off}}]}}]}).to_string(),
                )),
                Ok(Event::default().data(
                    json!({"choices":[{"finish_reason":"length","index":0,"delta":{}}]}).to_string(),
                )),
                Ok(Event::default().data("[DONE]")),
            ]
        };
        Sse::new(futures::stream::iter(events))
    }

    /// A call the token cap cut in half is refused by its real name. It used
    /// to parse as nothing, become an empty argument object, and reach
    /// `file_write` — which reported "missing required string path" and sent
    /// the model back to fix a path it had spelled correctly.
    #[tokio::test]
    async fn a_tool_call_cut_off_by_the_token_cap_is_named_as_such() {
        let app = Router::new().route("/v1/chat/completions", post(truncated_call_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let (bus, _) = tokio::sync::broadcast::channel(256);
        let agents = AgentManager::new(bus.clone());
        let tools: HashMap<String, ToolDef> = HashMap::new();
        let state = make_state(addr, bus.clone(), agents.clone(), tools.clone());
        let mut rx = bus.subscribe();

        let options = AgentOptions {
            max_turns: 3,
            project_slug: Some("demo".into()),
            ..Default::default()
        };
        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "write the file" })],
                options,
            )
            .await
            .unwrap();
        assert_eq!(result["toolCalls"][0]["status"], "error");

        let mut refusal = None;
        while let Ok(event) = rx.try_recv() {
            if event["type"] == "agent.tool_finished" && event["tool"] == "file_write" {
                refusal = event["result"]["error"].as_str().map(String::from);
            }
        }
        let refusal = refusal.expect("a truncated call must produce an error tool result");
        assert!(refusal.contains("cut off"), "unexpected refusal: {refusal}");
        assert!(
            refusal.contains("128"),
            "the refusal must name the cap that caused it: {refusal}"
        );
        assert!(
            !refusal.contains("missing required string"),
            "a truncated call must not be reported as a missing argument: {refusal}"
        );
    }

    #[test]
    fn malformed_arguments_are_told_apart_from_truncated_ones() {
        let complete_but_wrong = unparsed_arguments_error("file_write", "{path: notes.txt}", None);
        assert!(complete_but_wrong.contains("not valid JSON"));
        assert!(!complete_but_wrong.contains("cut off"));
        let cut_off = unparsed_arguments_error("file_write", "{\"path\": \"note", Some(4096));
        assert!(cut_off.contains("cut off"));
        assert!(cut_off.contains("4096"));
    }

    #[tokio::test]
    async fn file_write_activity_is_separate_from_result_and_history() {
        let app = Router::new().route("/v1/chat/completions", post(activity_write_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let (bus, _) = tokio::sync::broadcast::channel(256);
        let agents = AgentManager::new(bus.clone());
        let tools: HashMap<String, ToolDef> = HashMap::new();
        let state = make_state(addr, bus.clone(), agents.clone(), tools.clone());
        crate::store::create_project(&state.projects_root, "demo", "Demo").unwrap();
        let workspace = tempfile::tempdir().unwrap();
        crate::store::set_workspace_root(
            &state.projects_root,
            "demo",
            Some(workspace.path().to_str().unwrap()),
        )
        .unwrap();
        let mut rx = bus.subscribe();

        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "write a note" })],
                AgentOptions {
                    permission_mode: "full-access".into(),
                    max_turns: 3,
                    project_slug: Some("demo".into()),
                    workspace_root: Some(workspace.path().display().to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(result["reply"], "write complete");
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("notes.txt")).unwrap(),
            "hello"
        );

        let mut started = None;
        let mut finished = None;
        while let Ok(event) = rx.try_recv() {
            match event["type"].as_str() {
                Some("agent.tool_started") => started = Some(event),
                Some("agent.tool_finished") => finished = Some(event),
                _ => {}
            }
        }
        let started = started.expect("tool_started event");
        let finished = finished.expect("tool_finished event");
        assert_eq!(started["toolCallId"], "call-write");
        assert_eq!(finished["toolCallId"], started["toolCallId"]);
        assert_eq!(finished["projectSlug"], "demo");
        assert_eq!(
            finished["workspaceRoot"],
            workspace.path().display().to_string()
        );
        assert!(finished["activity"].is_object());
        assert_eq!(finished["activity"]["operation"], "write");
        assert_eq!(finished["activity"]["after"], "hello");
        assert!(finished["result"]
            .get(crate::tools::INTERNAL_ACTIVITY_KEY)
            .is_none());

        let session_id = result["sessionId"].as_str().unwrap();
        let session = agents.session(session_id).await.unwrap();
        let guard = session.lock().await;
        let tool_message = guard
            .messages
            .iter()
            .find(|message| message["role"] == "tool")
            .expect("tool history message");
        assert!(!tool_message["content"]
            .as_str()
            .unwrap()
            .contains(crate::tools::INTERNAL_ACTIVITY_KEY));
    }

    /// One turn with two editor_echo calls. The first browser request is
    /// deliberately delayed; provider-order execution must not issue the
    /// second request until the first one has finished.
    async fn parallel_calls_provider(
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let empty = vec![];
        let messages = body["messages"].as_array().unwrap_or(&empty);
        let has_tool = messages.iter().any(|m| m["role"] == "tool");
        let events = if has_tool {
            content_stream("both done")
        } else {
            vec![
                Ok(Event::default().data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"editor_echo","arguments":"{\"message\":\"one\"}"}},{"index":1,"id":"call-b","function":{"name":"editor_echo","arguments":"{\"message\":\"two\"}"}}]}}]}"#)),
                Ok(Event::default().data(r#"{"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}]}"#)),
                Ok(Event::default().data("[DONE]")),
            ]
        };
        Sse::new(futures::stream::iter(events))
    }

    #[tokio::test]
    async fn stateful_tool_calls_execute_in_provider_order() {
        let app = Router::new().route("/v1/chat/completions", post(parallel_calls_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let (bus, _) = tokio::sync::broadcast::channel(256);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::from([(
            "editor_echo".to_string(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}),
                kind: crate::tools::ToolKind::Browser,
                access: crate::tools::Access::Guarded,
            },
        )]);
        let state = make_state(addr, bus.clone(), agents.clone(), tools.clone());

        let recorded: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
        let recorder = recorded.clone();
        let responder_agents = agents.clone();
        let responder_bus = bus.clone();
        let responder = tokio::spawn(async move {
            let mut rx = responder_bus.subscribe();
            while let Ok(event) = rx.recv().await {
                let event_type = event["type"].as_str().unwrap_or_default();
                let call_id = if event_type == "agent.tool_request" {
                    event["arguments"]["message"].as_str().unwrap_or_default()
                } else {
                    event["toolCallId"].as_str().unwrap_or_default()
                };
                if matches!(
                    event_type,
                    "agent.tool_started" | "agent.tool_request" | "agent.tool_finished"
                ) {
                    recorder
                        .lock()
                        .unwrap()
                        .push(format!("{event_type}:{call_id}"));
                }
                if event_type == "agent.tool_request" {
                    let sid = event["sessionId"].as_str().unwrap().to_string();
                    let rid = event["requestId"].as_str().unwrap().to_string();
                    let msg = event["arguments"]["message"].as_str().unwrap();
                    if msg == "one" {
                        // Keep the first stateful call in flight long enough
                        // for a concurrent implementation to issue call-b.
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    responder_agents
                        .submit_tool_result(
                            &sid,
                            &rid,
                            json!({ "message": format!("result-{msg}") }),
                        )
                        .await
                        .unwrap();
                }
            }
        });

        let options = AgentOptions {
            permission_mode: "full-access".into(),
            max_turns: 3,
            ..Default::default()
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            agents.chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "echo twice" })],
                options,
            ),
        )
        .await
        .expect("stateful calls must complete")
        .unwrap();
        responder.abort();
        assert!(result["reply"].as_str().unwrap().contains("both done"));

        let events = recorded.lock().unwrap().clone();
        let first_finished = events
            .iter()
            .position(|event| event == "agent.tool_finished:call-a")
            .expect("first tool_finished event");
        let second_request = events
            .iter()
            .position(|event| event == "agent.tool_request:two")
            .expect("second tool_request event");
        assert!(
            first_finished < second_request,
            "second stateful call raced first: {events:?}"
        );

        // Tool messages sit in call order, each paired with its own result.
        let sid = result["sessionId"].as_str().unwrap();
        let session = agents.session(sid).await.unwrap();
        let guard = session.lock().await;
        let tool_messages: Vec<(String, String)> = guard
            .messages
            .iter()
            .filter(|m| m["role"] == "tool")
            .map(|m| {
                (
                    m["tool_call_id"].as_str().unwrap().to_string(),
                    m["content"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        assert_eq!(tool_messages.len(), 2);
        assert_eq!(tool_messages[0].0, "call-a");
        assert!(tool_messages[0].1.contains("result-one"));
        assert_eq!(tool_messages[1].0, "call-b");
        assert!(tool_messages[1].1.contains("result-two"));
    }

    /// Reports usage on every call: 100/10 for the tool-calling round,
    /// 200/20 for the follow-up — cumulative totals must be 300/30/330.
    async fn usage_provider(
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let empty = vec![];
        let messages = body["messages"].as_array().unwrap_or(&empty);
        let has_tool = messages.iter().any(|m| m["role"] == "tool");
        let events = if has_tool {
            vec![
                Ok(Event::default().data(
                    json!({"choices":[{"delta":{"role":"assistant","content":"done"}}]})
                        .to_string(),
                )),
                Ok(Event::default().data(r#"{"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":20,"total_tokens":220}}"#)),
                Ok(Event::default().data("[DONE]")),
            ]
        } else {
            vec![
                Ok(Event::default().data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"editor_echo","arguments":"{\"message\":\"hi\"}"}}]}}]}"#)),
                Ok(Event::default().data(r#"{"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}]}"#)),
                Ok(Event::default().data(r#"{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}"#)),
                Ok(Event::default().data("[DONE]")),
            ]
        };
        Sse::new(futures::stream::iter(events))
    }

    #[tokio::test]
    async fn usage_accumulates_across_model_calls() {
        let app = Router::new().route("/v1/chat/completions", post(usage_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let (bus, _) = tokio::sync::broadcast::channel(256);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::from([(
            "editor_echo".to_string(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}),
                kind: crate::tools::ToolKind::Browser,
                access: crate::tools::Access::Guarded,
            },
        )]);
        let state = make_state(addr, bus.clone(), agents.clone(), tools.clone());
        let mut rx = bus.subscribe();

        let responder_agents = agents.clone();
        let responder_bus = bus.clone();
        let responder = tokio::spawn(async move {
            let mut rx = responder_bus.subscribe();
            while let Ok(event) = rx.recv().await {
                if event["type"] == "agent.tool_request" {
                    let sid = event["sessionId"].as_str().unwrap().to_string();
                    let rid = event["requestId"].as_str().unwrap().to_string();
                    responder_agents
                        .submit_tool_result(&sid, &rid, json!({ "message": "hi" }))
                        .await
                        .unwrap();
                }
            }
        });

        let options = AgentOptions {
            permission_mode: "full-access".into(),
            max_turns: 3,
            ..Default::default()
        };
        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "echo then finish" })],
                options,
            )
            .await
            .unwrap();
        responder.abort();
        assert!(result["reply"].as_str().unwrap().contains("done"));

        // Session totals accumulated across both model calls.
        let sid = result["sessionId"].as_str().unwrap();
        let session = agents.session(sid).await.unwrap();
        let guard = session.lock().await;
        assert_eq!(guard.usage.prompt_tokens, 300);
        assert_eq!(guard.usage.completion_tokens, 30);
        assert_eq!(guard.usage.total_tokens, 330);
        assert_eq!(guard.last_prompt_tokens, 200);
        // Compaction hook keys off the LATEST prompt size, not the sum.
        assert!(guard.should_compact(150));
        assert!(guard.should_compact(200));
        assert!(!guard.should_compact(201));
        assert!(!guard.should_compact(0), "zero budget disables the check");
        drop(guard);

        // The last agent.usage event carries the cumulative totals.
        let mut last_usage = None;
        while let Ok(event) = rx.try_recv() {
            if event["type"] == "agent.usage" {
                last_usage = Some(event);
            }
        }
        let event = last_usage.expect("agent.usage must be emitted after each model call");
        assert_eq!(event["usage"]["promptTokens"], json!(300));
        assert_eq!(event["usage"]["completionTokens"], json!(30));
        assert_eq!(event["usage"]["totalTokens"], json!(330));
        assert_eq!(event["usage"]["lastPromptTokens"], json!(200));
    }

    /// Provider that always streams a fixed summary — what compact_session's
    /// single summary model call receives.
    async fn summary_provider() -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        Sse::new(futures::stream::iter(content_stream(
            "Goal: verify compaction. Progress: transcript summarized.",
        )))
    }

    /// The steer is a property of the session, not of the one call that set
    /// it: the compaction that matters most is the automatic one that fires
    /// mid-loop, and it has to keep what the operator said to keep.
    #[tokio::test]
    async fn compaction_instructions_persist_for_later_automatic_compactions() {
        let app = Router::new().route("/v1/chat/completions", post(summary_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (bus, _rx) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let state = make_state(addr, bus, agents.clone(), HashMap::new());
        let session = Arc::new(Mutex::new(AgentSession {
            id: "steered".into(),
            messages: vec![json!({ "role": "user", "content": "hello" })],
            pending: HashMap::new(),
            cancel: CancellationToken::default(),
            always_allow: Vec::new(),
            world_state: None,
            compaction_failures: 0,
            context_length: None,
            usage: model::Usage::default(),
            last_prompt_tokens: 0,
            compactions: 0,
            compaction_instructions: None,
        }));
        agents
            .sessions
            .lock()
            .await
            .insert("steered".into(), session.clone());

        let set = agents
            .compact_session(
                &state,
                "steered",
                CompactInstructions::Set("keep the repro steps"),
                CompactTrigger::Manual,
            )
            .await
            .unwrap();
        assert_eq!(set["instructions"], json!("keep the repro steps"));
        assert_eq!(set["trigger"], json!("manual"));
        assert_eq!(
            session.lock().await.compaction_instructions.as_deref(),
            Some("keep the repro steps")
        );

        // An automatic run says nothing about instructions and inherits them.
        let auto = agents
            .compact_session(
                &state,
                "steered",
                CompactInstructions::Unchanged,
                CompactTrigger::Auto,
            )
            .await
            .unwrap();
        assert_eq!(auto["instructions"], json!("keep the repro steps"));
        assert_eq!(auto["trigger"], json!("auto"));

        // And `/compact clear` forgets them for good.
        let cleared = agents
            .compact_session(
                &state,
                "steered",
                CompactInstructions::Clear,
                CompactTrigger::Manual,
            )
            .await
            .unwrap();
        assert_eq!(cleared["instructions"], Value::Null);
        assert!(session.lock().await.compaction_instructions.is_none());
    }

    #[tokio::test]
    async fn compact_session_summarizes_prunes_and_archives() {
        let app = Router::new().route("/v1/chat/completions", post(summary_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (bus, mut rx) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let state = make_state(addr, bus, agents.clone(), HashMap::new());
        {
            // budget = 1.0 × 120 − 20 = 100 tokens.
            let mut config = state.config.write().await;
            config.compaction.context_length = Some(120);
            config.compaction.threshold = 1.0;
            config.compaction.reserved = 20;
        }

        // Seed a transcript far over budget: protected head, a compactable
        // middle with an oversized tool result, and a fresh tail.
        let mut messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "u".repeat(400) }),
            json!({ "role": "assistant", "content": "a".repeat(400) }),
        ];
        messages.push(json!({
            "role": "assistant", "content": "",
            "tool_calls": [{ "id": "call-old", "type": "function",
                "function": { "name": "file_read", "arguments": "{}" } }]
        }));
        messages.push(json!({
            "role": "tool", "tool_call_id": "call-old",
            "content": "t".repeat(1000)
        }));
        for i in 0..4 {
            messages
                .push(json!({ "role": "user", "content": format!("q{i} {}", "z".repeat(300)) }));
            messages.push(
                json!({ "role": "assistant", "content": format!("r{i} {}", "y".repeat(300)) }),
            );
        }
        let session = Arc::new(Mutex::new(AgentSession {
            id: "compact-me".into(),
            messages,
            pending: HashMap::new(),
            cancel: CancellationToken::default(),
            always_allow: Vec::new(),
            world_state: None,
            compaction_failures: 0,
            context_length: None,
            usage: model::Usage::default(),
            last_prompt_tokens: 0,
            compactions: 0,
            compaction_instructions: None,
        }));
        agents
            .sessions
            .lock()
            .await
            .insert("compact-me".into(), session.clone());

        let result = agents
            .compact_session(
                &state,
                "compact-me",
                CompactInstructions::Unchanged,
                CompactTrigger::Manual,
            )
            .await
            .unwrap();
        assert_eq!(result["compacted"], json!(true));
        assert!(result["archivedMessages"].as_u64().unwrap() > 0);
        let before = result["estimatedTokensBefore"].as_u64().unwrap();
        let after = result["estimatedTokensAfter"].as_u64().unwrap();
        assert!(after < before, "compaction must shrink the transcript");

        // The live transcript now carries the summary marker and still opens
        // with the protected head.
        let guard = session.lock().await;
        assert_eq!(guard.messages[0]["role"], json!("system"));
        assert!(guard.messages.iter().any(|m| m["content"]
            .as_str()
            .is_some_and(|c| c.starts_with(crate::compaction::SUMMARY_MARKER))));
        drop(guard);

        // Replaced turns were soft-archived in the session file.
        let record = crate::sessions::load(&state.sessions_root, "compact-me").unwrap();
        let archived = record["archived"].as_array().unwrap();
        assert_eq!(
            archived.len() as u64,
            result["archivedMessages"].as_u64().unwrap()
        );

        // And the event bus announced the compaction.
        let mut saw_event = false;
        while let Ok(event) = rx.try_recv() {
            if event["type"] == "agent.compacted" {
                assert_eq!(event["sessionId"], json!("compact-me"));
                saw_event = true;
            }
        }
        assert!(saw_event, "agent.compacted event must be emitted");

        // With a generous budget the transcript fits: compact is a no-op,
        // not an error.
        {
            let mut config = state.config.write().await;
            config.compaction.context_length = Some(1_000_000);
        }
        let again = agents
            .compact_session(
                &state,
                "compact-me",
                CompactInstructions::Unchanged,
                CompactTrigger::Manual,
            )
            .await
            .unwrap();
        assert_eq!(again["compacted"], json!(false));
    }

    /// Transcript that compaction will split into an archived middle and a
    /// preserved tail. Index 3/4 are a `call-old` tool call and its result,
    /// deep enough in the middle to be archived — the concurrency tests below
    /// lean on that.
    fn over_budget_transcript() -> Vec<Value> {
        let mut messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "u".repeat(400) }),
            json!({ "role": "assistant", "content": "a".repeat(400) }),
            json!({
                "role": "assistant", "content": "",
                "tool_calls": [{ "id": "call-old", "type": "function",
                    "function": { "name": "file_read", "arguments": "{}" } }]
            }),
            json!({ "role": "tool", "tool_call_id": "call-old", "content": "t".repeat(1000) }),
        ];
        for i in 0..4 {
            messages
                .push(json!({ "role": "user", "content": format!("q{i} {}", "z".repeat(300)) }));
            messages.push(
                json!({ "role": "assistant", "content": format!("r{i} {}", "y".repeat(300)) }),
            );
        }
        messages
    }

    /// Session plus the messages a concurrent turn appends to it.
    type ConcurrentAppend = Arc<(Arc<Mutex<AgentSession>>, Vec<Value>)>;

    /// Summary provider that first simulates a second HTTP turn landing on
    /// the same session — appending to `messages` in the exact window where
    /// `compact_session` has released the lock to await this call.
    async fn appending_summary_provider(
        State(hook): State<ConcurrentAppend>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let (session, appended) = &*hook;
        let mut guard = session.lock().await;
        for message in appended {
            guard.messages.push(message.clone());
        }
        drop(guard);
        Sse::new(futures::stream::iter(content_stream(
            "Goal: verify compaction. Progress: transcript summarized.",
        )))
    }

    /// Builds a manager + state whose summary provider appends `appended` to
    /// the session mid-call, and registers the session under `id`.
    async fn compaction_race_fixture(
        id: &str,
        appended: Vec<Value>,
    ) -> (AgentManager, crate::AppState, Arc<Mutex<AgentSession>>) {
        let (bus, _rx) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let session = Arc::new(Mutex::new(AgentSession {
            id: id.into(),
            messages: over_budget_transcript(),
            pending: HashMap::new(),
            cancel: CancellationToken::default(),
            always_allow: Vec::new(),
            world_state: None,
            compaction_failures: 0,
            context_length: None,
            usage: model::Usage::default(),
            last_prompt_tokens: 0,
            compactions: 0,
            compaction_instructions: None,
        }));
        agents
            .sessions
            .lock()
            .await
            .insert(id.into(), session.clone());

        let hook: ConcurrentAppend = Arc::new((session.clone(), appended));
        let app = Router::new()
            .route("/v1/chat/completions", post(appending_summary_provider))
            .with_state(hook);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let state = make_state(addr, bus, agents.clone(), HashMap::new());
        {
            // budget = 1.0 × 120 − 20 = 100 tokens: far under the transcript.
            let mut config = state.config.write().await;
            config.compaction.context_length = Some(120);
            config.compaction.threshold = 1.0;
            config.compaction.reserved = 20;
        }
        (agents, state, session)
    }

    fn tool_call(name: &str, arguments: Value) -> ToolCall {
        ToolCall {
            id: format!("{name}-1"),
            name: name.into(),
            arguments,
            unparsed_arguments: None,
        }
    }

    #[tokio::test]
    async fn always_allow_grants_the_exact_tool_and_nothing_wider() {
        let (bus, _rx) = tokio::sync::broadcast::channel(8);
        let agents = AgentManager::new(bus);
        agents.ensure_session("grant").await.unwrap();

        assert!(agents
            .always_allow("grant", "mcp__blender__execute_blender_code")
            .await
            .unwrap());
        // Recording the same grant twice is a no-op, not a duplicate rule.
        assert!(!agents
            .always_allow("grant", "mcp__blender__execute_blender_code")
            .await
            .unwrap());

        let granted = {
            let session = agents.session("grant").await.unwrap();
            let guard = session.lock().await;
            guard.always_allow.clone()
        };
        let rules: Vec<PermissionRule> = granted
            .iter()
            .map(|tool| PermissionRule {
                pattern: tool.clone(),
                action: "allow".into(),
            })
            .collect();

        // The approved tool runs...
        assert_eq!(
            rule_decision(&rules, "mcp__blender__execute_blender_code"),
            Some(RuleAction::Allow)
        );
        // ...and its siblings on the same server do not. Approving one
        // destructive MCP tool must never hand over the whole server, which is
        // what a glob-shaped grant would have done.
        assert_eq!(rule_decision(&rules, "mcp__blender__delete_object"), None);
        assert_eq!(rule_decision(&rules, "file_write"), None);
    }

    #[tokio::test]
    async fn always_allow_refuses_a_tool_that_is_unknown() {
        let (bus, _rx) = tokio::sync::broadcast::channel(8);
        let agents = AgentManager::new(bus);
        assert!(agents
            .always_allow("no-such-session", "file_write")
            .await
            .is_err());
        agents.ensure_session("grant2").await.unwrap();
        assert!(agents.always_allow("grant2", "   ").await.is_err());
    }

    #[test]
    fn an_always_allow_can_never_outrank_a_configured_deny() {
        // Rules are last-match-wins, so an appended allow beats an earlier
        // deny. That is exactly why the grant is screened before it is
        // appended: otherwise a click in a dialog would quietly undo a
        // machine-wide policy the user wrote down on purpose.
        let configured = vec![PermissionRule {
            pattern: "file_write".into(),
            action: "deny".into(),
        }];
        assert_eq!(
            rule_decision(&configured, "file_write"),
            Some(RuleAction::Deny)
        );

        // What the merge in `chat` would produce if it did NOT screen.
        let mut unscreened = configured.clone();
        unscreened.push(PermissionRule {
            pattern: "file_write".into(),
            action: "allow".into(),
        });
        assert_eq!(
            rule_decision(&unscreened, "file_write"),
            Some(RuleAction::Allow),
            "this is the hole the screen closes"
        );

        // The screen: a denied tool is dropped rather than appended.
        let screened: Vec<PermissionRule> = configured.clone();
        assert_eq!(
            rule_decision(&screened, "file_write"),
            Some(RuleAction::Deny),
            "the configured deny must survive the grant"
        );
    }

    #[test]
    fn a_call_whose_answer_stops_changing_is_not_run_again() {
        let mut repeats = RepeatWatch::default();
        let call = tool_call("file_read", json!({ "path": "main.js" }));
        let same = json!({ "content": "unchanged" });

        // The first three identical answers are allowed: a retry after a
        // transient failure, and a deliberate re-check, are both legitimate.
        for expected in 1..=MAX_IDENTICAL_TOOL_RESULTS {
            assert!(
                repeats.stalled_outcome(&call).is_none(),
                "run {expected} must be allowed"
            );
            assert_eq!(repeats.record(&call, &same), expected);
        }

        // The fourth is refused, and says what to do instead.
        let stalled = repeats
            .stalled_outcome(&call)
            .expect("a fourth identical answer must be refused");
        let notice = stalled["repeatedCall"].as_str().unwrap();
        assert!(notice.contains("file_read"), "{notice}");
        assert!(notice.contains("change the arguments"), "{notice}");
        // The identical output is not replayed — it is already in the
        // transcript three times.
        assert!(stalled.get("content").is_none());
    }

    #[test]
    fn polling_that_returns_new_information_is_never_interrupted() {
        // The false positive this guard has to avoid: an agent watching a run
        // issues byte-identical calls forever and gets different answers each
        // time. Keying on the call alone would have killed it.
        let mut repeats = RepeatWatch::default();
        let call = tool_call("graph_status", json!({ "graphId": "g-1" }));
        for step in 0..12 {
            assert!(
                repeats.stalled_outcome(&call).is_none(),
                "a poll returning new state must keep running (step {step})"
            );
            repeats.record(&call, &json!({ "completed": step }));
        }

        // ...and the moment it does go quiet, the guard still catches it.
        let stuck = json!({ "completed": 11 });
        for _ in 0..MAX_IDENTICAL_TOOL_RESULTS {
            repeats.record(&call, &stuck);
        }
        assert!(repeats.stalled_outcome(&call).is_some());
    }

    #[test]
    fn different_arguments_are_tracked_separately() {
        let mut repeats = RepeatWatch::default();
        let a = tool_call("file_read", json!({ "path": "a.js" }));
        let b = tool_call("file_read", json!({ "path": "b.js" }));
        let same = json!({ "content": "" });
        for _ in 0..MAX_IDENTICAL_TOOL_RESULTS {
            repeats.record(&a, &same);
        }
        assert!(repeats.stalled_outcome(&a).is_some());
        // Reading a *different* file is different work, however similar the
        // answer looks.
        assert!(repeats.stalled_outcome(&b).is_none());
    }

    #[tokio::test]
    async fn pruning_alone_is_preferred_over_paying_for_a_summary() {
        // Over budget solely because one stale tool result is enormous — the
        // ordinary shape after a big grep or file_read. Dropping it is free;
        // summarizing costs a multi-second model call, its tokens, and every
        // detail the summary does not carry forward.
        let (bus, mut rx) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let mut messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "build the level" }),
            json!({ "role": "assistant", "content": "on it" }),
            json!({
                "role": "assistant", "content": "",
                "tool_calls": [{ "id": "call-old", "type": "function",
                    "function": { "name": "file_grep", "arguments": "{}" } }]
            }),
            json!({ "role": "tool", "tool_call_id": "call-old", "content": "m".repeat(40_000) }),
        ];
        for i in 0..3 {
            messages.push(json!({ "role": "user", "content": format!("next {i}") }));
            messages.push(json!({ "role": "assistant", "content": format!("done {i}") }));
        }
        let session = Arc::new(Mutex::new(AgentSession {
            id: "prune-only".into(),
            messages: messages.clone(),
            pending: HashMap::new(),
            cancel: CancellationToken::default(),
            always_allow: Vec::new(),
            world_state: None,
            compaction_failures: 0,
            context_length: None,
            usage: model::Usage::default(),
            last_prompt_tokens: 0,
            compactions: 0,
            compaction_instructions: None,
        }));
        agents
            .sessions
            .lock()
            .await
            .insert("prune-only".into(), session.clone());

        // A provider with no routes at all: any model call 404s and fails the
        // compaction, so `Ok` here is the proof that none was made.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, Router::new()).await.unwrap() });
        let state = make_state(addr, bus, agents.clone(), HashMap::new());
        {
            // budget = 1.0 × 1020 − 20 = 1000 tokens. The transcript is ~10k
            // before pruning and a few hundred after.
            let mut config = state.config.write().await;
            config.compaction.context_length = Some(1020);
            config.compaction.threshold = 1.0;
            config.compaction.reserved = 20;
        }

        let result = agents
            .compact_session(
                &state,
                "prune-only",
                CompactInstructions::Unchanged,
                CompactTrigger::Auto,
            )
            .await
            .expect("pruning must not need the model");
        assert_eq!(result["strategy"], json!("prune"));
        // The cheap path is still a compaction, and an automatic one has to
        // announce itself: without the event the transcript showed nothing
        // while the context meter dropped on its own.
        let mut pruned_event = None;
        while let Ok(event) = rx.try_recv() {
            if event["type"] == "agent.compacted" {
                pruned_event = Some(event);
            }
        }
        let pruned_event = pruned_event.expect("pruning must emit agent.compacted");
        assert_eq!(pruned_event["trigger"], json!("auto"));
        assert_eq!(pruned_event["strategy"], json!("prune"));
        assert_eq!(result["summarized"], json!(false));
        assert_eq!(result["prunedToolResults"], json!(1));
        assert!(
            result["estimatedTokens"].as_u64().unwrap() <= 1000,
            "pruning must actually get under budget: {result}"
        );

        let guard = session.lock().await;
        // Nothing was archived or replaced by a summary: the conversation is
        // all still there, only the stale tool payload is shorter.
        assert_eq!(guard.messages.len(), messages.len());
        assert_eq!(guard.compactions, 0, "pruning is not a wholesale rewrite");
        let tool = guard.messages[4]["content"].as_str().unwrap();
        assert!(tool.len() < 1_000, "the stale tool result must be pruned");
        assert!(tool.contains("pruned"), "and must say so: {tool}");
        // The recent turns are untouched.
        assert_eq!(guard.messages[9]["content"], json!("next 2"));
    }

    #[tokio::test]
    async fn compaction_remerges_a_turn_appended_during_the_summary_call() {
        // A plain user/assistant exchange appended while the summary model
        // call is in flight. Nothing in it depends on the archived middle, so
        // it must survive the swap instead of being silently overwritten.
        let appended = vec![
            json!({ "role": "user", "content": "concurrent question" }),
            json!({ "role": "assistant", "content": "concurrent answer" }),
        ];
        let (agents, state, session) =
            compaction_race_fixture("race-merge", appended.clone()).await;

        let result = agents
            .compact_session(
                &state,
                "race-merge",
                CompactInstructions::Unchanged,
                CompactTrigger::Manual,
            )
            .await
            .unwrap();
        assert_eq!(result["compacted"], json!(true));
        assert_eq!(result["remergedMessages"], json!(2));

        let guard = session.lock().await;
        // Compaction still happened...
        assert_eq!(guard.messages[0]["role"], json!("system"));
        assert!(guard.messages.iter().any(|m| m["content"]
            .as_str()
            .is_some_and(|c| c.starts_with(crate::compaction::SUMMARY_MARKER))));
        // ...and the concurrent turn is intact, in order, at the end.
        assert_eq!(&guard.messages[guard.messages.len() - 2..], &appended[..]);
        assert_eq!(guard.compactions, 1, "the generation counter must advance");
    }

    #[tokio::test]
    async fn compaction_refuses_when_the_appended_tail_orphans_a_tool_result() {
        // The dangerous shape: a tool result for `call-old`, whose assistant
        // `tool_calls` message compaction is about to archive. Re-merging it
        // would hand the provider an unanswerable tool message and 400 the
        // whole session, so compaction must refuse and leave the transcript
        // exactly as it found it.
        let appended =
            vec![json!({ "role": "tool", "tool_call_id": "call-old", "content": "late result" })];
        let (agents, state, session) =
            compaction_race_fixture("race-orphan", appended.clone()).await;

        let error = agents
            .compact_session(
                &state,
                "race-orphan",
                CompactInstructions::Unchanged,
                CompactTrigger::Manual,
            )
            .await
            .expect_err("compaction must refuse an unmergeable tail")
            .to_string();
        assert!(
            error.contains("transcript moved"),
            "error must name the cause, got: {error}"
        );

        // The appended message is still there, and so is the full history:
        // refusing costs a retry, swapping would have cost the session.
        let guard = session.lock().await;
        let expected: Vec<Value> = over_budget_transcript()
            .into_iter()
            .chain(appended)
            .collect();
        assert_eq!(guard.messages, expected);
        assert_eq!(
            guard.compactions, 0,
            "a refused compaction is not a generation"
        );
    }

    #[test]
    fn clean_tail_check_tracks_ids_introduced_by_the_suffix() {
        let compacted = vec![json!({
            "role": "assistant", "content": "",
            "tool_calls": [{ "id": "kept", "type": "function",
                "function": { "name": "file_read", "arguments": "{}" } }]
        })];
        // Answering a call the compacted transcript still shows: mergeable.
        assert!(suffix_is_clean_tail(
            &compacted,
            &[json!({ "role": "tool", "tool_call_id": "kept", "content": "ok" })]
        ));
        // A complete call/result pair appended during the summary carries its
        // own issuing message, so it is mergeable too.
        assert!(suffix_is_clean_tail(
            &compacted,
            &[
                json!({ "role": "assistant", "content": "",
                    "tool_calls": [{ "id": "fresh", "type": "function",
                        "function": { "name": "file_read", "arguments": "{}" } }] }),
                json!({ "role": "tool", "tool_call_id": "fresh", "content": "ok" }),
            ]
        ));
        // Order matters: the result may not precede its call.
        assert!(!suffix_is_clean_tail(
            &compacted,
            &[
                json!({ "role": "tool", "tool_call_id": "fresh", "content": "ok" }),
                json!({ "role": "assistant", "content": "",
                    "tool_calls": [{ "id": "fresh", "type": "function",
                        "function": { "name": "file_read", "arguments": "{}" } }] }),
            ]
        ));
        // Answering a call that compaction archived: not mergeable.
        assert!(!suffix_is_clean_tail(
            &compacted,
            &[json!({ "role": "tool", "tool_call_id": "gone", "content": "orphan" })]
        ));
        // A tool message with no id at all is not a tail we can reason about.
        assert!(!suffix_is_clean_tail(
            &compacted,
            &[json!({ "role": "tool", "content": "idless" })]
        ));
    }

    #[tokio::test]
    async fn cancellation_token_reports_who_flipped_it_and_survives_reset() {
        let token = CancellationToken::default();
        assert!(!token.is_cancelled());
        assert!(token.cancel(), "the first stop is the one that cancels");
        assert!(token.is_cancelled());
        assert!(
            !token.cancel(),
            "a second stop press must report as a no-op, not a fresh cancellation"
        );

        // Already-cancelled tokens resolve immediately; a waiter that only
        // woke on a *future* cancel would park the loop forever here.
        tokio::time::timeout(std::time::Duration::from_secs(1), token.cancelled())
            .await
            .expect("an already-cancelled token must resolve without a further cancel");

        token.reset();
        assert!(!token.is_cancelled(), "reset clears a stale stop");
        assert!(token.cancel(), "a reset token can be cancelled again");
    }

    #[tokio::test]
    async fn cancelled_waits_for_a_stop_that_arrives_later() {
        let token = CancellationToken::default();
        let waiter = {
            let token = token.clone();
            tokio::spawn(async move { token.cancelled().await })
        };
        // The waiter is parked on a token that is not yet cancelled.
        assert!(!token.is_cancelled());
        token.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("a parked waiter must wake on cancel")
            .expect("waiter task panicked");
    }

    #[tokio::test]
    async fn cancel_session_is_idempotent_and_tolerates_a_finished_turn() {
        let (bus, _rx) = tokio::sync::broadcast::channel(8);
        let agents = AgentManager::new(bus);

        // Racing a turn that already returned is the ordinary case, not an
        // error: the stop button and the loop finish in either order.
        let (found, cancelled) = agents.cancel_session("never-existed").await;
        assert!(!found);
        assert!(!cancelled);

        agents.ensure_session("session-cancel").await.unwrap();
        let (found, cancelled) = agents.cancel_session("session-cancel").await;
        assert!(found);
        assert!(cancelled, "the first stop flips the token");

        let (found, cancelled) = agents.cancel_session("session-cancel").await;
        assert!(found);
        assert!(!cancelled, "a repeated stop is not a second cancellation");

        let session = agents.session("session-cancel").await.unwrap();
        assert!(session.lock().await.cancel.is_cancelled());
    }

    #[tokio::test]
    async fn removing_a_session_cancels_its_running_turn() {
        let (bus, _rx) = tokio::sync::broadcast::channel(8);
        let agents = AgentManager::new(bus);
        agents
            .ensure_session("session-removed-mid-turn")
            .await
            .unwrap();
        // A running turn holds its own Arc, so the token has to be flipped
        // before the map entry goes — otherwise the loop keeps billing against
        // a transcript that no longer exists.
        let session = agents.session("session-removed-mid-turn").await.unwrap();
        let token = { session.lock().await.cancel.clone() };
        agents.remove_session("session-removed-mid-turn").await;
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn removing_a_session_drops_pending_tool_requests() {
        let (bus, _rx) = tokio::sync::broadcast::channel(8);
        let agents = AgentManager::new(bus);
        agents.ensure_session("session-remove").await.unwrap();
        let session = agents.session("session-remove").await.unwrap();
        let (tx, rx) = oneshot::channel();
        session
            .lock()
            .await
            .pending
            .insert("pending-tool".into(), tx);

        assert_eq!(agents.remove_session("session-remove").await, (true, 1));
        assert!(
            rx.await.is_err(),
            "removing a session must close pending tool/approval requests"
        );
        assert!(agents.session("session-remove").await.is_err());
        assert_eq!(agents.remove_session("session-remove").await, (false, 0));
    }

    #[tokio::test]
    async fn eviction_spares_sessions_awaiting_a_tool_or_approval_reply() {
        let (bus, _rx) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus);

        // A session parked on a browser-tool oneshot holds no lock — it has
        // only registered a sender in `pending` — so try_lock alone would
        // happily evict it.
        let waiting = agents.get_or_create(None).await.unwrap();
        let waiting_id = waiting.lock().await.id.clone();
        let (tx, rx) = oneshot::channel();
        waiting
            .lock()
            .await
            .pending
            .insert("tool-waiting".into(), tx);

        // Push the manager well past the cap with fresh, idle sessions.
        let mut idle_ids = Vec::new();
        for _ in 0..MAX_SESSIONS * 2 {
            idle_ids.push(
                agents
                    .get_or_create(None)
                    .await
                    .unwrap()
                    .lock()
                    .await
                    .id
                    .clone(),
            );
        }

        // Eviction ran (idle sessions were dropped) but spared the waiter.
        let live = agents.sessions.lock().await;
        assert!(live.len() <= MAX_SESSIONS + 1, "eviction must still run");
        assert!(
            live.contains_key(&waiting_id),
            "a session with pending requests must never be evicted"
        );
        assert!(
            idle_ids.iter().any(|id| !live.contains_key(id)),
            "idle sessions must still be evictable"
        );
        drop(live);

        // And the symptom the eviction bug produced is gone: the reply still
        // lands instead of failing with "session not found" and hanging the
        // tool to its 300s timeout.
        agents
            .submit_tool_result(&waiting_id, "tool-waiting", json!({ "ok": true }))
            .await
            .expect("pending request must still be answerable");
        assert_eq!(rx.await.unwrap(), json!({ "ok": true }));
    }

    /// Phase 0's free fix, and a seventh path to a denial nobody asked for.
    ///
    /// `submit_tool_result` and the old `submit_approval` indexed the same
    /// `session.pending` map. An `agent_tool_result` carrying an `approval-`
    /// request id therefore delivered a tool-result JSON to the approval
    /// waiter, where `approved` is absent and `unwrap_or(false)` read it as
    /// **denied** — a file write refused because a browser tool answered the
    /// wrong question.
    #[tokio::test]
    async fn approval_and_tool_request_ids_cannot_answer_each_other() {
        let (bus, mut rx) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus);
        let session = agents.get_or_create(None).await.unwrap();
        let session_id = session.lock().await.id.clone();
        agents
            .approvals()
            .cancel_by_session(&session_id) // no-op; proves the registry is reachable
            .await;

        let approvals = agents.approvals().clone();
        let answer_session = session_id.clone();
        let waiter = tokio::spawn(async move {
            approvals
                .request(crate::approvals::ApprovalRequest {
                    answer_session: &answer_session,
                    target_client_id: Some("window-a".into()),
                    owner_session: Some(answer_session.clone()),
                    owner_graph: None,
                    asking_session: &answer_session,
                    tool: "file_write",
                    arguments: json!({ "path": "a.txt" }),
                })
                .await
        });
        let request_id = loop {
            let event = rx.recv().await.unwrap();
            if event["type"] == "agent.approval_request" {
                break event["requestId"].as_str().unwrap().to_string();
            }
        };

        // A tool result addressed at the approval's id finds nothing: the two
        // kinds no longer share a keyspace.
        let crossed = agents
            .submit_tool_result(&session_id, &request_id, json!({ "message": "hi" }))
            .await
            .expect_err("a tool result must not reach an approval waiter");
        assert!(
            crossed.to_string().contains("no pending request"),
            "unexpected error: {crossed}"
        );

        // And the approval is still there, still answerable, still not denied.
        agents
            .approvals()
            .respond(&request_id, Some("window-a"), true, None)
            .await
            .expect("the approval survived the crossed submission");
        assert_eq!(
            waiter.await.unwrap(),
            crate::approvals::ApprovalOutcome::Approved
        );
    }

    /// Approvals left `session.pending`, so the eviction guard that filtered
    /// victims on that map being non-empty would now happily evict a session
    /// parked on an approval — after which the answer address is gone.
    #[tokio::test]
    async fn a_session_parked_on_an_approval_is_never_evicted() {
        let (bus, mut rx) = tokio::sync::broadcast::channel(256);
        let agents = AgentManager::new(bus);
        let parked = agents.get_or_create(None).await.unwrap();
        let parked_id = parked.lock().await.id.clone();

        let approvals = agents.approvals().clone();
        let answer_session = parked_id.clone();
        tokio::spawn(async move {
            approvals
                .request(crate::approvals::ApprovalRequest {
                    answer_session: &answer_session,
                    target_client_id: Some("window-a".into()),
                    owner_session: Some(answer_session.clone()),
                    owner_graph: None,
                    asking_session: &answer_session,
                    tool: "file_write",
                    arguments: json!({}),
                })
                .await
        });
        let request_id = loop {
            let event = rx.recv().await.unwrap();
            if event["type"] == "agent.approval_request" {
                break event["requestId"].as_str().unwrap().to_string();
            }
        };

        let mut idle_ids = Vec::new();
        for _ in 0..MAX_SESSIONS * 2 {
            idle_ids.push(agents.reserve_session().await.unwrap());
        }

        let live = agents.sessions.lock().await;
        assert!(
            live.contains_key(&parked_id),
            "a session parked on an approval must never be evicted"
        );
        assert!(
            idle_ids.iter().any(|id| !live.contains_key(id)),
            "idle sessions must still be evictable"
        );
        drop(live);

        agents
            .approvals()
            .respond(&request_id, Some("window-a"), true, None)
            .await
            .expect("the parked approval must still be answerable");
    }

    /// Deleting a session used to wake its waiters by dropping `pending`.
    /// Approvals are elsewhere now, so the removal has to say so explicitly —
    /// and it must abandon them, never deny them.
    #[tokio::test]
    async fn removing_a_session_wakes_its_parked_approval() {
        let (bus, mut rx) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus);
        let session = agents.get_or_create(None).await.unwrap();
        let session_id = session.lock().await.id.clone();

        let approvals = agents.approvals().clone();
        let answer_session = session_id.clone();
        let waiter = tokio::spawn(async move {
            approvals
                .request(crate::approvals::ApprovalRequest {
                    answer_session: &answer_session,
                    target_client_id: Some("window-a".into()),
                    owner_session: Some(answer_session.clone()),
                    owner_graph: None,
                    asking_session: &answer_session,
                    tool: "file_write",
                    arguments: json!({}),
                })
                .await
        });
        loop {
            let event = rx.recv().await.unwrap();
            if event["type"] == "agent.approval_request" {
                break;
            }
        }

        let (removed, cancelled) = agents.remove_session(&session_id).await;
        assert!(removed);
        assert_eq!(cancelled, 1, "the parked approval must be counted");
        assert!(matches!(
            waiter.await.unwrap(),
            crate::approvals::ApprovalOutcome::Abandoned("session-gone")
        ));
    }

    #[test]
    fn approval_owner_resolves_without_inventing_an_owner() {
        assert_eq!(
            ApprovalOwner::OwnSession.resolve("session-a"),
            Some("session-a")
        );
        assert_eq!(
            ApprovalOwner::Ancestor("session-root".into()).resolve("session-a"),
            Some("session-root")
        );
        // The case the whole enum exists for: unattended work names nobody
        // rather than naming itself, which a panel could then match.
        assert_eq!(ApprovalOwner::Unowned.resolve("session-a"), None);

        assert_eq!(ApprovalOwner::from_ancestor(None), ApprovalOwner::Unowned);
        assert_eq!(
            ApprovalOwner::from_ancestor(Some("   ".into())),
            ApprovalOwner::Unowned
        );
        assert_eq!(
            ApprovalOwner::from_ancestor(Some(" session-root ".into())),
            ApprovalOwner::Ancestor("session-root".into())
        );
        assert_eq!(ApprovalOwner::default(), ApprovalOwner::OwnSession);
    }

    #[tokio::test]
    async fn reserved_sessions_use_the_bounded_allocator() {
        let (bus, _rx) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus);
        let mut ids = Vec::new();
        for _ in 0..MAX_SESSIONS * 2 {
            ids.push(agents.reserve_session().await.unwrap());
        }

        let live = agents.sessions.lock().await;
        assert!(live.len() <= MAX_SESSIONS);
        assert!(
            ids.iter().any(|id| !live.contains_key(id)),
            "reservations must evict old idle sessions instead of leaking them"
        );
        assert!(live.contains_key(ids.last().unwrap()));
    }

    #[test]
    fn starting_a_dev_server_always_asks_outside_full_access() {
        // `devserver_start` runs a script out of the workspace's own
        // package.json, so an unprompted one is arbitrary code execution from
        // a cloned repo. Only the mode that says it never asks may skip it.
        for mode in ["supervised", "auto-accept-edits", "auto"] {
            assert!(
                requires_approval(mode, "devserver_start", true),
                "{mode} let devserver_start run unprompted"
            );
        }
        assert!(!requires_approval("full-access", "devserver_start", true));
    }

    #[test]
    fn mcp_tools_gate_on_server_trust() {
        // Untrusted MCP tools count as destructive; trusted ones flow like
        // scene edits.
        assert!(requires_approval("auto-accept-edits", "mcp__x__y", false));
        assert!(!requires_approval("auto-accept-edits", "mcp__x__y", true));
        assert!(requires_approval("auto", "mcp__x__y", false));
        assert!(!requires_approval("auto", "mcp__x__y", true));
        assert!(!requires_approval("full-access", "mcp__x__y", false));
        assert!(requires_approval("supervised", "mcp__x__y", true));
    }

    #[test]
    fn an_ordinary_tool_result_reaches_the_history_untouched() {
        // The backstop must cost nothing in the common case: it is the last
        // line of defence, not a second formatter.
        let outcome = json!({ "path": "a.txt", "content": "hello" });
        assert_eq!(
            bound_tool_result("file_read", &outcome, None),
            outcome.to_string()
        );
    }

    #[test]
    fn an_oversized_result_keeps_its_tail_reachable() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("tool-output");
        // A grep whose interesting match is past the halfway cut: the old
        // behaviour returned the first half and told the model to narrow a call
        // it had no way to narrow.
        let mut lines: Vec<String> = (0..40_000).map(|i| format!("src/a{i}.js: hit")).collect();
        lines.push("src/THE_ONE.js: the match that mattered".into());
        let flood = json!({ "matches": lines.join("\n") });

        let bounded = bound_tool_result("file_grep", &flood, Some(&dir));
        assert!(bounded.len() < MAX_TOOL_RESULT_BYTES);
        let parsed: Value = serde_json::from_str(&bounded).unwrap();
        assert_eq!(parsed["truncated"], true);

        let id = parsed["outputId"]
            .as_str()
            .expect("an oversized result must leave a handle to the rest");
        assert!(parsed["notice"]
            .as_str()
            .unwrap()
            .contains("tool_output_read"));

        // The tail is genuinely retrievable, not just referenced: walk the
        // pages the way the model is told to.
        let mut whole = String::new();
        let mut offset = 0usize;
        loop {
            let page = crate::spill::read(&dir, id, offset, None).unwrap();
            whole.push_str(page["content"].as_str().unwrap());
            match page["nextOffset"].as_u64() {
                Some(next) => offset = next as usize,
                None => break,
            }
        }
        assert!(
            whole.contains("THE_ONE"),
            "the part past the cut must still be reachable"
        );
    }

    #[test]
    fn an_unwritable_spill_directory_still_returns_a_usable_result() {
        // Losing the tail is bad; failing the tool call outright is worse.
        let flood = json!({ "content": "z".repeat(MAX_TOOL_RESULT_BYTES * 2) });
        let bounded = bound_tool_result(
            "mcp__scraper__fetch",
            &flood,
            Some(std::path::Path::new("/proc/nonexistent/cannot-create")),
        );
        let parsed: Value = serde_json::from_str(&bounded).expect("must still be JSON");
        assert_eq!(parsed["truncated"], true);
        assert!(parsed.get("outputId").is_none());
        assert!(parsed["preview"].is_string());
        assert!(parsed["notice"]
            .as_str()
            .unwrap()
            .contains("Narrow the call"));
    }

    #[test]
    fn an_oversized_tool_result_is_bounded_and_stays_parseable() {
        // MCP servers are third parties with no idea they are spending our
        // context window, and their output lands in `messages` for the rest of
        // the session.
        let flood = json!({ "content": "z".repeat(MAX_TOOL_RESULT_BYTES * 2) });
        let bounded = bound_tool_result("mcp__scraper__fetch", &flood, None);
        assert!(
            bounded.len() < MAX_TOOL_RESULT_BYTES,
            "bounded result was {} bytes",
            bounded.len()
        );

        // Cutting JSON mid-string would cost the model a turn to discover the
        // result is unparseable, on top of the turn that produced it.
        let parsed: Value = serde_json::from_str(&bounded).expect("bounded result must be JSON");
        assert_eq!(parsed["truncated"], true);
        assert_eq!(parsed["tool"], "mcp__scraper__fetch");
        assert!(parsed["notice"]
            .as_str()
            .unwrap()
            .contains("Narrow the call"));
        assert!(parsed["preview"]
            .as_str()
            .unwrap()
            .starts_with("{\"content"));
    }

    #[test]
    fn a_captured_frame_leaves_a_receipt_instead_of_its_pixels() {
        let frame = format!("data:image/png;base64,{}", "A".repeat(70_000));
        let outcome = json!({ "dataUrl": frame, "frame": 12 });
        let bounded = bound_tool_result("editor_capture_frame", &outcome, None);
        let parsed: Value = serde_json::from_str(&bounded).unwrap();

        assert!(
            !bounded.contains("AAAA"),
            "base64 survived into the transcript"
        );
        assert!(bounded.len() < 1_000, "receipt was {} bytes", bounded.len());
        // The receipt has to say what to do instead, or the model just calls
        // the same tool again looking for the pixels.
        assert!(parsed["dataUrl"]
            .as_str()
            .unwrap()
            .contains("editor_persist_capture"));
        // Everything beside the payload survives: the frame number is what a
        // report cites.
        assert_eq!(parsed["frame"], 12);
    }

    #[test]
    fn a_short_data_url_is_left_alone() {
        // Tool schemas and placeholders carry example data URLs. Rewriting
        // those would make the elision itself the confusing part.
        let outcome = json!({ "example": "data:image/png;base64,AAAA" });
        assert_eq!(
            bound_tool_result("editor_asset_preview", &outcome, None),
            outcome.to_string()
        );
    }

    #[test]
    fn bounding_never_splits_a_codepoint() {
        let flood = json!({ "content": "漢".repeat(MAX_TOOL_RESULT_BYTES) });
        let bounded = bound_tool_result("mcp__x__y", &flood, None);
        let parsed: Value = serde_json::from_str(&bounded).unwrap();
        assert!(!parsed["preview"].as_str().unwrap().contains('\u{fffd}'));
    }
}
