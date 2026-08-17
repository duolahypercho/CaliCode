//! The `/loop` driver, owned by core rather than by the panel that started it.
//!
//! It used to live in `AgentPanel.tsx`, and its state was React refs. That is
//! the whole reason this module exists: a loop whose cancel flag is a ref dies
//! with the browser tab, cannot be resumed after a reload, and cannot be
//! started by anything that is not a person looking at a composer — no cron, no
//! headless run, no second client. Moving the driver here makes the loop a
//! server-side object with an id, and the panel becomes one of several possible
//! views onto it.
//!
//! **The goal is data.** A `Standard` iteration sends the user's words
//! verbatim; only `Aaa` wraps them in the quality pipeline's instructions. The
//! previous driver rewrote every goal into a mandated task-graph topology on
//! every iteration, which is how "fix the typo in the README" came to be
//! answered with three specialist build roots and a demand for screenshots.
//!
//! **Completion is profile-shaped.** `Standard` takes DONE at its word, which
//! is what every other harness does. `Aaa` refuses it until the durable report
//! passes `loop_report::validate_completion_readiness` — the same gate a model
//! calling `loop_report_update` has to clear, so the loop cannot finish itself
//! by a route the report would have rejected.

use crate::agent::CancellationToken;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// How long between automatic restore points during a loop.
///
/// A loop edits unattended for a long time, so the checkpoint is the only way
/// back; it is throttled rather than per-iteration because a fast loop would
/// otherwise snapshot the whole workspace every few seconds. Mirrors
/// `AUTO_CHECKPOINT_INTERVAL_MS` in `client/src/lib/checkpoints.ts`.
const AUTO_CHECKPOINT_INTERVAL_MS: u64 = 15 * 60_000;

/// Disambiguates loop ids minted inside one millisecond. See `start`.
static LOOP_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Runaway backstop, not a product limit. The real exit is the completion
/// gate; this only bounds a loop that is making no progress at all and would
/// otherwise bill forever. Mirrors `MAX_LOOP_ITERATIONS` in the client.
pub const MAX_ITERATIONS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoopProfile {
    /// The goal, verbatim. DONE is believed.
    #[default]
    Standard,
    /// The quality pipeline: a specialist task graph, PIE evidence, a judge,
    /// and a durable report that must clear its own completion gate.
    Aaa,
}

impl LoopProfile {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "aaa" => LoopProfile::Aaa,
            _ => LoopProfile::Standard,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Completed,
    Stopped,
    Failed,
}

/// Everything needed to run a loop, assembled by the RPC so prompt building
/// stays in `rpc.rs` where the rest of it lives.
#[derive(Debug, Clone)]
pub struct LoopSpec {
    pub slug: String,
    pub goal: String,
    pub profile: LoopProfile,
    /// Watch mode: wait this long between iterations and keep going after the
    /// goal is met, instead of finishing at the first accepted DONE.
    pub interval_ms: Option<u64>,
    /// Session to run in. `None` creates one on the first iteration.
    pub session_id: Option<String>,
    pub workspace_root: Option<String>,
    pub permission_mode: String,
    pub system: Option<String>,
    pub context_length: Option<u32>,
    pub guardian_model: Option<String>,
    pub max_iterations: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopView {
    pub loop_id: String,
    pub slug: String,
    pub goal: String,
    pub profile: LoopProfile,
    pub status: RunStatus,
    pub iteration: usize,
    pub max_iterations: usize,
    pub started_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Why the loop ended, for a terminal status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

struct Run {
    view: LoopView,
    cancel: CancellationToken,
}

#[derive(Clone, Default)]
pub struct LoopManager {
    runs: Arc<RwLock<HashMap<String, Arc<RwLock<Run>>>>>,
}

impl LoopManager {
    /// Start a loop and return its view immediately. The driver runs detached,
    /// so the caller's HTTP request does not stay open for what may be an hour
    /// of work — that coupling is exactly what made the old loop die with its
    /// tab.
    pub async fn start(&self, state: &crate::AppState, spec: LoopSpec) -> Result<LoopView> {
        if spec.goal.trim().is_empty() {
            anyhow::bail!("a loop needs a goal");
        }
        let started_at_ms = now_ms();
        // The timestamp alone is not unique: two loops started in the same
        // millisecond produced the same id, and the second silently replaced
        // the first in the registry — so `loop_stop` reached the wrong run and
        // the displaced one became unstoppable. The counter makes the id
        // unique within a process; the timestamp keeps it sortable.
        let seq = LOOP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let loop_id = format!("loop-{}{}", radix36(started_at_ms), radix36(seq));
        let view = LoopView {
            loop_id: loop_id.clone(),
            slug: spec.slug.clone(),
            goal: spec.goal.clone(),
            profile: spec.profile,
            status: RunStatus::Running,
            iteration: 0,
            max_iterations: spec.max_iterations.clamp(1, MAX_ITERATIONS),
            started_at_ms,
            interval_ms: spec.interval_ms,
            session_id: spec.session_id.clone(),
            detail: None,
        };
        let cancel = CancellationToken::default();
        let run = Arc::new(RwLock::new(Run {
            view: view.clone(),
            cancel: cancel.clone(),
        }));
        self.runs.write().await.insert(loop_id.clone(), run.clone());

        let manager = self.clone();
        let state = state.clone();
        let spec = LoopSpec {
            max_iterations: view.max_iterations,
            ..spec
        };
        tokio::spawn(async move {
            let outcome = manager
                .drive(&state, &loop_id, spec, run.clone(), cancel)
                .await;
            let (status, detail) = match outcome {
                Ok(Outcome::Completed(detail)) => (RunStatus::Completed, detail),
                Ok(Outcome::Stopped(detail)) => (RunStatus::Stopped, detail),
                Err(error) => (RunStatus::Failed, format!("{error:#}")),
            };
            let view = {
                let mut guard = run.write().await;
                guard.view.status = status;
                guard.view.detail = Some(detail);
                guard.view.clone()
            };
            let _ = state.bus.send(json!({
                "type": "loop.finished",
                "loop": view,
            }));
        });
        Ok(view)
    }

    pub async fn stop(&self, loop_id: &str) -> Result<LoopView> {
        let run = self
            .runs
            .read()
            .await
            .get(loop_id)
            .cloned()
            .with_context(|| format!("no loop named '{loop_id}'"))?;
        let guard = run.read().await;
        guard.cancel.cancel();
        Ok(guard.view.clone())
    }

    pub async fn status(&self, loop_id: &str) -> Result<LoopView> {
        let run = self
            .runs
            .read()
            .await
            .get(loop_id)
            .cloned()
            .with_context(|| format!("no loop named '{loop_id}'"))?;
        let view = run.read().await.view.clone();
        Ok(view)
    }

    pub async fn list(&self) -> Vec<LoopView> {
        let runs: Vec<Arc<RwLock<Run>>> = self.runs.read().await.values().cloned().collect();
        let mut out = Vec::with_capacity(runs.len());
        for run in runs {
            out.push(run.read().await.view.clone());
        }
        out.sort_by_key(|view| std::cmp::Reverse(view.started_at_ms));
        out
    }

    async fn drive(
        &self,
        state: &crate::AppState,
        loop_id: &str,
        spec: LoopSpec,
        run: Arc<RwLock<Run>>,
        cancel: CancellationToken,
    ) -> Result<Outcome> {
        let mut session_id = spec.session_id.clone();
        let mut completed_once = false;
        let mut last_checkpoint_at: Option<u64> = None;
        // Only the pipeline keeps a durable report. A `standard` loop writing
        // one would be filing paperwork nobody asked for and nothing reads.
        let reports = spec.profile == LoopProfile::Aaa;
        if reports {
            if let Err(error) = crate::loop_report::create(
                &state.projects_root,
                &spec.slug,
                loop_id,
                crate::loop_report::NewLoopReport {
                    objective: spec.goal.clone(),
                    reference: None,
                    started_at_ms: now_ms(),
                },
            ) {
                tracing::warn!(loop_id, %error, "loop report could not be opened; continuing");
            }
        }

        for iteration in 1..=spec.max_iterations {
            if cancel.is_cancelled() {
                if reports {
                    close_report(
                        state,
                        &spec,
                        loop_id,
                        crate::loop_report::LoopStatus::Cancelled,
                        "Loop stopped by the user.",
                    );
                }
                return Ok(Outcome::Stopped(format!(
                    "stopped after {} iterations",
                    iteration - 1
                )));
            }
            {
                let mut guard = run.write().await;
                guard.view.iteration = iteration;
                guard.view.session_id = session_id.clone();
            }
            // A restore point before the turn, not after: the thing worth
            // getting back to is the state *before* an unattended edit, and a
            // snapshot taken afterwards has already lost it.
            let now = now_ms();
            let due = last_checkpoint_at
                .is_none_or(|last| now.saturating_sub(last) >= AUTO_CHECKPOINT_INTERVAL_MS);
            if due {
                // Stamped before the call, not after: a checkpoint that fails
                // must not leave every following iteration retrying a copy
                // that is going to fail the same way.
                last_checkpoint_at = Some(now);
                match crate::checkpoints::create(&state.projects_root, &spec.slug) {
                    Ok(created) => {
                        let id = created.get("id").and_then(Value::as_str).unwrap_or("");
                        tracing::info!(
                            loop_id,
                            iteration,
                            id,
                            "restore point taken before a loop turn"
                        );
                    }
                    // A missing restore point is worth saying out loud and not
                    // worth stopping for: the loop's work is still the point.
                    Err(error) => {
                        tracing::warn!(loop_id, iteration, %error, "restore point failed; continuing")
                    }
                }
            }

            let iteration_started_at = now_ms();
            let prompt = iteration_prompt(&spec, loop_id, iteration);
            let _ = state.bus.send(json!({
                "type": "loop.iteration",
                "loopId": loop_id,
                "iteration": iteration,
                "maxIterations": spec.max_iterations,
                "prompt": prompt,
            }));

            // Tools are re-read each iteration: an editor can attach or detach
            // mid-loop, and a loop that cached the empty set at start would
            // keep telling a connected editor's model that it has no scene.
            let mut registered = state.tools.read().await.clone();
            registered.extend(state.mcp.tool_defs().await);
            let options = crate::agent::AgentOptions {
                permission_mode: spec.permission_mode.clone(),
                max_turns: crate::agent::DEFAULT_MAX_TURNS,
                context_length: spec.context_length,
                // A loop's last turn must produce a textual verdict, or the
                // completion check has nothing to read.
                final_response_drain: true,
                reasoning_effort: None,
                guardian_model: spec.guardian_model.clone(),
                loop_id: Some(loop_id.to_string()),
                system: spec.system.clone(),
                model_roles: Vec::new(),
                project_slug: Some(spec.slug.clone()),
                workspace_root: spec.workspace_root.clone(),
                ..Default::default()
            };
            let messages = vec![json!({ "role": "user", "content": prompt })];

            let turn = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    return Ok(Outcome::Stopped(format!(
                        "stopped during iteration {iteration}"
                    )));
                }
                turn = state.agents.chat(
                    state,
                    &registered,
                    session_id.as_deref(),
                    &messages,
                    options,
                ) => turn,
            };
            let turn = turn.with_context(|| format!("loop iteration {iteration}"))?;
            if let Some(id) = turn.get("sessionId").and_then(Value::as_str) {
                session_id = Some(id.to_string());
            }
            let reply = turn
                .get("reply")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();

            if reports {
                record_iteration(state, &spec, loop_id, &turn, iteration_started_at, &reply);
            }

            if says_done(&reply) {
                match completion_blocker(state, &spec, loop_id) {
                    None => {
                        completed_once = true;
                        let _ = state.bus.send(json!({
                            "type": "loop.completed",
                            "loopId": loop_id,
                            "iteration": iteration,
                        }));
                        if spec.interval_ms.is_none() {
                            if reports {
                                close_report(
                                    state,
                                    &spec,
                                    loop_id,
                                    crate::loop_report::LoopStatus::Completed,
                                    &reply,
                                );
                            }
                            return Ok(Outcome::Completed(format!(
                                "goal met in {iteration} iterations"
                            )));
                        }
                    }
                    Some(reason) => {
                        // DONE is refused, not ignored: the model is told why,
                        // because a bare "no" teaches it only that the door is
                        // shut and it tries the same door next iteration.
                        let _ = state.bus.send(json!({
                            "type": "loop.done_refused",
                            "loopId": loop_id,
                            "iteration": iteration,
                            "reason": reason,
                        }));
                    }
                }
            }

            if let Some(interval) = spec.interval_ms {
                if iteration < spec.max_iterations {
                    let wait = std::time::Duration::from_millis(interval);
                    tokio::select! {
                        _ = cancel.cancelled() => {
                            return Ok(Outcome::Stopped(format!(
                                "watch stopped after {iteration} iterations"
                            )));
                        }
                        _ = tokio::time::sleep(wait) => {}
                    }
                }
            }
        }
        if reports && !completed_once {
            close_report(
                state,
                &spec,
                loop_id,
                crate::loop_report::LoopStatus::Blocked,
                "Loop hit its iteration cap before completion could be proven.",
            );
        }
        Ok(if completed_once {
            // A watch that met its goal and then ran out of iterations is not a
            // failure; saying "hit the cap" and nothing else would read as one.
            Outcome::Completed(format!(
                "watch reached the {}-iteration cap after meeting the goal",
                spec.max_iterations
            ))
        } else {
            Outcome::Stopped(format!("hit the {}-iteration cap", spec.max_iterations))
        })
    }
}

enum Outcome {
    Completed(String),
    Stopped(String),
}

/// `None` when the loop may finish; `Some(reason)` when DONE is refused.
///
/// `Standard` never blocks. `Aaa` defers entirely to the durable report's own
/// gate, so the loop and a model calling `loop_report_update` are held to one
/// standard rather than two that can disagree.
fn completion_blocker(state: &crate::AppState, spec: &LoopSpec, loop_id: &str) -> Option<String> {
    if spec.profile != LoopProfile::Aaa {
        return None;
    }
    match crate::loop_report::load(&state.projects_root, &spec.slug, loop_id) {
        Ok(report) => crate::loop_report::validate_completion_readiness(&report)
            .err()
            .map(|error| format!("{error:#}")),
        Err(error) => Some(format!(
            "the durable progress report is unavailable ({error:#}), so completion cannot be proven"
        )),
    }
}

/// DONE on a line of its own. A reply that merely contains the word — "I am
/// not done", "this will be done once…" — is not a verdict.
fn says_done(reply: &str) -> bool {
    reply
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("DONE"))
}

fn iteration_prompt(spec: &LoopSpec, loop_id: &str, iteration: usize) -> String {
    match spec.profile {
        LoopProfile::Standard => standard_prompt(&spec.goal, iteration),
        LoopProfile::Aaa => aaa_prompt(&spec.goal, loop_id, iteration),
    }
}

/// The user's words, untouched on the first pass.
fn standard_prompt(goal: &str, iteration: usize) -> String {
    if iteration == 1 {
        return goal.to_string();
    }
    format!(
        "{goal}\n\n(Continuing — this is iteration {iteration}. Pick up from where the last one \
         left off. When the goal is genuinely met, reply with exactly DONE on its own line and \
         nothing else; if it is not met, keep working rather than reporting progress.)"
    )
}

fn aaa_prompt(goal: &str, loop_id: &str, iteration: usize) -> String {
    let topology = "Use graph_plan + graph_run with three dependency-free specialist Build roots \
                    with distinct roles, a separate Integration Build depending on every root, and \
                    a terminal Judge depending on Integration.";
    let verification =
        "Play and verify in PIE. Persist at least three individual screenshots with \
                        editor_persist_capture(path), read editor_console_history for runtime \
                        errors, and call editor_analyze_motion for movement. Measure the frame \
                        budget with game_perf on the running game and record it as a Performance \
                        check with its numbers — reading fps.low1, not fps.mean. A run that never \
                        timed a frame cannot complete.";
    let reporting =
        "Call loop_report_start with a specific named quality reference, then append a \
                     structured loop_report_iteration with checks, changed files, durable evidence \
                     paths, scores, punch list, and nextIterationMemory.";
    if iteration == 1 {
        format!(
            "{goal}\n\nThis is /loop {loop_id}, iteration {iteration}. {topology} {verification} \
             {reporting} This is the initial pass: record it and continue to a second \
             verification/repair iteration even if its graph passes. Do not reply DONE yet."
        )
    } else {
        format!(
            "Continue /loop {loop_id}, iteration {iteration}, toward the goal: {goal}\n\nRead \
             loop_report_open first and use its nextIterationMemory plus punch list. {topology} \
             {verification} {reporting} When a fresh judge crosses threshold and every check \
             passes, call loop_report_update and reply with exactly DONE on its own line."
        )
    }
}

/// Append a minimal iteration when the model did not record one itself.
///
/// The model is asked to call `loop_report_iteration` with real checks and
/// evidence, and usually does. When it forgets, a report with a gap in it is
/// worse than a thin entry: the gap reads as "nothing happened" and the
/// completion gate counts iterations. This writes the honest minimum —
/// needs-work, with the reply as its summary — and never overwrites a proper
/// entry the model already made.
fn record_iteration(
    state: &crate::AppState,
    spec: &LoopSpec,
    loop_id: &str,
    turn: &Value,
    started_at_ms: u64,
    reply: &str,
) {
    if turn_recorded_iteration(turn) {
        return;
    }
    let summary = if reply.trim().is_empty() {
        "This iteration returned no summary.".to_string()
    } else {
        reply.chars().take(12_000).collect()
    };
    let input = crate::loop_report::IterationInput {
        started_at_ms,
        completed_at_ms: now_ms(),
        outcome: crate::loop_report::IterationOutcome::NeedsWork,
        summary,
        agents: Vec::new(),
        checks: Vec::new(),
        changed_files: Vec::new(),
        evidence: Vec::new(),
        scores: Vec::new(),
        punch_list: Vec::new(),
        next_iteration_memory: Default::default(),
    };
    if let Err(error) =
        crate::loop_report::append_iteration(&state.projects_root, &spec.slug, loop_id, input)
    {
        tracing::warn!(loop_id, %error, "fallback loop iteration could not be recorded");
    }
}

/// Did this turn already write its own iteration? Read off the tool calls the
/// turn reports, so a model that recorded properly is never double-counted.
fn turn_recorded_iteration(turn: &Value) -> bool {
    turn.get("toolCalls")
        .and_then(Value::as_array)
        .is_some_and(|calls| {
            calls.iter().any(|call| {
                call.get("name")
                    .or_else(|| call.get("function").and_then(|f| f.get("name")))
                    .and_then(Value::as_str)
                    == Some("loop_report_iteration")
            })
        })
}

/// Move the durable report to a terminal status. Best-effort by design: a
/// report that cannot be closed must not turn a finished loop into a failed
/// one, and the reason is already in the log.
fn close_report(
    state: &crate::AppState,
    spec: &LoopSpec,
    loop_id: &str,
    status: crate::loop_report::LoopStatus,
    summary: &str,
) {
    let update = crate::loop_report::LoopUpdate {
        status: Some(status),
        completed_at_ms: Some(now_ms()),
        summary: Some(summary.chars().take(12_000).collect()),
        ..Default::default()
    };
    if let Err(error) =
        crate::loop_report::update(&state.projects_root, &spec.slug, loop_id, update)
    {
        tracing::warn!(loop_id, %error, "loop report could not be closed");
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn radix36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("ascii digits")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(profile: LoopProfile) -> LoopSpec {
        LoopSpec {
            slug: "demo".into(),
            goal: "fix the typo in the README".into(),
            profile,
            interval_ms: None,
            session_id: None,
            workspace_root: None,
            permission_mode: "auto".into(),
            system: None,
            context_length: None,
            guardian_model: None,
            max_iterations: 10,
        }
    }

    use axum::response::sse::{Event, Sse};
    use axum::routing::post;
    use axum::Router;
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn sse_reply(content: &str) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let payload =
            json!({ "choices": [{ "delta": { "role": "assistant", "content": content } }] });
        Sse::new(futures::stream::iter(vec![
            Ok(Event::default().data(payload.to_string())),
            Ok(Event::default().data("[DONE]")),
        ]))
    }

    /// A provider that answers with `replies` in order, repeating the last one
    /// forever. Enough to script "work, work, DONE" without a real model.
    async fn scripted_state(replies: Vec<String>) -> (crate::AppState, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_route = calls.clone();
        let app = Router::new().route(
            "/v1/chat/completions",
            // The body is taken and dropped rather than ignored: a handler
            // that never reads it leaves bytes in the socket, and the next
            // keep-alive request on that connection dies with a broken pipe.
            post(move |_body: String| {
                let calls = calls_for_route.clone();
                let replies = replies.clone();
                async move {
                    let n = calls.fetch_add(1, Ordering::SeqCst);
                    let reply = replies
                        .get(n)
                        .cloned()
                        .unwrap_or_else(|| replies.last().cloned().unwrap_or_default());
                    sse_reply(&reply)
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let config = crate::config::AppConfig {
            model: crate::config::ModelConfig {
                default: "mock".into(),
                provider: "mock".into(),
                base_url: format!("http://{addr}/v1"),
                api_key_env: "CALI_MOCK_KEY".into(),
                temperature: 0.0,
                max_tokens: Some(128),
                roles: Default::default(),
            },
            skills: crate::config::SkillsConfig {
                disabled: Vec::new(),
                extra_dirs: Vec::new(),
            },
            ..Default::default()
        };
        let (bus, _) = tokio::sync::broadcast::channel(256);
        let state = crate::AppState {
            config: Arc::new(tokio::sync::RwLock::new(config)),
            projects_root: tempfile::tempdir().unwrap().keep(),
            sessions_root: tempfile::tempdir().unwrap().keep().join("sessions"),
            agents: crate::agent::AgentManager::new(bus.clone()),
            loops: Default::default(),
            bus: bus.clone(),
            workspaces: Arc::new(tokio::sync::RwLock::new(crate::workspace::Registry::new())),
            dev_servers: Arc::new(tokio::sync::RwLock::new(crate::devserver::Servers::new())),
            terminals: crate::terminal::Terminals::default(),
            browsers: crate::browser::Browsers::new(),
            shutdown: Arc::new(tokio::sync::watch::channel(false).0),
            tools: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            editor_bridge: crate::editor_bridge::EditorBridge::new(bus.clone()),
            editor_attachment: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            graphs: crate::graph::GraphManager::new(),
            mcp: Arc::new(crate::mcp::McpManager::default()),
            asset_catalog: Arc::new(tokio::sync::RwLock::new(Vec::new())),
        };
        std::fs::create_dir_all(&state.sessions_root).unwrap();
        crate::store::create_project(&state.projects_root, "demo", "Demo").unwrap();
        (state, calls)
    }

    /// Poll until the run leaves `Running`, or fail rather than hang.
    async fn settle(state: &crate::AppState, loop_id: &str) -> LoopView {
        for _ in 0..200 {
            let view = state.loops.status(loop_id).await.unwrap();
            if view.status != RunStatus::Running {
                return view;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("loop {loop_id} never reached a terminal status");
    }

    #[tokio::test]
    async fn a_standard_loop_runs_until_the_model_says_done() {
        let (state, calls) =
            scripted_state(vec!["looked at the README".into(), "DONE".into()]).await;
        let view = state
            .loops
            .start(&state, spec(LoopProfile::Standard))
            .await
            .unwrap();
        let settled = settle(&state, &view.loop_id).await;
        assert_eq!(settled.status, RunStatus::Completed, "{settled:?}");
        assert_eq!(settled.iteration, 2);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_aaa_loop_refuses_done_it_cannot_prove() {
        // The model claims completion on every turn; with no passing report on
        // disk the gate must refuse every one and let the cap end the run.
        let (state, _) = scripted_state(vec!["DONE".into()]).await;
        let view = state
            .loops
            .start(
                &state,
                LoopSpec {
                    profile: LoopProfile::Aaa,
                    max_iterations: 3,
                    ..spec(LoopProfile::Aaa)
                },
            )
            .await
            .unwrap();
        let settled = settle(&state, &view.loop_id).await;
        assert_eq!(settled.status, RunStatus::Stopped, "{settled:?}");
        assert_eq!(
            settled.iteration, 3,
            "the gate should have refused all three"
        );
    }

    #[tokio::test]
    async fn a_loop_takes_a_restore_point_before_it_edits_anything() {
        // Unattended editing with no way back is the failure this prevents.
        let (state, _) = scripted_state(vec!["DONE".into()]).await;
        let view = state
            .loops
            .start(&state, spec(LoopProfile::Standard))
            .await
            .unwrap();
        settle(&state, &view.loop_id).await;
        let listed = crate::checkpoints::list(&state.projects_root, "demo").unwrap();
        let entries = listed
            .get("checkpoints")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        assert!(entries >= 1, "no restore point was taken: {listed}");
    }

    #[tokio::test]
    async fn a_failing_restore_point_does_not_stop_the_loop() {
        // A full disk is not a reason to abandon the work. The checkpoint is
        // best-effort and its failure belongs in the log, not in the run's
        // status — a loop that died because a snapshot failed would lose the
        // very work the snapshot was protecting.
        let (state, _) = scripted_state(vec!["DONE".into()]).await;
        let view = state
            .loops
            .start(
                &state,
                LoopSpec {
                    // No such project, so `checkpoints::create` cannot succeed.
                    slug: "ghost".into(),
                    ..spec(LoopProfile::Standard)
                },
            )
            .await
            .unwrap();
        let settled = settle(&state, &view.loop_id).await;
        assert_eq!(settled.status, RunStatus::Completed, "{settled:?}");
    }

    #[tokio::test]
    async fn an_aaa_loop_records_an_iteration_the_model_did_not() {
        // A report with a gap reads as "nothing happened", and the completion
        // gate counts iterations, so a forgotten write must not vanish.
        let (state, _) = scripted_state(vec!["worked on it".into()]).await;
        let view = state
            .loops
            .start(
                &state,
                LoopSpec {
                    profile: LoopProfile::Aaa,
                    max_iterations: 2,
                    ..spec(LoopProfile::Aaa)
                },
            )
            .await
            .unwrap();
        settle(&state, &view.loop_id).await;
        let report = crate::loop_report::load(&state.projects_root, "demo", &view.loop_id).unwrap();
        assert_eq!(report.iterations.len(), 2, "{report:?}");
        assert_ne!(
            report.status,
            crate::loop_report::LoopStatus::Running,
            "a capped loop must close its report"
        );
    }

    #[tokio::test]
    async fn a_standard_loop_writes_no_report_at_all() {
        // Paperwork nobody asked for and nothing reads.
        let (state, _) = scripted_state(vec!["DONE".into()]).await;
        let view = state
            .loops
            .start(&state, spec(LoopProfile::Standard))
            .await
            .unwrap();
        settle(&state, &view.loop_id).await;
        assert!(crate::loop_report::load(&state.projects_root, "demo", &view.loop_id).is_err());
    }

    #[tokio::test]
    async fn stop_ends_a_watch_between_iterations() {
        let (state, _) = scripted_state(vec!["tick".into()]).await;
        let view = state
            .loops
            .start(
                &state,
                LoopSpec {
                    interval_ms: Some(60_000),
                    ..spec(LoopProfile::Standard)
                },
            )
            .await
            .unwrap();
        // Let the first iteration get going, then stop it. Where the cancel
        // lands — mid-turn or in the interval sleep — depends on machine load,
        // and both are correct stops, so the assertion is on the contract
        // rather than on which sentence the driver chose.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        state.loops.stop(&view.loop_id).await.unwrap();
        let settled = settle(&state, &view.loop_id).await;
        assert_eq!(settled.status, RunStatus::Stopped, "{settled:?}");
        assert!(
            settled.detail.unwrap_or_default().contains("stopped"),
            "a stopped run should say why it ended"
        );
    }

    #[tokio::test]
    async fn a_run_is_listed_and_addressable_by_id_after_it_ends() {
        // The whole point of moving the driver here: the run outlives whoever
        // started it, so it has to still be findable.
        let (state, _) = scripted_state(vec!["DONE".into()]).await;
        let view = state
            .loops
            .start(&state, spec(LoopProfile::Standard))
            .await
            .unwrap();
        settle(&state, &view.loop_id).await;
        let listed = state.loops.list().await;
        assert!(
            listed.iter().any(|run| run.loop_id == view.loop_id),
            "{listed:?}"
        );
        assert!(state.loops.status(&view.loop_id).await.is_ok());
        assert!(state.loops.status("loop-nope").await.is_err());
    }

    #[test]
    fn a_standard_first_iteration_is_the_goal_verbatim() {
        // The defect this module was written to remove: the old driver
        // rewrote the goal into a mandated graph topology on every pass.
        let prompt = iteration_prompt(&spec(LoopProfile::Standard), "loop-1", 1);
        assert_eq!(prompt, "fix the typo in the README");
    }

    #[test]
    fn a_standard_continuation_adds_only_a_stop_condition() {
        let prompt = iteration_prompt(&spec(LoopProfile::Standard), "loop-1", 2);
        assert!(prompt.starts_with("fix the typo in the README"), "{prompt}");
        assert!(prompt.contains("iteration 2"));
        assert!(prompt.contains("DONE"));
        // Still no pipeline anywhere in it.
        for pipeline in ["graph_plan", "Judge", "editor_run_pie", "loop_report"] {
            assert!(!prompt.contains(pipeline), "{pipeline} leaked: {prompt}");
        }
    }

    #[test]
    fn the_aaa_profile_carries_the_pipeline_and_the_goal() {
        let prompt = iteration_prompt(&spec(LoopProfile::Aaa), "loop-9", 1);
        assert!(prompt.contains("fix the typo in the README"));
        assert!(prompt.contains("graph_plan"));
        assert!(prompt.contains("Judge"));
        assert!(prompt.contains("loop_report_start"));
        // The first pass may not finish: a one-iteration report cannot clear
        // the completion gate, so inviting DONE there only wastes a turn.
        assert!(prompt.contains("Do not reply DONE yet"));
    }

    #[test]
    fn profile_parsing_defaults_to_standard() {
        assert_eq!(LoopProfile::parse("aaa"), LoopProfile::Aaa);
        assert_eq!(LoopProfile::parse("AAA"), LoopProfile::Aaa);
        assert_eq!(LoopProfile::parse("standard"), LoopProfile::Standard);
        // An unknown profile must not silently opt into the expensive one.
        assert_eq!(LoopProfile::parse("deluxe"), LoopProfile::Standard);
        assert_eq!(LoopProfile::parse(""), LoopProfile::Standard);
    }

    #[test]
    fn done_is_a_line_not_a_word() {
        assert!(says_done("DONE"));
        assert!(says_done("all green\nDONE\n"));
        assert!(says_done("  done  "));
        // The cases that used to end loops early.
        assert!(!says_done("I am not done yet"));
        assert!(!says_done("this will be done once the tests pass"));
        assert!(!says_done(""));
    }

    #[test]
    fn loop_ids_are_unique_per_start_time() {
        assert_ne!(radix36(1), radix36(2));
        assert_eq!(radix36(0), "0");
        assert_eq!(radix36(35), "z");
        assert_eq!(radix36(36), "10");
    }
}
