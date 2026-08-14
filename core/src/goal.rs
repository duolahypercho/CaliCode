//! Tool-less goal verifier behind the client's `/goal` command.
//!
//! After each turn the client hands core the objective plus a transcript
//! excerpt and gets back `{ met, reason }`. When `met` is false the reason is
//! phrased as the next directive, so the client can feed it straight back to
//! the worker.
//!
//! The evaluator is deliberately given no tools. It can only judge what the
//! worker's own output already demonstrates, which forces goals to be stated
//! as observable end states and stops the worker from grading its own homework
//! with fresh tool calls.
//!
//! Parsing fails *closed*: anything we cannot read as a verdict becomes
//! `met: false`. A verifier that fails open is worse than no verifier, because
//! it silently declares victory.

use crate::config::AppConfig;
use crate::model;
use crate::AppState;
use anyhow::Result;
use serde_json::{json, Value};

/// Server-side ceiling on the transcript excerpt, in characters. The client
/// truncates first; this exists so a client bug cannot blow the context of
/// what is meant to be a cheap per-turn check.
pub const MAX_TRANSCRIPT_CHARS: usize = 12_000;

const SYSTEM_PROMPT: &str = "You are a strict, sceptical verifier. You have no tools: you cannot run commands, read files, or inspect anything yourself. You judge exactly one question — does the transcript excerpt contain evidence that the stated goal has actually been achieved?

Rules:
- Reply with a single JSON object and nothing else: {\"met\": true, \"reason\": \"...\"} or {\"met\": false, \"reason\": \"...\"}. No prose, no code fences, no second object.
- Evidence means the transcript shows the observable end state the goal describes: command output, file contents, a test summary, an error that is demonstrably gone. A claim of success with nothing demonstrating it is not evidence — answer met: false.
- Partial progress is not achievement. If any part of the goal is unproven, answer met: false.
- When met is false, write reason as one sentence addressed to the worker as its next instruction, naming the missing evidence and the action that would produce it. Example: \"The tests were never run — run them and paste the output.\"
- When met is true, write reason as one sentence stating the evidence that satisfied you. Example: \"cargo test printed 'test result: ok. 555 passed' in the transcript.\"
- Never ask a question, never request permission, never explain yourself outside the JSON object.";

/// A read verdict. `reason` is always non-empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub met: bool,
    pub reason: String,
}

impl Verdict {
    fn to_json(&self) -> Value {
        json!({ "met": self.met, "reason": self.reason })
    }
}

/// The verdict returned when the model's reply cannot be read.
fn unreadable() -> Verdict {
    Verdict {
        met: false,
        reason: "The evaluator's reply could not be read as a verdict, so the goal is not confirmed — restate the goal as a concrete observable end state and try again.".into(),
    }
}

/// Load config the way the other model-backed RPCs do and ask once.
pub async fn evaluate(
    state: &AppState,
    goal: &str,
    transcript: &str,
    project_slug: Option<&str>,
) -> Result<Value> {
    let mut config = { state.config.read().await.clone() };
    // A per-turn verifier runs on every turn, so it follows the same `judge`
    // role routing the graph judge uses: operators who mapped a cheap model to
    // that role get it here too. Unmapped, this is a no-op.
    crate::config::apply_role_model(&mut config, &["judge".to_string()]);
    evaluate_with_config(&config, goal, transcript, project_slug).await
}

async fn evaluate_with_config(
    config: &AppConfig,
    goal: &str,
    transcript: &str,
    project_slug: Option<&str>,
) -> Result<Value> {
    let goal = goal.trim();
    if goal.is_empty() {
        anyhow::bail!("goal must not be empty");
    }
    let messages = vec![
        json!({ "role": "system", "content": SYSTEM_PROMPT }),
        json!({ "role": "user", "content": build_prompt(goal, transcript, project_slug) }),
    ];
    // `None` for tools is the whole design: the evaluator physically cannot
    // call one, so it can only judge evidence already in the transcript.
    let result =
        model::chat_with_effort_session_once(config, &messages, None, None, None, None).await?;
    Ok(read_verdict(&result.content).to_json())
}

/// Keep the tail of an over-long excerpt: the most recent activity is the
/// evidence a verdict turns on. Returns the kept slice and whether anything
/// was dropped. Shared with `advisor.rs`, which caps the same excerpt for the
/// same reason.
pub fn clamp_transcript(transcript: &str) -> (&str, bool) {
    let total = transcript.chars().count();
    if total <= MAX_TRANSCRIPT_CHARS {
        return (transcript, false);
    }
    let start = transcript
        .char_indices()
        .nth(total - MAX_TRANSCRIPT_CHARS)
        .map(|(index, _)| index)
        .unwrap_or(0);
    (&transcript[start..], true)
}

fn build_prompt(goal: &str, transcript: &str, project_slug: Option<&str>) -> String {
    let (excerpt, truncated) = clamp_transcript(transcript);
    let mut prompt = String::new();
    if let Some(slug) = project_slug.map(str::trim).filter(|slug| !slug.is_empty()) {
        prompt.push_str("PROJECT: ");
        prompt.push_str(slug);
        prompt.push_str("\n\n");
    }
    prompt.push_str("GOAL:\n");
    prompt.push_str(goal);
    prompt.push_str("\n\nTRANSCRIPT EXCERPT (oldest first, most recent last):\n");
    if truncated {
        prompt.push_str("[earlier transcript omitted]\n");
    }
    if excerpt.trim().is_empty() {
        prompt.push_str("(the excerpt is empty — nothing has been demonstrated yet)");
    } else {
        prompt.push_str(excerpt);
    }
    prompt.push_str("\n\nAnswer with the JSON object only.");
    prompt
}

/// Read a verdict out of a model reply, falling back to `met: false`.
pub fn read_verdict(reply: &str) -> Verdict {
    parse_verdict(reply).unwrap_or_else(unreadable)
}

/// Scan for the first balanced `{...}` block that carries a readable `met`.
///
/// Models wrap the answer in prose or fences, and a chatty one quotes an
/// unrelated object first, so a merely-valid object is not enough — the block
/// must actually look like a verdict.
fn parse_verdict(reply: &str) -> Option<Verdict> {
    for candidate in json_objects(reply) {
        let Some(met) = candidate.get("met").and_then(coerce_bool) else {
            continue;
        };
        let reason = candidate
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if met {
                    "The evaluator reported the goal met but gave no reason.".into()
                } else {
                    "The evaluator reported the goal not met but gave no reason — restate the goal as a concrete observable end state.".into()
                }
            });
        return Some(Verdict { met, reason });
    }
    None
}

/// `true`/`"true"`/`"yes"`/`1` and their negatives. Anything else is
/// unreadable rather than a guess, and an unreadable field never becomes met.
fn coerce_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "y" => Some(true),
            "false" | "no" | "n" => Some(false),
            _ => None,
        },
        Value::Number(number) => match number.as_i64() {
            Some(1) => Some(true),
            Some(0) => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// Every balanced, parseable `{...}` block in `text`, in order. Brace matching
/// is string-aware so `{"reason": "expected }"}` stays intact.
fn json_objects(text: &str) -> Vec<Value> {
    let mut found = Vec::new();
    for (start, _) in text.char_indices().filter(|(_, ch)| *ch == '{') {
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
                        if let Ok(value) = serde_json::from_str::<Value>(candidate) {
                            found.push(value);
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::sse::{Event, Sse};
    use axum::routing::post;
    use axum::Router;
    use std::convert::Infallible;
    use std::sync::Arc;
    use std::sync::Mutex;

    #[test]
    fn clean_json_parses_both_ways() {
        let met = read_verdict(r#"{"met": true, "reason": "cargo test printed 555 passed."}"#);
        assert!(met.met);
        assert_eq!(met.reason, "cargo test printed 555 passed.");

        let unmet = read_verdict(r#"{"met": false, "reason": "Run the tests and paste output."}"#);
        assert!(!unmet.met);
        assert_eq!(unmet.reason, "Run the tests and paste output.");
    }

    #[test]
    fn fenced_json_parses() {
        let verdict = read_verdict("```json\n{\"met\": false, \"reason\": \"The file was never created — create it.\"}\n```");
        assert!(!verdict.met);
        assert_eq!(verdict.reason, "The file was never created — create it.");
    }

    #[test]
    fn prose_wrapped_json_parses() {
        let verdict = read_verdict(
            "Looking at the evidence carefully:\n{\"met\": true, \"reason\": \"The transcript shows exit status 0.\"}\nThat is my verdict.",
        );
        assert!(verdict.met);
        assert_eq!(verdict.reason, "The transcript shows exit status 0.");
    }

    #[test]
    fn leading_unrelated_object_is_skipped() {
        let verdict = read_verdict(
            r#"The worker ran {"tool": "bash", "ok": true} and then {"met": false, "reason": "No test output was shown — run the suite."}"#,
        );
        assert!(!verdict.met);
        assert_eq!(verdict.reason, "No test output was shown — run the suite.");
    }

    #[test]
    fn stringy_and_numeric_booleans_are_tolerated() {
        assert!(read_verdict(r#"{"met": "true", "reason": "it built."}"#).met);
        assert!(!read_verdict(r#"{"met": "False", "reason": "not yet."}"#).met);
        assert!(read_verdict(r#"{"met": 1, "reason": "it built."}"#).met);
        assert!(!read_verdict(r#"{"met": 0, "reason": "not yet."}"#).met);
    }

    #[test]
    fn braces_inside_the_reason_do_not_break_matching() {
        let verdict = read_verdict(
            r#"{"met": false, "reason": "The literal {\"ok\": 1} was never printed."}"#,
        );
        assert!(!verdict.met);
        assert!(verdict.reason.contains("{\"ok\": 1}"));
    }

    #[test]
    fn unparseable_output_is_never_met() {
        for reply in [
            "",
            "Yes, the goal is definitely achieved.",
            "{ broken",
            r#"{"verdict": "pass"}"#,
            r#"{"met": "probably", "reason": "hard to say"}"#,
            r#"{"met": null, "reason": "hard to say"}"#,
        ] {
            let verdict = read_verdict(reply);
            assert!(!verdict.met, "must not fail open on {reply:?}");
            assert!(!verdict.reason.is_empty());
        }
    }

    #[test]
    fn a_verdict_without_a_reason_still_carries_one() {
        let verdict = read_verdict(r#"{"met": false}"#);
        assert!(!verdict.met);
        assert!(!verdict.reason.is_empty());
    }

    /// Longest run of `filler` in `text`. The prompt scaffolding contains
    /// ordinary letters, so counting every occurrence would measure the
    /// wrapper too; the run length measures only the excerpt.
    fn longest_run(text: &str, filler: char) -> usize {
        text.split(|ch| ch != filler)
            .map(str::len)
            .max()
            .unwrap_or(0)
    }

    #[test]
    fn over_long_transcripts_are_truncated_to_the_tail() {
        let transcript = format!("{}TAIL-EVIDENCE", "x".repeat(MAX_TRANSCRIPT_CHARS * 2));
        let prompt = build_prompt("ship it", &transcript, None);

        assert!(prompt.contains("TAIL-EVIDENCE"));
        assert!(prompt.contains("[earlier transcript omitted]"));
        let kept = longest_run(&prompt, 'x');
        assert!(
            kept < MAX_TRANSCRIPT_CHARS,
            "kept {kept} transcript chars, cap is {MAX_TRANSCRIPT_CHARS}"
        );
    }

    #[test]
    fn short_transcripts_are_passed_through_whole() {
        let prompt = build_prompt("ship it", "ran cargo test: ok", Some("demo"));
        assert!(prompt.contains("PROJECT: demo"));
        assert!(prompt.contains("GOAL:\nship it"));
        assert!(prompt.contains("ran cargo test: ok"));
        assert!(!prompt.contains("[earlier transcript omitted]"));
    }

    #[test]
    fn truncation_never_splits_a_multibyte_character() {
        let transcript = "é".repeat(MAX_TRANSCRIPT_CHARS + 500);
        let (kept, truncated) = clamp_transcript(&transcript);
        assert!(truncated);
        assert_eq!(kept.chars().count(), MAX_TRANSCRIPT_CHARS);
    }

    #[test]
    fn an_empty_excerpt_is_described_rather_than_left_blank() {
        let prompt = build_prompt("ship it", "   ", None);
        assert!(prompt.contains("nothing has been demonstrated yet"));
    }

    // ---- provider round-trip (stub model over HTTP, like agent.rs tests) ----

    fn sse_reply(content: &str) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let payload =
            json!({ "choices": [{ "delta": { "role": "assistant", "content": content } }] });
        Sse::new(futures::stream::iter(vec![
            Ok(Event::default().data(payload.to_string())),
            Ok(Event::default().data("[DONE]")),
        ]))
    }

    async fn mock_provider(
        axum::extract::State(mock): axum::extract::State<MockState>,
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        mock.requests.lock().unwrap().push(body);
        sse_reply(&mock.reply)
    }

    #[derive(Clone)]
    struct MockState {
        reply: String,
        requests: Arc<Mutex<Vec<Value>>>,
    }

    async fn mock_config(reply: &str) -> (AppConfig, Arc<Mutex<Vec<Value>>>) {
        let mock = MockState {
            reply: reply.to_string(),
            requests: Arc::new(Mutex::new(Vec::new())),
        };
        let requests = mock.requests.clone();
        let app = Router::new()
            .route("/v1/chat/completions", post(mock_provider))
            .with_state(mock);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let config = AppConfig {
            model: crate::config::ModelConfig {
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
        (config, requests)
    }

    #[tokio::test]
    async fn the_evaluator_is_offered_no_tools() {
        let (config, requests) = mock_config(r#"{"met": true, "reason": "tests passed."}"#).await;

        let result = evaluate_with_config(&config, "tests pass", "test result: ok", None)
            .await
            .unwrap();

        assert_eq!(result, json!({ "met": true, "reason": "tests passed." }));
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1, "a verdict costs exactly one call");
        assert!(
            requests[0].get("tools").is_none(),
            "the verifier must never be handed a tool schema: {}",
            requests[0]
        );
    }

    #[tokio::test]
    async fn the_transcript_is_capped_before_it_reaches_the_provider() {
        let (config, requests) = mock_config(r#"{"met": false, "reason": "run it."}"#).await;
        let transcript = "y".repeat(MAX_TRANSCRIPT_CHARS * 3);

        evaluate_with_config(&config, "ship it", &transcript, None)
            .await
            .unwrap();

        let requests = requests.lock().unwrap();
        let sent = requests[0]["messages"][1]["content"].as_str().unwrap();
        assert_eq!(longest_run(sent, 'y'), MAX_TRANSCRIPT_CHARS);
    }

    #[tokio::test]
    async fn an_unreadable_reply_reports_not_met() {
        let (config, _) = mock_config("Sure, that looks done to me!").await;

        let result = evaluate_with_config(&config, "ship it", "I finished it", None)
            .await
            .unwrap();

        assert_eq!(result["met"], json!(false));
        assert!(result["reason"]
            .as_str()
            .unwrap()
            .contains("could not be read"));
    }

    #[tokio::test]
    async fn an_empty_goal_is_rejected_before_any_provider_call() {
        let (config, requests) = mock_config(r#"{"met": true, "reason": "sure."}"#).await;

        let error = evaluate_with_config(&config, "   ", "anything", None)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("goal must not be empty"));
        assert!(requests.lock().unwrap().is_empty());
    }
}
