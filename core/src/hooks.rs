//! Shell hooks: user-declared commands core runs at fixed points in a turn.
//!
//! The distinction from `guardian.rs` is the entire reason this module exists,
//! and the two are not alternatives. The guardian is **judgment** — a model
//! reads a pending call and forms an opinion, which costs a round trip and can
//! be wrong. A hook is **policy** — the user's own code, which always runs,
//! costs no tokens, and cannot be argued out of its answer by anything a model
//! writes. `PreToolUse` therefore runs *ahead* of the guardian and of the
//! permission rules: a deterministic decision the user wrote down should never
//! be re-litigated by a model, and a rule that can be waived by persuasion is
//! not a rule.
//!
//! **A hook may only ever add a block, never remove one.** There is no "allow"
//! verdict here, deliberately: the same one-way property the agent's own
//! `ask_user` escalation has. A hook that could approve would be a way for a
//! config edit to silently widen `supervised`, and the failure would be
//! invisible — nothing would appear on screen to notice.
//!
//! **Every failure proceeds.** A hook that times out, cannot be spawned, or
//! exits non-zero without the block contract is logged and ignored. This is the
//! opposite of the guardian's fail-closed rule, and for the opposite reason: an
//! unreachable guardian means a call was never reviewed, while a broken hook
//! means a *check* was never run over a call the ordinary gate is still about
//! to see. Failing closed here would let a typo in one command wedge the whole
//! session with nothing to click.
//!
//! **Global config only, for now.** Hooks are read from `~/.cali/config.yaml`
//! and nowhere else. Project-scoped hooks are the obviously useful next step
//! and are deliberately absent until they carry a first-use consent prompt
//! keyed on the command string: a hook is arbitrary code execution, and
//! checking out a repo must never silently acquire one. `approved_project_mcp`
//! in `config.rs` is the pattern to copy when that lands.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// How long one hook may run before it is killed and ignored.
const DEFAULT_TIMEOUT_MS: u64 = 5_000;

/// Ceiling on what a hook can put back into the turn, so a runaway script
/// cannot push a megabyte of stdout into the model's context.
const MAX_OUTPUT_BYTES: usize = 16 * 1024;

/// The exit code that means "block", matching Claude Code so a hook written
/// for one harness runs in the other. Any other non-zero code is a broken
/// hook, not a decision, and is ignored.
const BLOCK_EXIT_CODE: i32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct HooksConfig {
    /// Run before a tool call is gated. May block it.
    pub pre_tool_use: Vec<HookEntry>,
    /// Run after a tool call finishes. Stdout is appended to the result the
    /// model reads; it cannot block, because the work already happened.
    pub post_tool_use: Vec<HookEntry>,
    /// Run when a session's system prompt is built. Stdout is appended to it.
    pub session_start: Vec<HookEntry>,
    /// Run when the **top-level** agent is about to hand control back. May
    /// block, which feeds its reason in as the next user turn instead of
    /// returning. Subagents and graph nodes deliberately do not fire it — see
    /// [`stop`].
    pub stop: Vec<HookEntry>,
}

impl HooksConfig {
    pub fn is_empty(&self) -> bool {
        self.pre_tool_use.is_empty()
            && self.post_tool_use.is_empty()
            && self.session_start.is_empty()
            && self.stop.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HookEntry {
    /// Glob over the tool name, `*` for all. Uses the same matcher as the
    /// `permissions:` rules (`mcp::glob_match`) so one config file does not
    /// have two subtly different notions of a pattern.
    #[serde(default = "match_everything")]
    pub matcher: String,
    /// Passed to the shell, so a hook can be a pipeline without a wrapper.
    pub command: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn match_everything() -> String {
    "*".to_string()
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

/// What a `PreToolUse` hook decided.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Proceed,
    /// The reason is handed to the model as the refusal, so it is written for
    /// the model to act on rather than for a log.
    Block(String),
}

/// Run every `PreToolUse` hook whose matcher covers `tool`, in order, and stop
/// at the first block.
///
/// Ordering is the config's own: a user who wants a cheap check to short-
/// circuit an expensive one writes it first, and nothing here reorders that.
pub async fn pre_tool_use(
    hooks: &HooksConfig,
    session_id: &str,
    tool: &str,
    arguments: &Value,
    cwd: Option<&str>,
) -> Decision {
    for entry in &hooks.pre_tool_use {
        if !crate::mcp::glob_match(&entry.matcher, tool) {
            continue;
        }
        let payload = json!({
            "hook_event_name": "PreToolUse",
            "session_id": session_id,
            "cwd": cwd,
            "tool_name": tool,
            "tool_input": arguments,
        });
        match run(entry, &payload, cwd).await {
            Outcome::Blocked(reason) => {
                tracing::info!(tool, command = %entry.command, "PreToolUse hook blocked a call");
                return Decision::Block(reason);
            }
            Outcome::Output(_) | Outcome::Nothing => {}
        }
    }
    Decision::Proceed
}

/// Concatenated stdout of every `PostToolUse` hook whose matcher covers
/// `tool`, for appending to the result the model reads.
///
/// This is where a post-write typecheck belongs: the tool has run, and what a
/// hook has to say about it is information the model needs *in the same turn*,
/// not an approval question. There is deliberately no block verdict — the work
/// already happened, so refusing it here would only lie to the model about
/// what the state of the disk is. A hook that exits 2 has its stderr appended
/// like any other output, because a typecheck that fails is exactly the case
/// worth telling the model about.
pub async fn post_tool_use(
    hooks: &HooksConfig,
    session_id: &str,
    tool: &str,
    arguments: &Value,
    result: &Value,
    cwd: Option<&str>,
) -> String {
    let mut out = String::new();
    for entry in &hooks.post_tool_use {
        if !crate::mcp::glob_match(&entry.matcher, tool) {
            continue;
        }
        let payload = json!({
            "hook_event_name": "PostToolUse",
            "session_id": session_id,
            "cwd": cwd,
            "tool_name": tool,
            "tool_input": arguments,
            "tool_response": result,
        });
        let text = match run(entry, &payload, cwd).await {
            Outcome::Output(text) | Outcome::Blocked(text) => text,
            Outcome::Nothing => continue,
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(text);
    }
    out
}

/// Run every `Stop` hook. `Some(reason)` means "do not stop" — the reason is
/// fed back as the next user turn.
///
/// This is the seam that lets a *loop* be a plugin rather than harness code:
/// a hook that re-injects the original prompt until some condition holds turns
/// one shell script into an autonomous loop, with nothing in core aware of it.
///
/// `stop_hook_active` tells a hook it is already inside such a re-entry, so it
/// can decline to block forever. That is a courtesy, not the guard: the turn
/// budget is, because every re-injection spends a turn and `max_turns` bounds
/// them. A hook that always blocks therefore ends the turn, not the process.
///
/// **Only the top-level agent fires this.** Subagents and graph nodes do not,
/// and that is not a simplification — it was measured. A hook written for the
/// main turn ("keep going until you say DONE") does not recognise a child's
/// reply, so it blocked every one: a single `subagent_spawn` turned into 199
/// extra model calls as the child was driven to its turn cap. One hook should
/// not be able to multiply the cost of a run by the number of children it
/// spawns. A separate `subagent_stop` event can be added when something
/// actually wants it.
pub async fn stop(
    hooks: &HooksConfig,
    session_id: &str,
    last_message: &str,
    stop_hook_active: bool,
    cwd: Option<&str>,
) -> Option<String> {
    for entry in &hooks.stop {
        let payload = json!({
            "hook_event_name": "Stop",
            "session_id": session_id,
            "cwd": cwd,
            "stop_hook_active": stop_hook_active,
            "last_message": last_message,
        });
        if let Outcome::Blocked(reason) = run(entry, &payload, cwd).await {
            tracing::info!(command = %entry.command, "Stop hook kept the turn going");
            return Some(reason);
        }
    }
    None
}

/// Concatenated stdout of every `SessionStart` hook, ready to append to the
/// system prompt. Empty when nothing is configured or nothing printed.
pub async fn session_start(hooks: &HooksConfig, cwd: Option<&str>) -> String {
    let mut out = String::new();
    for entry in &hooks.session_start {
        let payload = json!({
            "hook_event_name": "SessionStart",
            "cwd": cwd,
        });
        // A SessionStart hook has nothing to block — the turn it would block
        // has not started — so a block verdict is read as ordinary output.
        let text = match run(entry, &payload, cwd).await {
            Outcome::Output(text) => text,
            Outcome::Blocked(text) => text,
            Outcome::Nothing => continue,
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        out.push_str("\n\n");
        out.push_str(text);
    }
    out
}

enum Outcome {
    Blocked(String),
    Output(String),
    Nothing,
}

async fn run(entry: &HookEntry, payload: &Value, cwd: Option<&str>) -> Outcome {
    let mut command = tokio::process::Command::new("/bin/sh");
    command.arg("-c").arg(&entry.command);
    if let Some(dir) = cwd.filter(|dir| std::path::Path::new(dir).is_dir()) {
        command.current_dir(dir);
    }
    // Scrub the environment so CALI_*_API_KEY and friends never reach a hook.
    // Same list as `devserver::command`; a hook is a child process like any
    // other, and this is the file where forgetting that would be worst — the
    // command comes from a config file rather than from this repo.
    command.env_clear();
    for key in ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SHELL"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!(command = %entry.command, %error, "hook failed to spawn; proceeding");
            return Outcome::Nothing;
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        let body = payload.to_string();
        // A hook that never reads stdin leaves this write unread; that is not
        // an error and must not be reported as one.
        let _ = stdin.write_all(body.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }

    let timeout = Duration::from_millis(entry.timeout_ms.max(1));
    let finished = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            tracing::warn!(command = %entry.command, %error, "hook failed; proceeding");
            return Outcome::Nothing;
        }
        Err(_) => {
            // `wait_with_output` consumed the handle, so the child cannot be
            // killed by name here. `kill_on_drop` is what actually reaps it.
            tracing::warn!(command = %entry.command, timeout_ms = entry.timeout_ms, "hook timed out; proceeding");
            return Outcome::Nothing;
        }
    };

    let stdout = truncate(String::from_utf8_lossy(&finished.stdout).to_string());
    let stderr = truncate(String::from_utf8_lossy(&finished.stderr).to_string());

    // The JSON contract wins over the exit code when both are present, so a
    // hook can block with a reason while still exiting 0.
    if let Some(reason) = block_reason(&stdout) {
        return Outcome::Blocked(reason);
    }
    match finished.status.code() {
        Some(BLOCK_EXIT_CODE) => {
            let reason = if stderr.trim().is_empty() {
                format!("blocked by a PreToolUse hook: {}", entry.command)
            } else {
                stderr.trim().to_string()
            };
            Outcome::Blocked(reason)
        }
        Some(0) => {
            if stdout.trim().is_empty() {
                Outcome::Nothing
            } else {
                Outcome::Output(stdout)
            }
        }
        other => {
            tracing::warn!(
                command = %entry.command,
                code = ?other,
                stderr = %stderr.trim(),
                "hook exited non-zero without the block contract; proceeding"
            );
            Outcome::Nothing
        }
    }
}

/// `{"decision":"block","reason":"…"}` on stdout, or `None` for anything else.
///
/// Parsed leniently on purpose: a hook that prints a log line and *then* the
/// JSON is a normal thing to write, and refusing it would turn a working block
/// into a silent proceed — the one direction this module must never fail in.
fn block_reason(stdout: &str) -> Option<String> {
    let start = stdout.find('{')?;
    let value: Value = serde_json::from_str(stdout[start..].trim()).ok()?;
    if value.get("decision")?.as_str()? != "block" {
        return None;
    }
    let reason = value
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("blocked by a PreToolUse hook");
    Some(reason.to_string())
}

fn truncate(mut text: String) -> String {
    if text.len() > MAX_OUTPUT_BYTES {
        let mut end = MAX_OUTPUT_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n[truncated]");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(command: &str, matcher: &str) -> HookEntry {
        HookEntry {
            matcher: matcher.to_string(),
            command: command.to_string(),
            timeout_ms: 4_000,
        }
    }

    fn config(pre: Vec<HookEntry>) -> HooksConfig {
        HooksConfig {
            pre_tool_use: pre,
            ..Default::default()
        }
    }

    async fn gate(command: &str, matcher: &str, tool: &str) -> Decision {
        pre_tool_use(
            &config(vec![entry(command, matcher)]),
            "session-1",
            tool,
            &json!({"path": "main.js"}),
            None,
        )
        .await
    }

    #[tokio::test]
    async fn a_quiet_hook_lets_the_call_through() {
        assert_eq!(gate("true", "*", "file_write").await, Decision::Proceed);
    }

    #[tokio::test]
    async fn exit_two_blocks_and_stderr_becomes_the_reason() {
        let decision = gate("echo 'not that file' >&2; exit 2", "*", "file_write").await;
        assert_eq!(decision, Decision::Block("not that file".to_string()));
    }

    #[tokio::test]
    async fn the_json_contract_blocks_even_on_exit_zero() {
        let decision = gate(
            r#"echo '{"decision":"block","reason":"edit the config instead"}'"#,
            "*",
            "file_write",
        )
        .await;
        assert_eq!(
            decision,
            Decision::Block("edit the config instead".to_string())
        );
    }

    #[tokio::test]
    async fn a_log_line_before_the_json_still_blocks() {
        // Printing progress and then the verdict is normal; reading only a
        // pure-JSON stdout would turn this block into a silent proceed.
        let decision = gate(
            r#"echo "checking..."; echo '{"decision":"block","reason":"nope"}'"#,
            "*",
            "file_write",
        )
        .await;
        assert_eq!(decision, Decision::Block("nope".to_string()));
    }

    #[tokio::test]
    async fn the_matcher_decides_which_calls_a_hook_sees() {
        assert_eq!(
            gate("exit 2", "file_*", "file_write").await,
            Decision::Block("blocked by a PreToolUse hook: exit 2".to_string())
        );
        assert_eq!(
            gate("exit 2", "file_*", "memory_read").await,
            Decision::Proceed
        );
    }

    #[tokio::test]
    async fn the_tool_call_is_delivered_on_stdin() {
        // The arguments have to arrive, or a hook cannot tell a write to the
        // game's own main.js from one into the user's dotfiles — the exact
        // distinction a tool-name allowlist could not make.
        let sees_arguments =
            r#"payload=$(cat); case "$payload" in *'"path":"main.js"'*) exit 2;; esac"#;
        assert!(
            matches!(
                gate(sees_arguments, "*", "file_write").await,
                Decision::Block(_)
            ),
            "hook could not read tool_input from stdin"
        );

        let sees_tool_name =
            r#"payload=$(cat); case "$payload" in *'"tool_name":"file_write"'*) exit 2;; esac"#;
        assert!(
            matches!(
                gate(sees_tool_name, "*", "file_write").await,
                Decision::Block(_)
            ),
            "hook could not read tool_name from stdin"
        );
    }

    #[tokio::test]
    async fn a_broken_hook_proceeds_rather_than_wedging_the_session() {
        // Exit 1 is not the block contract — it is a bug in the hook.
        assert_eq!(gate("exit 1", "*", "file_write").await, Decision::Proceed);
        // Neither is a command that does not exist.
        assert_eq!(
            gate("definitely-not-a-real-command", "*", "file_write").await,
            Decision::Proceed
        );
    }

    #[tokio::test]
    async fn a_hanging_hook_times_out_and_proceeds() {
        let hook = HookEntry {
            matcher: "*".into(),
            command: "sleep 30".into(),
            timeout_ms: 300,
        };
        let started = std::time::Instant::now();
        let decision = pre_tool_use(&config(vec![hook]), "s", "file_write", &json!({}), None).await;
        assert_eq!(decision, Decision::Proceed);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "hook was not killed"
        );
    }

    #[tokio::test]
    async fn the_first_block_wins_and_later_hooks_do_not_run() {
        let marker = tempfile::tempdir().unwrap();
        let witness = marker.path().join("ran");
        let hooks = config(vec![
            entry("exit 2", "*"),
            entry(&format!("touch {}", witness.display()), "*"),
        ]);
        let decision = pre_tool_use(&hooks, "s", "file_write", &json!({}), None).await;
        assert!(matches!(decision, Decision::Block(_)));
        assert!(!witness.exists(), "a later hook ran after a block");
    }

    #[tokio::test]
    async fn secrets_never_reach_a_hook() {
        // The single most important property in this file: the command comes
        // from a config file, so an unscrubbed environment would hand every
        // provider key to whatever it names.
        let hooks = config(vec![entry(
            r#"if [ -n "$CALI_OPENAI_API_KEY" ]; then exit 2; fi"#,
            "*",
        )]);
        let restore = std::env::var_os("CALI_OPENAI_API_KEY");
        std::env::set_var("CALI_OPENAI_API_KEY", "sk-should-never-be-visible");
        let decision = pre_tool_use(&hooks, "s", "file_write", &json!({}), None).await;
        match restore {
            Some(value) => std::env::set_var("CALI_OPENAI_API_KEY", value),
            None => std::env::remove_var("CALI_OPENAI_API_KEY"),
        }
        assert_eq!(
            decision,
            Decision::Proceed,
            "the key was visible to the hook"
        );
    }

    #[tokio::test]
    async fn oversized_output_is_truncated_rather_than_flooding_the_turn() {
        let hooks = HooksConfig {
            session_start: vec![entry("head -c 100000 /dev/zero | tr '\\0' 'x'", "*")],
            ..Default::default()
        };
        let text = session_start(&hooks, None).await;
        assert!(text.len() < MAX_OUTPUT_BYTES + 100, "{} bytes", text.len());
        assert!(
            text.ends_with("[truncated]"),
            "{}",
            &text[text.len() - 40..]
        );
    }

    #[tokio::test]
    async fn session_start_output_is_collected_in_order() {
        let hooks = HooksConfig {
            session_start: vec![entry("echo first", "*"), entry("echo second", "*")],
            ..Default::default()
        };
        let text = session_start(&hooks, None).await;
        assert!(
            text.find("first").unwrap() < text.find("second").unwrap(),
            "{text}"
        );
    }

    #[tokio::test]
    async fn post_tool_use_reads_the_result_and_appends_its_own() {
        // The shape a post-write typecheck takes: read what the tool did, say
        // something about it, and have that reach the model this turn.
        let hooks = HooksConfig {
            post_tool_use: vec![entry(
                r#"payload=$(cat); case "$payload" in *'"written":true'*) echo "tsc: 1 error in main.js";; esac"#,
                "file_write",
            )],
            ..Default::default()
        };
        let appended = post_tool_use(
            &hooks,
            "s",
            "file_write",
            &json!({"path": "main.js"}),
            &json!({"written": true}),
            None,
        )
        .await;
        assert_eq!(appended, "tsc: 1 error in main.js");
    }

    #[tokio::test]
    async fn post_tool_use_cannot_block_only_report() {
        // Exit 2 is the block contract everywhere else; here the work has
        // already happened, so it is read as output rather than a refusal.
        let hooks = HooksConfig {
            post_tool_use: vec![entry("echo 'lint failed' >&2; exit 2", "*")],
            ..Default::default()
        };
        let appended = post_tool_use(&hooks, "s", "file_write", &json!({}), &json!({}), None).await;
        assert_eq!(appended, "lint failed");
    }

    #[tokio::test]
    async fn post_tool_use_ignores_tools_its_matcher_does_not_name() {
        let hooks = HooksConfig {
            post_tool_use: vec![entry("echo ran", "file_*")],
            ..Default::default()
        };
        assert_eq!(
            post_tool_use(&hooks, "s", "memory_read", &json!({}), &json!({}), None).await,
            ""
        );
    }

    #[tokio::test]
    async fn a_stop_hook_can_keep_the_turn_going() {
        // The ralph-loop shape: refuse to stop until the model says the magic
        // word, feeding the original prompt back each time.
        let hooks = HooksConfig {
            stop: vec![entry(
                r#"payload=$(cat); case "$payload" in *'"last_message":"DONE'*) exit 0;; esac; echo '{"decision":"block","reason":"keep going"}'"#,
                "*",
            )],
            ..Default::default()
        };
        assert_eq!(
            stop(&hooks, "s", "still working", false, None).await,
            Some("keep going".to_string())
        );
        // And it lets go when its condition holds.
        assert_eq!(stop(&hooks, "s", "DONE", false, None).await, None);
    }

    #[tokio::test]
    async fn a_stop_hook_is_told_when_it_is_inside_its_own_continuation() {
        // Without this a hook has no way to decline to block forever.
        let hooks = HooksConfig {
            stop: vec![entry(
                r#"payload=$(cat); case "$payload" in *'"stop_hook_active":true'*) exit 0;; esac; exit 2"#,
                "*",
            )],
            ..Default::default()
        };
        assert!(stop(&hooks, "s", "x", false, None).await.is_some());
        assert!(stop(&hooks, "s", "x", true, None).await.is_none());
    }

    #[tokio::test]
    async fn a_quiet_stop_hook_lets_the_turn_end() {
        let hooks = HooksConfig {
            stop: vec![entry("true", "*")],
            ..Default::default()
        };
        assert_eq!(stop(&hooks, "s", "done", false, None).await, None);
    }

    #[tokio::test]
    async fn no_hooks_configured_costs_nothing_and_proceeds() {
        let empty = HooksConfig::default();
        assert!(empty.is_empty());
        assert_eq!(
            pre_tool_use(&empty, "s", "file_write", &json!({}), None).await,
            Decision::Proceed
        );
        assert_eq!(session_start(&empty, None).await, "");
    }
}
