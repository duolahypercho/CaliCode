//! Context compaction pipeline (harness-gaps plan item 6, module half).
//!
//! Pure, testable functions over OpenAI-chat-shaped `serde_json::Value`
//! messages. The pipeline runs in four phases:
//!
//! 1. [`prune_old_tool_results`] — cheap first measure: truncate stale
//!    tool-role contents outside the protected tail.
//! 2. [`select_boundaries`] — pick a protected head (first 3 messages) and a
//!    token-budgeted tail (20% of the compaction threshold, at least one user
//!    message, tool-call/tool-result pairs never split).
//! 3. [`build_summary_request`] — produce the messages for a single model
//!    call that yields a structured summary (Goal / Constraints / Progress /
//!    Decisions / Files touched / Next steps). The model call itself is the
//!    caller's job.
//! 4. [`apply`] — assemble `[head, summary-as-assistant-message, tail]` and
//!    sanitize any tool pairs orphaned by the cut.
//!
//! [`estimate_tokens`] provides a chars/4 heuristic for use whenever real
//! usage totals are absent.

use serde_json::{json, Value};
use std::collections::HashSet;

/// Tool-role contents longer than this (in chars) are truncated by
/// [`prune_old_tool_results`] when they sit outside the protected tail.
pub const PRUNE_MAX_TOOL_RESULT_CHARS: usize = 200;

/// The first N messages of a session are always preserved verbatim.
pub const PROTECTED_HEAD_MESSAGES: usize = 3;

/// The protected tail targets this fraction of the compaction threshold.
pub const TAIL_TARGET_RATIO: f64 = 0.20;

/// Flat per-message token overhead added by the estimator (role, framing).
const PER_MESSAGE_OVERHEAD_TOKENS: usize = 4;

/// Cap (in chars) on each rendered message inside the summary request, so the
/// summarization call itself stays bounded.
const SUMMARY_TRANSCRIPT_MESSAGE_CAP: usize = 1500;

/// Marker prefixed to the summary assistant message produced by [`apply`].
pub const SUMMARY_MARKER: &str = "[Conversation summary — earlier messages were compacted]";

/// Region split of a message list: `head` is `[0, head_end)`, the compactable
/// `middle` is `[head_end, tail_start)`, and the protected `tail` is
/// `[tail_start, len)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Boundaries {
    pub head_end: usize,
    pub tail_start: usize,
}

/// Extract the plain text of a message's `content` field. Handles both the
/// string form and the array-of-parts form (`[{"type":"text","text":...}]`).
fn content_text(message: &Value) -> String {
    match &message["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// chars/4 heuristic for a single message, counting content plus any
/// tool-call names and arguments, with a flat per-message overhead.
pub fn estimate_message_tokens(message: &Value) -> usize {
    let mut chars = content_text(message).chars().count();
    if let Some(calls) = message["tool_calls"].as_array() {
        for call in calls {
            if let Some(name) = call["function"]["name"].as_str() {
                chars += name.chars().count();
            }
            chars += match &call["function"]["arguments"] {
                Value::String(s) => s.chars().count(),
                Value::Null => 0,
                other => other.to_string().chars().count(),
            };
        }
    }
    chars.div_ceil(4) + PER_MESSAGE_OVERHEAD_TOKENS
}

/// chars/4 heuristic over a whole message list. Used when real usage totals
/// (from the provider's `usage` field) are not available.
pub fn estimate_tokens(messages: &[Value]) -> usize {
    messages.iter().map(estimate_message_tokens).sum()
}

/// Phase 1: truncate tool-role contents longer than
/// [`PRUNE_MAX_TOOL_RESULT_CHARS`] for every message before
/// `protected_tail_start` (messages at or past that index are left intact).
/// Returns how many messages were pruned.
pub fn prune_old_tool_results(messages: &mut [Value], protected_tail_start: usize) -> usize {
    let mut pruned = 0;
    let end = protected_tail_start.min(messages.len());
    for message in &mut messages[..end] {
        if message["role"] != "tool" {
            continue;
        }
        let Some(content) = message["content"].as_str() else {
            continue;
        };
        let total = content.chars().count();
        if total <= PRUNE_MAX_TOOL_RESULT_CHARS {
            continue;
        }
        let kept: String = content.chars().take(PRUNE_MAX_TOOL_RESULT_CHARS).collect();
        message["content"] = json!(format!(
            "{kept}\n… [tool result pruned: {total} chars total]"
        ));
        pruned += 1;
    }
    pruned
}

/// Phase 2: choose compaction boundaries.
///
/// * The first [`PROTECTED_HEAD_MESSAGES`] messages are always kept.
/// * The tail is grown backwards from the end under a token budget of
///   [`TAIL_TARGET_RATIO`] × `threshold_tokens` (per [`estimate_message_tokens`]).
/// * The tail always contains at least one user message, even over budget.
/// * A tail boundary never splits an assistant tool-call message from its
///   tool-result messages: if the cut lands on a tool result, the boundary is
///   walked back to include the assistant message that issued the calls.
///
/// Returns `None` when there is nothing to compact: the conversation is no
/// longer than the head, everything fits inside the tail budget, or no user
/// message exists past the head.
pub fn select_boundaries(messages: &[Value], threshold_tokens: usize) -> Option<Boundaries> {
    let len = messages.len();
    let head_end = PROTECTED_HEAD_MESSAGES.min(len);
    if len <= head_end {
        return None;
    }
    let budget = (threshold_tokens as f64 * TAIL_TARGET_RATIO) as usize;

    let mut tail_start = len;
    let mut acc = 0usize;
    let mut has_user = false;
    while tail_start > head_end {
        let candidate = &messages[tail_start - 1];
        let cost = estimate_message_tokens(candidate);
        if has_user && acc + cost > budget {
            break;
        }
        tail_start -= 1;
        acc += cost;
        if candidate["role"] == "user" {
            has_user = true;
        }
    }

    // Never split a tool-call/tool-result pair: a tail that starts on a tool
    // result is extended back through the whole result block to the assistant
    // message that issued the calls.
    while tail_start > head_end && messages[tail_start]["role"] == "tool" {
        tail_start -= 1;
    }

    if tail_start <= head_end {
        return None;
    }
    Some(Boundaries {
        head_end,
        tail_start,
    })
}

/// Render one message as a transcript line for the summary request.
fn render_for_summary(message: &Value) -> String {
    let role = message["role"].as_str().unwrap_or("unknown");
    let mut text = content_text(message);
    if text.chars().count() > SUMMARY_TRANSCRIPT_MESSAGE_CAP {
        text = text
            .chars()
            .take(SUMMARY_TRANSCRIPT_MESSAGE_CAP)
            .collect::<String>()
            + "…";
    }
    let mut line = if role == "tool" {
        let id = message["tool_call_id"].as_str().unwrap_or("?");
        format!("[tool result {id}] {text}")
    } else {
        format!("[{role}] {text}")
    };
    if let Some(calls) = message["tool_calls"].as_array() {
        for call in calls {
            let name = call["function"]["name"].as_str().unwrap_or("?");
            let args = match &call["function"]["arguments"] {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            };
            let args: String = args.chars().take(SUMMARY_TRANSCRIPT_MESSAGE_CAP).collect();
            line.push_str(&format!("\n[tool call {name}] {args}"));
        }
    }
    line
}

/// Phase 3: build the messages for one model call that produces the
/// structured summary. Everything before the protected tail (head + middle)
/// is rendered into the request; the tail is excluded because it survives
/// verbatim. The caller performs the model call and feeds the resulting text
/// to [`apply`].
pub fn build_summary_request(messages: &[Value], boundaries: &Boundaries) -> Vec<Value> {
    let transcript = messages[..boundaries.tail_start]
        .iter()
        .map(render_for_summary)
        .collect::<Vec<_>>()
        .join("\n\n");
    vec![
        json!({
            "role": "system",
            "content": "You are the context summarizer for a coding agent. Summarize the \
                        conversation the user provides into a structured handoff that lets the \
                        agent continue seamlessly. Respond with exactly these markdown sections, \
                        each with concise bullet points:\n\
                        ## Goal\n## Constraints\n## Progress\n## Decisions\n## Files touched\n## Next steps\n\
                        Be specific: preserve file paths, tool names, error messages, chosen \
                        approaches, and open questions. Do not invent details."
        }),
        json!({
            "role": "user",
            "content": format!("Summarize this conversation:\n\n{transcript}")
        }),
    ]
}

/// Drop tool-result messages whose issuing assistant tool-call message is
/// gone, and strip assistant tool calls whose results are gone. An assistant
/// message left with neither content nor tool calls is dropped entirely.
pub fn sanitize_tool_pairs(messages: Vec<Value>) -> Vec<Value> {
    // Pass 1: drop orphaned tool results. A tool message is kept only when
    // its `tool_call_id` was issued by the immediately preceding assistant
    // tool-call message (allowing sibling tool results in between).
    let mut kept: Vec<Value> = Vec::with_capacity(messages.len());
    let mut open: HashSet<String> = HashSet::new();
    for message in messages {
        if message["role"] == "tool" {
            let id = message["tool_call_id"].as_str().unwrap_or("");
            if open.remove(id) {
                kept.push(message);
            }
            continue;
        }
        open.clear();
        if message["role"] == "assistant" {
            if let Some(calls) = message["tool_calls"].as_array() {
                for call in calls {
                    if let Some(id) = call["id"].as_str() {
                        open.insert(id.to_string());
                    }
                }
            }
        }
        kept.push(message);
    }

    // Pass 2: strip assistant tool calls that no longer have a result in the
    // immediately following tool block.
    let mut out: Vec<Value> = Vec::with_capacity(kept.len());
    for i in 0..kept.len() {
        let message = &kept[i];
        if message["role"] != "assistant" || !message["tool_calls"].is_array() {
            out.push(message.clone());
            continue;
        }
        let mut answered: HashSet<&str> = HashSet::new();
        for follower in &kept[i + 1..] {
            if follower["role"] != "tool" {
                break;
            }
            if let Some(id) = follower["tool_call_id"].as_str() {
                answered.insert(id);
            }
        }
        let mut message = message.clone();
        let calls: Vec<Value> = message["tool_calls"]
            .as_array()
            .expect("checked above")
            .iter()
            .filter(|c| c["id"].as_str().is_some_and(|id| answered.contains(id)))
            .cloned()
            .collect();
        if calls.is_empty() {
            message
                .as_object_mut()
                .expect("messages are objects")
                .remove("tool_calls");
            let has_content = !content_text(&message).trim().is_empty();
            if has_content {
                out.push(message);
            }
        } else {
            message["tool_calls"] = Value::Array(calls);
            out.push(message);
        }
    }
    out
}

/// Phase 4: assemble the compacted message list —
/// `[head, summary-as-assistant-message, tail]` — then sanitize tool pairs
/// orphaned by the cut. `summary` is the text returned by the model call the
/// caller made with [`build_summary_request`].
pub fn apply(messages: &[Value], boundaries: &Boundaries, summary: &str) -> Vec<Value> {
    let mut out: Vec<Value> =
        Vec::with_capacity(boundaries.head_end + 1 + (messages.len() - boundaries.tail_start));
    out.extend(messages[..boundaries.head_end].iter().cloned());
    out.push(json!({
        "role": "assistant",
        "content": format!("{SUMMARY_MARKER}\n\n{}", summary.trim())
    }));
    out.extend(messages[boundaries.tail_start..].iter().cloned());
    sanitize_tool_pairs(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system(text: &str) -> Value {
        json!({ "role": "system", "content": text })
    }

    fn user(text: &str) -> Value {
        json!({ "role": "user", "content": text })
    }

    fn assistant(text: &str) -> Value {
        json!({ "role": "assistant", "content": text })
    }

    fn assistant_calls(content: &str, calls: &[(&str, &str)]) -> Value {
        let tool_calls: Vec<Value> = calls
            .iter()
            .map(|(id, name)| {
                json!({
                    "id": id,
                    "type": "function",
                    "function": { "name": name, "arguments": "{}" }
                })
            })
            .collect();
        json!({ "role": "assistant", "content": content, "tool_calls": tool_calls })
    }

    fn tool(id: &str, content: &str) -> Value {
        json!({ "role": "tool", "tool_call_id": id, "content": content })
    }

    /// Every tool message must be answered by the closest preceding assistant
    /// tool-call message, and every assistant tool call must have a result.
    fn assert_pairs_aligned(messages: &[Value]) {
        let sanitized = sanitize_tool_pairs(messages.to_vec());
        assert_eq!(
            messages,
            &sanitized[..],
            "message list contains orphaned tool pairs"
        );
    }

    // ---- estimate_tokens -------------------------------------------------

    #[test]
    fn estimate_counts_content_chars_over_four() {
        // 8 chars -> 2 tokens + overhead.
        let msg = user("abcdefgh");
        assert_eq!(
            estimate_message_tokens(&msg),
            2 + PER_MESSAGE_OVERHEAD_TOKENS
        );
    }

    #[test]
    fn estimate_rounds_up_partial_chunks() {
        // 5 chars -> ceil(5/4) = 2 tokens + overhead.
        let msg = user("abcde");
        assert_eq!(
            estimate_message_tokens(&msg),
            2 + PER_MESSAGE_OVERHEAD_TOKENS
        );
    }

    #[test]
    fn estimate_counts_tool_call_names_and_arguments() {
        let plain = assistant("");
        let with_call = assistant_calls("", &[("call-1", "file_write")]);
        // "file_write" (10) + "{}" (2) = 12 chars = 3 extra tokens.
        assert_eq!(
            estimate_message_tokens(&with_call),
            estimate_message_tokens(&plain) + 3
        );
    }

    #[test]
    fn estimate_handles_array_content_parts() {
        let msg = json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "abcd" },
                { "type": "text", "text": "efgh" }
            ]
        });
        assert_eq!(
            estimate_message_tokens(&msg),
            2 + PER_MESSAGE_OVERHEAD_TOKENS
        );
    }

    #[test]
    fn estimate_sums_over_all_messages() {
        let messages = vec![user("abcd"), assistant("efgh")];
        assert_eq!(
            estimate_tokens(&messages),
            estimate_message_tokens(&messages[0]) + estimate_message_tokens(&messages[1])
        );
    }

    // ---- prune_old_tool_results ------------------------------------------

    #[test]
    fn prune_truncates_long_tool_results_before_tail() {
        let long = "x".repeat(500);
        let mut messages = vec![
            user("go"),
            assistant_calls("", &[("c1", "file_grep")]),
            tool("c1", &long),
            user("thanks"),
        ];
        let pruned = prune_old_tool_results(&mut messages, 3);
        assert_eq!(pruned, 1);
        let content = messages[2]["content"].as_str().unwrap();
        assert!(content.starts_with(&"x".repeat(PRUNE_MAX_TOOL_RESULT_CHARS)));
        assert!(content.contains("pruned: 500 chars total"));
        assert!(content.chars().count() < 300);
    }

    #[test]
    fn prune_leaves_protected_tail_untouched() {
        let long = "y".repeat(500);
        let mut messages = vec![
            user("go"),
            assistant_calls("", &[("c1", "file_grep")]),
            tool("c1", &long),
        ];
        let pruned = prune_old_tool_results(&mut messages, 1);
        assert_eq!(pruned, 0);
        assert_eq!(messages[2]["content"].as_str().unwrap(), long);
    }

    #[test]
    fn prune_leaves_short_results_and_other_roles_untouched() {
        let exactly = "z".repeat(PRUNE_MAX_TOOL_RESULT_CHARS);
        let long_user = "u".repeat(500);
        let mut messages = vec![
            user(&long_user),
            assistant_calls("", &[("c1", "file_grep")]),
            tool("c1", &exactly),
            user("end"),
        ];
        let len = messages.len();
        let pruned = prune_old_tool_results(&mut messages, len);
        assert_eq!(pruned, 0);
        assert_eq!(messages[0]["content"].as_str().unwrap(), long_user);
        assert_eq!(messages[2]["content"].as_str().unwrap(), exactly);
    }

    #[test]
    fn prune_handles_tail_start_past_end() {
        let long = "x".repeat(500);
        let mut messages = vec![tool("c1", &long)];
        let pruned = prune_old_tool_results(&mut messages, 99);
        assert_eq!(pruned, 1);
    }

    #[test]
    fn prune_counts_chars_not_bytes() {
        // Multibyte chars: 300 chars but 900 bytes; must truncate on a char
        // boundary without panicking.
        let long = "é".repeat(300);
        let mut messages = vec![tool("c1", &long), user("end")];
        let pruned = prune_old_tool_results(&mut messages, 1);
        assert_eq!(pruned, 1);
        let content = messages[0]["content"].as_str().unwrap();
        assert!(content.starts_with(&"é".repeat(PRUNE_MAX_TOOL_RESULT_CHARS)));
    }

    // ---- select_boundaries -----------------------------------------------

    #[test]
    fn boundaries_none_when_conversation_fits_in_head() {
        let messages = vec![system("s"), user("hi"), assistant("hello")];
        assert_eq!(select_boundaries(&messages, 1_000), None);
    }

    #[test]
    fn boundaries_none_when_everything_fits_in_tail_budget() {
        let messages = vec![
            system("s"),
            user("hi"),
            assistant("hello"),
            user("more"),
            assistant("sure"),
        ];
        // Huge threshold: the whole middle+tail fits inside 20% of it.
        assert_eq!(select_boundaries(&messages, 1_000_000), None);
    }

    #[test]
    fn boundaries_none_without_user_message_past_head() {
        let messages = vec![
            system("s"),
            user("hi"),
            assistant("a"),
            assistant("b"),
            assistant("c"),
        ];
        assert_eq!(select_boundaries(&messages, 10), None);
    }

    #[test]
    fn boundaries_protect_first_three_messages() {
        let mut messages = vec![system("s"), user("hi"), assistant("hello")];
        for i in 0..10 {
            messages.push(user(&format!("turn {i} {}", "pad ".repeat(50))));
            messages.push(assistant(&format!("reply {i} {}", "pad ".repeat(50))));
        }
        let b = select_boundaries(&messages, 100).expect("compactable");
        assert_eq!(b.head_end, 3);
        assert!(b.tail_start > b.head_end);
        assert!(b.tail_start < messages.len());
    }

    #[test]
    fn boundaries_tail_respects_token_budget() {
        let mut messages = vec![system("s"), user("hi"), assistant("hello")];
        for i in 0..20 {
            messages.push(user(&format!("turn {i} {}", "pad ".repeat(30))));
            messages.push(assistant(&format!("reply {i} {}", "pad ".repeat(30))));
        }
        let threshold = 1_000; // budget = 200 tokens
        let b = select_boundaries(&messages, threshold).expect("compactable");
        let budget = (threshold as f64 * TAIL_TARGET_RATIO) as usize;
        let tail_cost = estimate_tokens(&messages[b.tail_start..]);
        // Within budget once at least one user message is present, and the
        // next-older message would not have fit.
        assert!(tail_cost <= budget, "tail {tail_cost} over budget {budget}");
        let with_one_more = tail_cost + estimate_message_tokens(&messages[b.tail_start - 1]);
        assert!(with_one_more > budget, "tail could have been larger");
    }

    #[test]
    fn boundaries_tail_always_contains_a_user_message_even_over_budget() {
        let messages = vec![
            system("s"),
            user("hi"),
            assistant("hello"),
            assistant("middle filler"),
            user(&"long user message ".repeat(50)),
            assistant("short"),
            assistant("also short"),
        ];
        // Zero budget: the tail must still reach back to the last user message.
        let b = select_boundaries(&messages, 0).expect("compactable");
        assert_eq!(b.tail_start, 4);
        assert!(messages[b.tail_start..].iter().any(|m| m["role"] == "user"));
    }

    #[test]
    fn boundaries_never_split_a_tool_pair() {
        let big = "b".repeat(400);
        let messages = vec![
            system("s"),
            user("hi"),
            assistant("hello"),
            user("do a thing"),
            assistant("older filler so the middle is non-empty"),
            assistant_calls("running", &[("c1", "file_grep")]),
            tool("c1", &big),
            user("ok"),
            assistant("done"),
        ];
        // Budget large enough for [done, ok, tool-result] but not the
        // assistant that issued the call: the cut would land on the tool
        // result and must walk back to include the assistant message.
        let tail_cost: usize = messages[6..].iter().map(estimate_message_tokens).sum();
        let threshold = ((tail_cost + 1) as f64 / TAIL_TARGET_RATIO) as usize;
        let b = select_boundaries(&messages, threshold).expect("compactable");
        assert_eq!(b.tail_start, 5, "tail must start at the assistant call");
        assert!(messages[b.tail_start]["tool_calls"].is_array());
        assert_pairs_aligned(&messages[b.tail_start..]);
    }

    #[test]
    fn boundaries_walk_back_over_multiple_tool_results() {
        let big = "b".repeat(300);
        let messages = vec![
            system("s"),
            user("hi"),
            assistant("hello"),
            user("go"),
            assistant("filler in the middle"),
            assistant_calls("two calls", &[("c1", "file_grep"), ("c2", "file_glob")]),
            tool("c1", &big),
            tool("c2", &big),
            user("ok"),
        ];
        // Budget covers [ok, c2-result] only: the cut lands inside the tool
        // block and must walk back past both results to the assistant.
        let tail_cost: usize = messages[7..].iter().map(estimate_message_tokens).sum();
        let threshold = ((tail_cost + 1) as f64 / TAIL_TARGET_RATIO) as usize;
        let b = select_boundaries(&messages, threshold).expect("compactable");
        assert_eq!(b.tail_start, 5);
        assert_pairs_aligned(&messages[b.tail_start..]);
    }

    #[test]
    fn boundaries_none_when_pair_walkback_reaches_head() {
        // The whole middle is one tool block; walking back to keep the pair
        // intact consumes the middle entirely -> nothing left to compact.
        let big = "b".repeat(400);
        let messages = vec![
            system("s"),
            user("hi"),
            assistant("hello"),
            assistant_calls("", &[("c1", "file_grep")]),
            tool("c1", &big),
            user("ok"),
        ];
        // Budget covers [user, tool-result] but not the assistant call: the
        // cut lands on the tool result, and walking back to the assistant
        // reaches the head boundary.
        let tail_cost: usize = messages[4..].iter().map(estimate_message_tokens).sum();
        let threshold = ((tail_cost + 1) as f64 / TAIL_TARGET_RATIO) as usize;
        assert_eq!(select_boundaries(&messages, threshold), None);
    }

    // ---- build_summary_request -------------------------------------------

    #[test]
    fn summary_request_has_system_and_user_with_sections() {
        let messages = vec![
            system("s"),
            user("build a tower"),
            assistant("ok"),
            user("make it taller"),
            assistant("done middle work"),
            user("tail question"),
            assistant("tail answer"),
        ];
        let b = Boundaries {
            head_end: 3,
            tail_start: 5,
        };
        let request = build_summary_request(&messages, &b);
        assert_eq!(request.len(), 2);
        assert_eq!(request[0]["role"], "system");
        assert_eq!(request[1]["role"], "user");
        let sys = request[0]["content"].as_str().unwrap();
        for section in [
            "## Goal",
            "## Constraints",
            "## Progress",
            "## Decisions",
            "## Files touched",
            "## Next steps",
        ] {
            assert!(sys.contains(section), "missing section {section}");
        }
        let transcript = request[1]["content"].as_str().unwrap();
        assert!(transcript.contains("build a tower")); // head included
        assert!(transcript.contains("done middle work")); // middle included
        assert!(!transcript.contains("tail question")); // tail excluded
        assert!(!transcript.contains("tail answer"));
    }

    #[test]
    fn summary_request_renders_tool_calls_and_results() {
        let messages = vec![
            system("s"),
            user("go"),
            assistant("ok"),
            assistant_calls("calling", &[("c1", "file_grep")]),
            tool("c1", "match at line 4"),
            user("tail"),
        ];
        let b = Boundaries {
            head_end: 3,
            tail_start: 5,
        };
        let request = build_summary_request(&messages, &b);
        let transcript = request[1]["content"].as_str().unwrap();
        assert!(transcript.contains("file_grep"));
        assert!(transcript.contains("match at line 4"));
    }

    #[test]
    fn summary_request_caps_giant_messages() {
        let giant = "g".repeat(SUMMARY_TRANSCRIPT_MESSAGE_CAP * 4);
        let messages = vec![system("s"), user(&giant), assistant("mid"), user("tail")];
        let b = Boundaries {
            head_end: 3,
            tail_start: 3,
        };
        let request = build_summary_request(&messages, &b);
        let transcript = request[1]["content"].as_str().unwrap();
        assert!(transcript.chars().count() < SUMMARY_TRANSCRIPT_MESSAGE_CAP * 2);
    }

    // ---- apply + sanitize -------------------------------------------------

    #[test]
    fn apply_assembles_head_summary_tail() {
        let messages = vec![
            system("s"),
            user("hi"),
            assistant("hello"),
            user("middle 1"),
            assistant("middle 2"),
            user("tail q"),
            assistant("tail a"),
        ];
        let b = Boundaries {
            head_end: 3,
            tail_start: 5,
        };
        let out = apply(&messages, &b, "## Goal\n- build");
        assert_eq!(out.len(), 3 + 1 + 2);
        assert_eq!(&out[..3], &messages[..3]);
        assert_eq!(out[3]["role"], "assistant");
        let summary = out[3]["content"].as_str().unwrap();
        assert!(summary.starts_with(SUMMARY_MARKER));
        assert!(summary.contains("## Goal"));
        assert_eq!(&out[4..], &messages[5..]);
    }

    #[test]
    fn apply_drops_tool_results_orphaned_by_the_cut() {
        // The assistant that issued c1 falls in the middle; its result sits at
        // the tail start only if pair-alignment were skipped. Simulate a
        // hand-built (mis-aligned) boundary to prove apply sanitizes it.
        let messages = vec![
            system("s"),
            user("hi"),
            assistant("hello"),
            assistant_calls("", &[("c1", "file_grep")]),
            tool("c1", "result"),
            user("tail"),
        ];
        let b = Boundaries {
            head_end: 3,
            tail_start: 4, // splits the pair on purpose
        };
        let out = apply(&messages, &b, "summary");
        assert!(
            !out.iter().any(|m| m["role"] == "tool"),
            "orphan tool result must be dropped"
        );
        assert!(out
            .iter()
            .any(|m| m["role"] == "user" && m["content"] == "tail"));
    }

    #[test]
    fn apply_strips_assistant_calls_orphaned_in_the_head() {
        // Head ends on an assistant tool-call message whose results fell into
        // the compacted middle: the stale tool_calls must be stripped.
        let messages = vec![
            system("s"),
            user("hi"),
            assistant_calls("I will check the files", &[("c1", "file_grep")]),
            tool("c1", "result"),
            assistant("middle"),
            user("tail"),
        ];
        let b = Boundaries {
            head_end: 3,
            tail_start: 5,
        };
        let out = apply(&messages, &b, "summary");
        let head_assistant = &out[2];
        assert_eq!(head_assistant["role"], "assistant");
        assert!(
            head_assistant.get("tool_calls").is_none(),
            "unanswered tool_calls must be stripped"
        );
        assert_eq!(head_assistant["content"], "I will check the files");
    }

    #[test]
    fn apply_drops_empty_assistant_after_stripping_calls() {
        let messages = vec![
            system("s"),
            user("hi"),
            assistant_calls("", &[("c1", "file_grep")]),
            tool("c1", "result"),
            assistant("middle"),
            user("tail"),
        ];
        let b = Boundaries {
            head_end: 3,
            tail_start: 5,
        };
        let out = apply(&messages, &b, "summary");
        // Content-less assistant with stripped calls disappears entirely.
        assert!(!out
            .iter()
            .any(|m| m["role"] == "assistant" && m["tool_calls"].is_array()));
        assert!(!out
            .iter()
            .any(|m| m["role"] == "assistant" && m["content"] == ""));
    }

    #[test]
    fn apply_preserves_intact_pairs_in_the_tail() {
        let messages = vec![
            system("s"),
            user("hi"),
            assistant("hello"),
            user("middle"),
            assistant_calls("checking", &[("c1", "file_grep"), ("c2", "file_glob")]),
            tool("c1", "r1"),
            tool("c2", "r2"),
            user("tail user"),
        ];
        let b = Boundaries {
            head_end: 3,
            tail_start: 4,
        };
        let out = apply(&messages, &b, "summary");
        assert_eq!(&out[4..], &messages[4..], "intact tail must be preserved");
        assert_pairs_aligned(&out);
    }

    #[test]
    fn sanitize_filters_partially_answered_calls() {
        let messages = vec![
            assistant_calls("two calls", &[("c1", "file_grep"), ("c2", "file_glob")]),
            tool("c1", "only c1 answered"),
            user("next"),
        ];
        let out = sanitize_tool_pairs(messages);
        assert_eq!(out.len(), 3);
        let calls = out[0]["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "c1");
    }

    #[test]
    fn sanitize_drops_tool_result_after_non_assistant_message() {
        // A user message between the assistant call and the result breaks the
        // block; the result is orphaned.
        let messages = vec![
            assistant_calls("call", &[("c1", "file_grep")]),
            user("interruption"),
            tool("c1", "late result"),
        ];
        let out = sanitize_tool_pairs(messages);
        assert!(!out.iter().any(|m| m["role"] == "tool"));
        // And the now-unanswered call is stripped from the assistant.
        assert!(out[0].get("tool_calls").is_none());
    }

    #[test]
    fn sanitize_keeps_fully_valid_conversations_unchanged() {
        let messages = vec![
            system("s"),
            user("hi"),
            assistant_calls("checking", &[("c1", "file_grep")]),
            tool("c1", "result"),
            assistant("done"),
        ];
        assert_eq!(sanitize_tool_pairs(messages.clone()), messages);
    }

    #[test]
    fn sanitize_drops_tool_result_with_wrong_id() {
        let messages = vec![
            assistant_calls("call", &[("c1", "file_grep")]),
            tool("c-other", "mismatched"),
        ];
        let out = sanitize_tool_pairs(messages);
        assert!(!out.iter().any(|m| m["role"] == "tool"));
        assert!(out.is_empty() || out[0].get("tool_calls").is_none());
    }

    // ---- full pipeline ----------------------------------------------------

    #[test]
    fn full_pipeline_shrinks_and_stays_aligned() {
        let big = "detail ".repeat(200);
        let mut messages = vec![
            system("You are CaliCode."),
            user("Build the tower level"),
            assistant("Starting on it."),
        ];
        for i in 0..8 {
            messages.push(user(&format!("step {i}: {big}")));
            messages.push(assistant_calls(
                &format!("working on step {i}"),
                &[(&format!("c{i}"), "file_write")],
            ));
            messages.push(tool(&format!("c{i}"), &big));
            messages.push(assistant(&format!("step {i} done")));
        }
        let before = estimate_tokens(&messages);
        let threshold = before / 2;

        let b = select_boundaries(&messages, threshold).expect("compactable");
        prune_old_tool_results(&mut messages, b.tail_start);

        let request = build_summary_request(&messages, &b);
        assert_eq!(request.len(), 2);

        let out = apply(
            &messages,
            &b,
            "## Goal\n- tower\n## Next steps\n- keep going",
        );
        let after = estimate_tokens(&out);
        assert!(after < before / 2, "compaction must shrink the transcript");

        // Head verbatim, summary present, tail verbatim, pairs aligned.
        assert_eq!(&out[..3], &messages[..3]);
        assert!(out[3]["content"]
            .as_str()
            .unwrap()
            .starts_with(SUMMARY_MARKER));
        assert_eq!(&out[4..], &messages[b.tail_start..]);
        assert_pairs_aligned(&out);
        assert!(out
            .iter()
            .any(|m| m["role"] == "user" && m["content"].as_str().unwrap().starts_with("step 7")));
    }

    #[test]
    fn full_pipeline_prune_only_touches_pre_tail_tool_results() {
        let big = "b".repeat(500);
        let mut messages = vec![system("s"), user("go"), assistant("ok")];
        for i in 0..6 {
            messages.push(user(&format!("u{i} {}", "pad ".repeat(40))));
            messages.push(assistant_calls("", &[(&format!("c{i}"), "file_grep")]));
            messages.push(tool(&format!("c{i}"), &big));
        }
        let b = select_boundaries(&messages, 400).expect("compactable");
        prune_old_tool_results(&mut messages, b.tail_start);
        for (i, m) in messages.iter().enumerate() {
            if m["role"] != "tool" {
                continue;
            }
            let len = m["content"].as_str().unwrap().chars().count();
            if i < b.tail_start {
                assert!(len < 300, "old tool result at {i} not pruned");
            } else {
                assert_eq!(len, 500, "tail tool result at {i} must stay intact");
            }
        }
    }
}
