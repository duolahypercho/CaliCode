//! What the model has been told about its surroundings, and what changed since.
//!
//! The system prompt carries a `## This session` block describing the project,
//! the connected editor's tools, and the conventions in force. It is written
//! once — `chat` pushes the system message only when the transcript is empty —
//! and never revised. So the moment the agent adds an entity, attaches a
//! workspace, or the user opens a page that registers new editor tools, the
//! model is working from a description of a world that no longer exists. It
//! will happily reason about "the 3 entities" long after it created a fourth.
//!
//! Codex answers this with World State: typed environment sections rendered as
//! a *diff* against what the model was last told. The diff is the important
//! part, and it is why this is not simply "re-send the block every turn":
//!
//! * Re-sending costs the same tokens every turn forever, and this repo has
//!   measured, deliberate work invested in a byte-stable prompt prefix
//!   (`docs/prompt-cache.md`) that a per-turn environment block would undo.
//! * A diff is *shorter than the thing it describes* in the common case, and
//!   in the most common case of all — nothing changed — it is nothing at all.
//! * A model told only what changed does not have to notice that two long
//!   blocks differ in one number.
//!
//! Three-valued on purpose, as Codex's is: a field can appear, change, or go
//! away, and "the workspace was detached" is a different fact from "the
//! workspace is unknown". Silence means unchanged, never unknown.

use serde_json::Value;
use std::collections::BTreeMap;

/// Longest rendered diff. A change this large is better discovered with the
/// tools than recited; the cap keeps a pathological project from pushing a
/// wall of text into every turn.
const MAX_DIFF_CHARS: usize = 1200;

/// A flat, ordered snapshot of the environment the model was told about.
///
/// Flat because the diff is per-field and the fields are independent; ordered
/// (`BTreeMap`) because the rendering must be byte-stable for the same state,
/// or an unchanged world would produce a spurious diff.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorldState {
    fields: BTreeMap<String, String>,
}

impl WorldState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a field. An empty value is recorded as absent rather than as an
    /// empty string, so "gone" and "blank" cannot be confused.
    pub fn set(&mut self, key: &str, value: impl Into<String>) -> &mut Self {
        let value = value.into();
        if value.trim().is_empty() {
            self.fields.remove(key);
        } else {
            self.fields.insert(key.to_string(), value);
        }
        self
    }
}

/// Capture the parts of the world that change *during* a session.
///
/// Deliberately not everything in the system prompt: the static conventions and
/// the skills index do not move while a session runs, so including them would
/// only add ways to produce a diff that tells the model nothing.
pub fn capture(
    project_digest: &str,
    editor_tools: &[String],
    workspace_root: Option<&str>,
) -> WorldState {
    let mut state = WorldState::new();
    state.set("project", project_digest);
    state.set("workspace", workspace_root.unwrap_or(""));
    if editor_tools.is_empty() {
        state.set("editor tools", "");
    } else {
        let mut names: Vec<&str> = editor_tools.iter().map(String::as_str).collect();
        names.sort_unstable();
        state.set("editor tools", names.join(", "));
    }
    state
}

/// What to tell the model, or `None` when it already knows.
///
/// `previous: None` means this is the first turn, where the system prompt has
/// just described the whole world — saying it again would be noise, so nothing
/// is emitted.
pub fn diff(previous: Option<&WorldState>, current: &WorldState) -> Option<String> {
    let previous = previous?;
    if previous == current {
        return None;
    }

    let mut lines: Vec<String> = Vec::new();
    for (key, value) in &current.fields {
        match previous.fields.get(key) {
            Some(before) if before == value => {}
            Some(_) => lines.push(format!("- {key} is now: {value}")),
            None => lines.push(format!("- {key} appeared: {value}")),
        }
    }
    for key in previous.fields.keys() {
        if !current.fields.contains_key(key) {
            lines.push(format!("- {key} is gone"));
        }
    }
    if lines.is_empty() {
        return None;
    }

    let body = lines.join("\n");
    let body = if body.chars().count() > MAX_DIFF_CHARS {
        let kept: String = body.chars().take(MAX_DIFF_CHARS).collect();
        format!("{kept}\n… (more changed; inspect directly rather than relying on this)")
    } else {
        body
    };
    Some(format!(
        "<system-reminder>\nSince you were last told about your surroundings, this changed:\n\
         {body}\nNothing else changed. This is not a request — act on it only if it matters to \
         what you are doing.\n</system-reminder>"
    ))
}

/// The diff as a transcript message, ready to append.
pub fn message(text: &str) -> Value {
    serde_json::json!({ "role": "user", "content": text })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(project: &str, tools: &[&str], workspace: Option<&str>) -> WorldState {
        capture(
            project,
            &tools.iter().map(|t| t.to_string()).collect::<Vec<_>>(),
            workspace,
        )
    }

    #[test]
    fn the_first_turn_says_nothing_because_the_prompt_just_said_it() {
        let current = state("3 entities", &["editor_scene_inspect"], None);
        assert!(diff(None, &current).is_none());
    }

    #[test]
    fn an_unchanged_world_costs_nothing() {
        let before = state("3 entities", &["editor_scene_inspect"], Some("/w"));
        let after = state("3 entities", &["editor_scene_inspect"], Some("/w"));
        assert!(diff(Some(&before), &after).is_none());
    }

    #[test]
    fn tool_order_is_not_a_change() {
        // Registration order varies by which page finished loading first; a
        // diff for that would be pure noise, every turn.
        let before = state("3 entities", &["b_tool", "a_tool"], None);
        let after = state("3 entities", &["a_tool", "b_tool"], None);
        assert!(diff(Some(&before), &after).is_none());
    }

    #[test]
    fn a_changed_project_is_reported_as_the_new_value() {
        let before = state("slug x — 3 entities", &[], None);
        let after = state("slug x — 4 entities", &[], None);
        let text = diff(Some(&before), &after).expect("a changed project must be reported");
        assert!(text.contains("project is now:"), "{text}");
        assert!(text.contains("4 entities"), "{text}");
        // The old value is not repeated: the model had it, and repeating it
        // invites reasoning about a world that no longer exists.
        assert!(!text.contains("3 entities"), "{text}");
    }

    #[test]
    fn appearing_and_disappearing_are_different_facts() {
        let none = state("p", &[], None);
        let attached = state("p", &[], Some("/repo"));
        let appeared = diff(Some(&none), &attached).unwrap();
        assert!(appeared.contains("workspace appeared: /repo"), "{appeared}");

        let detached = diff(Some(&attached), &none).unwrap();
        assert!(detached.contains("workspace is gone"), "{detached}");
        // "Detached" must not read as "unknown" — silence is what means
        // unchanged, so a removal has to be said out loud.
        assert!(!detached.contains("appeared"), "{detached}");
    }

    #[test]
    fn a_runaway_diff_is_bounded_and_says_it_was_cut() {
        let before = state("p", &[], None);
        let after = state(&"e".repeat(MAX_DIFF_CHARS * 3), &[], None);
        let text = diff(Some(&before), &after).unwrap();
        assert!(text.chars().count() < MAX_DIFF_CHARS + 400);
        assert!(text.contains("inspect directly"), "{text}");
    }

    #[test]
    fn the_reminder_is_framed_as_context_not_an_instruction() {
        let before = state("p", &[], None);
        let after = state("q", &[], None);
        let text = diff(Some(&before), &after).unwrap();
        // An environment note that reads as a command derails whatever the
        // model was doing.
        assert!(text.contains("This is not a request"), "{text}");
        assert!(text.starts_with("<system-reminder>"), "{text}");
    }
}
