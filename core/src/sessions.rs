//! Persistent agent sessions.
//!
//! The conversation transcript is owned by the client and replayed to the model
//! each turn, so the in-memory `AgentManager` sessions (tool/approval plumbing)
//! are ephemeral. This module gives sessions a durable home under
//! `~/.cali/sessions/<id>.json` so they can be listed, resumed, forked, and
//! deleted — the session surface every comparable harness (codex, opencode,
//! t3-code) exposes.

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use anyhow::{Context, Result};
use serde_json::{json, Value};
use uuid::Uuid;

/// The first line of a user message, trimmed — used when no title is given.
const TITLE_MAX_CHARS: usize = 56;
const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";

/// Session RPCs are synchronous filesystem read/modify/write operations, but
/// axum may dispatch several requests concurrently (auto-save racing a fork,
/// compaction, or delete). Serialize those small critical sections so one
/// request cannot read an old record and overwrite a newer transcript.
static SESSION_IO_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Reject ids that could escape the sessions directory. Our ids are
/// `session-<hex>`, but this is defense in depth for a filesystem path.
fn clean_id(id: &str) -> Result<String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        anyhow::bail!("invalid session id");
    }
    Ok(id.to_string())
}

fn session_file(root: &Path, id: &str) -> Result<PathBuf> {
    Ok(root.join(format!("{}.json", clean_id(id)?)))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs())
        .unwrap_or(0)
}

fn derive_title(messages: &Value) -> String {
    let first_user = messages
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        })
        .and_then(|message| message.get("content").and_then(Value::as_str))
        .unwrap_or("");
    let trimmed: String = first_user.trim().chars().take(TITLE_MAX_CHARS).collect();
    if trimmed.is_empty() {
        "Untitled session".to_string()
    } else {
        trimmed
    }
}

fn strip_private_reasoning(content: &str) -> String {
    let mut visible = String::with_capacity(content.len());
    let mut remaining = content;

    loop {
        let open = remaining.find(THINK_OPEN);
        let close = remaining.find(THINK_CLOSE);
        match (open, close) {
            (Some(open), Some(close)) if close < open => {
                visible.push_str(&remaining[..close]);
                remaining = &remaining[close + THINK_CLOSE.len()..];
            }
            (Some(open), _) => {
                visible.push_str(&remaining[..open]);
                let hidden = &remaining[open + THINK_OPEN.len()..];
                let Some(close) = hidden.find(THINK_CLOSE) else {
                    return visible;
                };
                remaining = &hidden[close + THINK_CLOSE.len()..];
            }
            (None, Some(close)) => {
                visible.push_str(&remaining[..close]);
                remaining = &remaining[close + THINK_CLOSE.len()..];
            }
            (None, None) => break,
        }
    }

    visible.push_str(remaining);
    visible
}

/// Older compatible providers persisted private reasoning inline. Both UI
/// resume and editor attachment read through this boundary, so assistant-only
/// scrubbing keeps those blocks out of display and replay without interpreting
/// user-authored examples as provider markup.
fn sanitize_assistant_messages(record: &mut Value) {
    for key in ["messages", "archived"] {
        let Some(messages) = record.get_mut(key).and_then(Value::as_array_mut) else {
            continue;
        };
        for message in messages {
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                continue;
            }
            let Some(content) = message.get_mut("content") else {
                continue;
            };
            let Some(text) = content.as_str() else {
                continue;
            };
            if text.contains(THINK_OPEN) || text.contains(THINK_CLOSE) {
                *content = json!(strip_private_reasoning(text));
            }
        }
    }
}

/// A lightweight listing entry (no messages) for the history picker.
fn summary(record: &Value) -> Value {
    json!({
        "id": record.get("id").cloned().unwrap_or(Value::Null),
        "title": record.get("title").cloned().unwrap_or(Value::Null),
        "projectSlug": record.get("projectSlug").cloned().unwrap_or(Value::Null),
        "provider": record.get("provider").cloned().unwrap_or(Value::Null),
        "model": record.get("model").cloned().unwrap_or(Value::Null),
        "workspaceRoot": record.get("workspaceRoot").cloned().unwrap_or(Value::Null),
        "worktreeId": record.get("worktreeId").cloned().unwrap_or(Value::Null),
        "branch": record.get("branch").cloned().unwrap_or(Value::Null),
        "createdAt": record.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": record.get("updatedAt").cloned().unwrap_or(Value::Null),
        // Null unless the chat sits in the archive; the sidebar lists sessions
        // where this is absent, settings lists the ones where it is set.
        "archivedAt": record.get("archivedAt").cloned().unwrap_or(Value::Null),
        "messageCount": record
            .get("messages")
            .and_then(Value::as_array)
            .map(|items| items.len())
            .unwrap_or(0),
    })
}

/// Create or update a session from the client's transcript. `createdAt` and an
/// explicit `title` survive re-saves. Returns the saved summary.
pub fn save(root: &Path, params: &Value) -> Result<Value> {
    let _io = SESSION_IO_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("session storage lock poisoned"))?;
    let id = params
        .get("id")
        .and_then(Value::as_str)
        .context("id required")?;
    let clean = clean_id(id)?;
    std::fs::create_dir_all(root)?;
    let path = session_file(root, &clean)?;

    let existing = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let created = existing
        .as_ref()
        .and_then(|record| record.get("createdAt").and_then(Value::as_u64))
        .unwrap_or_else(now_secs);

    let messages = params
        .get("messages")
        .cloned()
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|record| record.get("messages"))
                .cloned()
        })
        .unwrap_or_else(|| json!([]));
    let title = params
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|record| record.get("title").and_then(Value::as_str))
                .filter(|title| {
                    *title != "Untitled session" || derive_title(&messages) == "Untitled session"
                })
                .map(str::to_string)
        })
        .unwrap_or_else(|| derive_title(&messages));

    let stable = |key: &str| {
        existing
            .as_ref()
            .and_then(|record| record.get(key))
            .filter(|value| !value.is_null())
            .cloned()
            .or_else(|| params.get(key).cloned())
            .unwrap_or(Value::Null)
    };
    let archived = params
        .get("archived")
        .cloned()
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|record| record.get("archived"))
                .cloned()
        })
        .unwrap_or_else(|| json!([]));

    let record = json!({
        "id": clean,
        "title": title,
        "projectSlug": stable("projectSlug"),
        "provider": params.get("provider").cloned().unwrap_or(Value::Null),
        "model": params.get("model").cloned().unwrap_or(Value::Null),
        "workspaceRoot": stable("workspaceRoot"),
        "worktreeId": stable("worktreeId"),
        "branch": stable("branch"),
        "createdAt": created,
        "updatedAt": now_secs(),
        // Autosave must not resurrect an archived chat into the sidebar, so
        // the flag survives every re-save; `set_archived` is the only writer.
        "archivedAt": stable("archivedAt"),
        "messages": messages,
        "archived": archived,
    });

    write_record(&path, &record)?;
    Ok(summary(&record))
}

/// Allocate an empty durable session before its first model turn. This gives
/// the editor and external agents a stable routing id immediately.
pub fn create(root: &Path, params: &Value) -> Result<Value> {
    let id = format!("session-{}", Uuid::new_v4().simple());
    let mut initial = params.clone();
    let object = initial
        .as_object_mut()
        .context("session params must be an object")?;
    object.insert("id".into(), json!(id));
    object.insert("messages".into(), json!([]));
    save(root, &initial)
}

/// Find the newest session whose bound workspace contains `path`. Exact
/// matches win; allowing descendants lets a CLI launched in a repo subfolder
/// resolve the same task without extra flags.
pub fn resolve_workspace(root: &Path, path: &Path) -> Result<Value> {
    let requested = path
        .canonicalize()
        .with_context(|| format!("workspace path {} is unavailable", path.display()))?;
    let listed = list(root, false)?;
    for item in listed.as_array().into_iter().flatten() {
        let Some(bound) = item.get("workspaceRoot").and_then(Value::as_str) else {
            continue;
        };
        let Ok(bound) = Path::new(bound).canonicalize() else {
            continue;
        };
        if requested == bound || requested.starts_with(&bound) {
            return Ok(item.clone());
        }
    }
    anyhow::bail!("no CaliCode session is attached to {}", requested.display())
}

/// List session summaries, newest first. `archived` selects which half of the
/// store is returned: the live chats the sidebar shows, or the archive that
/// settings offers to restore or delete for good.
pub fn list(root: &Path, archived: bool) -> Result<Value> {
    let mut items = Vec::new();
    if root.exists() {
        for entry in std::fs::read_dir(root)? {
            let path = entry?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(record) = serde_json::from_str::<Value>(&text) {
                    // The sessions directory is not exclusively sessions —
                    // `usage.json`, the token ledger, lives here too. A record
                    // with no id is not one: listing it puts a blank row in the
                    // sidebar that cannot be opened, renamed or deleted,
                    // because every one of those RPCs is keyed by id.
                    let is_session = record
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.trim().is_empty());
                    if is_session && is_archived(&record) == archived {
                        items.push(summary(&record));
                    }
                }
            }
        }
    }
    items.sort_by(|a, b| {
        let ta = b.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
        let tb = a.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
        ta.cmp(&tb)
    });
    Ok(json!(items))
}

/// Load a full session record including messages.
pub fn load(root: &Path, id: &str) -> Result<Value> {
    let path = session_file(root, id)?;
    let text = std::fs::read_to_string(&path).with_context(|| format!("session {id} not found"))?;
    let mut record = serde_json::from_str(&text)?;
    sanitize_assistant_messages(&mut record);
    Ok(record)
}

/// Delete a session. Idempotent — deleting a missing session is not an error.
pub fn delete(root: &Path, id: &str) -> Result<Value> {
    let _io = SESSION_IO_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("session storage lock poisoned"))?;
    let path = session_file(root, id)?;
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(json!({ "id": id, "deleted": true }))
}

/// Whether a record carries an archive stamp.
fn is_archived(record: &Value) -> bool {
    record
        .get("archivedAt")
        .is_some_and(|value| !value.is_null())
}

fn clean_slug(project_slug: &str) -> Result<()> {
    if project_slug.is_empty()
        || !project_slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        anyhow::bail!("invalid project slug");
    }
    Ok(())
}

/// Move a chat into the archive, or bring it back.
///
/// Nothing but the stamp changes: the transcript, the bound worktree and any
/// running agent are left alone, so restoring returns the chat exactly as it
/// was. Deleting is the only operation that discards anything.
pub fn set_archived(root: &Path, id: &str, archived: bool) -> Result<Value> {
    let _io = SESSION_IO_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("session storage lock poisoned"))?;
    let path = session_file(root, id)?;
    let text = std::fs::read_to_string(&path).with_context(|| format!("session {id} not found"))?;
    let mut record: Value = serde_json::from_str(&text)?;
    record["archivedAt"] = if archived {
        json!(now_secs())
    } else {
        Value::Null
    };
    write_record(&path, &record)?;
    Ok(summary(&record))
}

/// Archive every live chat belonging to one project. Returns how many moved.
pub fn archive_project(root: &Path, project_slug: &str) -> Result<Value> {
    clean_slug(project_slug)?;
    let ids: Vec<String> = list(root, false)?
        .as_array()
        .into_iter()
        .flatten()
        .filter(|record| record.get("projectSlug").and_then(Value::as_str) == Some(project_slug))
        .filter_map(|record| record.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut archived = 0usize;
    for id in &ids {
        set_archived(root, id, true)?;
        archived += 1;
    }
    Ok(json!({ "projectSlug": project_slug, "archived": archived }))
}

/// Delete every persisted chat belonging to one project, archived ones
/// included. Used when the project itself goes away — an archive entry whose
/// game no longer exists cannot be restored into anything.
pub fn delete_project(root: &Path, project_slug: &str) -> Result<Value> {
    let _io = SESSION_IO_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("session storage lock poisoned"))?;
    clean_slug(project_slug)?;

    let mut deleted = 0usize;
    if root.exists() {
        for entry in std::fs::read_dir(root)? {
            let path = entry?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let belongs_to_project = std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|record| {
                    record
                        .get("projectSlug")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .is_some_and(|slug| slug == project_slug);
            if belongs_to_project {
                std::fs::remove_file(&path)?;
                deleted += 1;
            }
        }
    }
    Ok(json!({ "projectSlug": project_slug, "deleted": deleted }))
}

/// Copy a session under a fresh id so a divergent path can be explored without
/// mutating the original. Returns the new full record.
pub fn fork(root: &Path, id: &str, new_id: Option<&str>) -> Result<Value> {
    let _io = SESSION_IO_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("session storage lock poisoned"))?;
    let mut record = load(root, id)?;
    let clean = match new_id {
        Some(value) => clean_id(value)?,
        None => format!("session-{}", Uuid::new_v4().simple()),
    };
    let title = record
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("session")
        .to_string();
    record["id"] = json!(clean);
    record["title"] = json!(format!("{title} (fork)"));
    record["createdAt"] = json!(now_secs());
    record["updatedAt"] = json!(now_secs());
    // A fork is a new live chat even when its source sits in the archive.
    record["archivedAt"] = Value::Null;
    // A fork is an independent task. RPC assigns it a fresh worktree; direct
    // callers still get a valid unbound record rather than sharing writes.
    record["workspaceRoot"] = Value::Null;
    record["worktreeId"] = Value::Null;
    record["branch"] = Value::Null;

    std::fs::create_dir_all(root)?;
    let path = session_file(root, &clean)?;
    write_record(&path, &record)?;
    Ok(record)
}

/// Soft-archive turns replaced by compaction: appended under the record's
/// `archived` key so nothing is lost when the live transcript is rewritten.
/// Creates a minimal record when the session was never saved by the client.
/// Returns the total number of archived messages after the append.
pub fn archive_turns(root: &Path, id: &str, turns: &[Value]) -> Result<usize> {
    let _io = SESSION_IO_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("session storage lock poisoned"))?;
    let clean = clean_id(id)?;
    std::fs::create_dir_all(root)?;
    let path = session_file(root, &clean)?;
    let mut record = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| {
            json!({
                "id": clean,
                "title": "Untitled session",
                "createdAt": now_secs(),
                "messages": [],
            })
        });
    let object = record
        .as_object_mut()
        .context("session record is not an object")?;
    let archived = object
        .entry("archived")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .context("session archived key is not an array")?;
    archived.extend(turns.iter().cloned());
    let total = archived.len();
    object.insert("updatedAt".into(), json!(now_secs()));
    write_record(&path, &record)?;
    Ok(total)
}

/// Write a session record atomically: temp file then rename, so a crash
/// mid-write can't leave a truncated session that fails to parse (list()
/// would silently drop it).
fn write_record(path: &Path, record: &Value) -> Result<()> {
    // A fixed sibling (`session.json.tmp`) is not safe when two independent
    // core requests save the same session at once: one rename can consume the
    // other's temporary file, turning a successful auto-save into an I/O
    // error. A unique sibling preserves atomic replacement without leaving
    // cross-request temp-file races.
    let tmp = path.with_extension(format!("json.{}.tmp", Uuid::new_v4().simple()));
    std::fs::write(&tmp, serde_json::to_vec_pretty(record)?)?;
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        // keep() persists the dir past the guard so save/load can round-trip.
        tempfile::tempdir().unwrap().keep()
    }

    #[test]
    fn save_then_load_roundtrips_messages() {
        let root = root();
        let saved = save(
            &root,
            &json!({
                "id": "session-abc",
                "projectSlug": "starter",
                "messages": [{ "role": "user", "content": "build a wall" }],
            }),
        )
        .unwrap();
        assert_eq!(saved["title"], "build a wall");
        assert_eq!(saved["messageCount"], 1);

        let loaded = load(&root, "session-abc").unwrap();
        assert_eq!(loaded["messages"][0]["content"], "build a wall");
    }

    #[test]
    fn load_hides_legacy_assistant_reasoning_without_rewriting_other_text() {
        let root = root();
        save(
            &root,
            &json!({
                "id": "session-reasoning",
                "messages": [
                    {
                        "role": "assistant",
                        "content": "Before <think>secret one</think>middle<think>secret two</think> after <code>x</code>"
                    },
                    { "role": "assistant", "content": "Visible prefix<think>unfinished secret" },
                    {
                        "role": "assistant",
                        "content": "<THINK>different case</THINK> <thinkish>ordinary tag</thinkish> stray </think> visible"
                    },
                    { "role": "user", "content": "Please preserve <think>my example</think>" },
                    { "role": "tool", "content": "tool output <think>literal</think>" }
                ],
                "archived": [
                    { "role": "assistant", "content": "Old <think>private</think>answer" },
                    { "role": "user", "content": "Old user <think>example</think>" }
                ]
            }),
        )
        .unwrap();

        let loaded = load(&root, "session-reasoning").unwrap();
        assert_eq!(
            loaded["messages"][0]["content"],
            "Before middle after <code>x</code>"
        );
        assert_eq!(loaded["messages"][1]["content"], "Visible prefix");
        assert_eq!(
            loaded["messages"][2]["content"],
            "<THINK>different case</THINK> <thinkish>ordinary tag</thinkish> stray  visible"
        );
        assert_eq!(
            loaded["messages"][3]["content"],
            "Please preserve <think>my example</think>"
        );
        assert_eq!(
            loaded["messages"][4]["content"],
            "tool output <think>literal</think>"
        );
        assert_eq!(loaded["archived"][0]["content"], "Old answer");
        assert_eq!(
            loaded["archived"][1]["content"],
            "Old user <think>example</think>"
        );
    }

    #[test]
    fn workspace_context_survives_transcript_saves() {
        let root = root();
        save(
            &root,
            &json!({
                "id": "session-context",
                "projectSlug": "starter",
                "workspaceRoot": "/tmp/worktree-a",
                "worktreeId": "wt-a",
                "branch": "calicode/starter/a",
                "messages": []
            }),
        )
        .unwrap();
        save(
            &root,
            &json!({ "id": "session-context", "messages": [{ "role": "user", "content": "go" }] }),
        )
        .unwrap();

        let loaded = load(&root, "session-context").unwrap();
        assert_eq!(loaded["workspaceRoot"], "/tmp/worktree-a");
        assert_eq!(loaded["worktreeId"], "wt-a");
        assert_eq!(loaded["branch"], "calicode/starter/a");
        assert_eq!(loaded["projectSlug"], "starter");
    }

    #[test]
    fn preallocated_session_gets_its_title_from_the_first_turn() {
        let root = root();
        let created = create(&root, &json!({ "projectSlug": "starter" })).unwrap();
        let id = created["id"].as_str().unwrap();
        assert_eq!(created["title"], "Untitled session");

        let saved = save(
            &root,
            &json!({
                "id": id,
                "messages": [{ "role": "user", "content": "Make the player jump" }]
            }),
        )
        .unwrap();
        assert_eq!(saved["title"], "Make the player jump");
    }

    #[test]
    fn save_preserves_created_at_and_title() {
        let root = root();
        let first = save(
            &root,
            &json!({ "id": "s1", "title": "Keep me", "messages": [] }),
        )
        .unwrap();
        let created = first["createdAt"].as_u64().unwrap();
        let second = save(
            &root,
            &json!({ "id": "s1", "messages": [{ "role": "user", "content": "x" }] }),
        )
        .unwrap();
        assert_eq!(second["title"], "Keep me");
        assert_eq!(second["createdAt"].as_u64().unwrap(), created);
    }

    #[test]
    fn transcript_save_preserves_archived_compaction_turns() {
        let root = root();
        save(
            &root,
            &json!({
                "id": "session-archive",
                "messages": [{ "role": "user", "content": "first" }]
            }),
        )
        .unwrap();
        archive_turns(
            &root,
            "session-archive",
            &[json!({ "role": "assistant", "content": "archived answer" })],
        )
        .unwrap();

        save(
            &root,
            &json!({
                "id": "session-archive",
                "messages": [{ "role": "user", "content": "new transcript" }]
            }),
        )
        .unwrap();

        let loaded = load(&root, "session-archive").unwrap();
        assert_eq!(loaded["archived"].as_array().unwrap().len(), 1);
        assert_eq!(loaded["archived"][0]["content"], "archived answer");
        assert_eq!(loaded["messages"][0]["content"], "new transcript");
    }

    #[test]
    fn fork_creates_independent_copy() {
        let root = root();
        save(
            &root,
            &json!({ "id": "src", "messages": [{ "role": "user", "content": "hi" }] }),
        )
        .unwrap();
        let forked = fork(&root, "src", Some("dst")).unwrap();
        assert_eq!(forked["id"], "dst");
        assert!(forked["title"].as_str().unwrap().ends_with("(fork)"));
        assert_eq!(forked["messages"][0]["content"], "hi");
    }

    #[test]
    fn fork_writes_atomically_without_tmp_residue() {
        let root = root();
        save(
            &root,
            &json!({ "id": "src", "messages": [{ "role": "user", "content": "hi" }] }),
        )
        .unwrap();
        fork(&root, "src", Some("dst")).unwrap();

        // No .tmp files left behind by the temp+rename path.
        for entry in std::fs::read_dir(&root).unwrap() {
            let path = entry.unwrap().path();
            assert_ne!(
                path.extension().and_then(|ext| ext.to_str()),
                Some("tmp"),
                "temp residue left at {path:?}"
            );
        }

        // The forked file on disk is valid JSON.
        let text = std::fs::read_to_string(root.join("dst.json")).unwrap();
        let record: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(record["id"], "dst");
    }

    #[test]
    fn concurrent_session_saves_are_serialized_and_leave_no_temp_files() {
        let root = root();
        let handles: Vec<_> = (0..24)
            .map(|index| {
                let root = root.clone();
                std::thread::spawn(move || {
                    save(
                        &root,
                        &json!({
                            "id": "same-session",
                            "messages": [{ "role": "user", "content": format!("turn-{index}") }]
                        }),
                    )
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap().unwrap();
        }

        let loaded = load(&root, "same-session").unwrap();
        assert!(loaded["messages"].is_array());
        for entry in std::fs::read_dir(&root).unwrap() {
            let path = entry.unwrap().path();
            assert_ne!(
                path.extension().and_then(|ext| ext.to_str()),
                Some("tmp"),
                "concurrent save left temp residue at {path:?}"
            );
        }
    }

    #[test]
    fn list_orders_newest_first_and_delete_removes() {
        let root = root();
        save(&root, &json!({ "id": "old", "messages": [] })).unwrap();
        save(&root, &json!({ "id": "new", "messages": [] })).unwrap();
        let listed = list(&root, false).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 2);

        delete(&root, "old").unwrap();
        let after = list(&root, false).unwrap();
        assert_eq!(after.as_array().unwrap().len(), 1);
    }

    /// `usage.json` — the token ledger — shares this directory. Listed as a
    /// session it became a blank sidebar row with no id, so nothing in the
    /// chat menu could act on it.
    #[test]
    fn list_skips_files_that_are_not_sessions() {
        let root = root();
        save(&root, &json!({ "id": "real", "messages": [] })).unwrap();
        std::fs::write(
            root.join("usage.json"),
            json!({ "models": { "openai/gpt-4.1": { "requests": 3 } } }).to_string(),
        )
        .unwrap();

        let listed = list(&root, false).unwrap();
        let items = listed.as_array().unwrap();
        assert_eq!(items.len(), 1, "{items:?}");
        assert_eq!(items[0]["id"], "real");
    }

    #[test]
    fn rejects_path_traversal_ids() {
        let root = root();
        assert!(save(&root, &json!({ "id": "../evil", "messages": [] })).is_err());
        assert!(load(&root, "../../etc/passwd").is_err());
    }

    #[test]
    fn archiving_hides_a_chat_from_the_live_list_and_restoring_brings_it_back() {
        let root = root();
        save(
            &root,
            &json!({ "id": "chat", "messages": [{ "role": "user", "content": "hi" }] }),
        )
        .unwrap();

        let archived = set_archived(&root, "chat", true).unwrap();
        assert!(archived["archivedAt"].as_u64().is_some());
        assert!(list(&root, false).unwrap().as_array().unwrap().is_empty());
        assert_eq!(list(&root, true).unwrap()[0]["id"], "chat");
        // The transcript is untouched: archiving is a visibility change.
        assert_eq!(load(&root, "chat").unwrap()["messages"][0]["content"], "hi");

        set_archived(&root, "chat", false).unwrap();
        assert_eq!(list(&root, false).unwrap()[0]["id"], "chat");
        assert!(list(&root, true).unwrap().as_array().unwrap().is_empty());
    }

    /// Autosave rewrites the whole record, so a chat archived mid-run would
    /// pop back into the sidebar on the agent's next save without this.
    #[test]
    fn save_keeps_an_archived_chat_archived() {
        let root = root();
        save(&root, &json!({ "id": "chat", "messages": [] })).unwrap();
        set_archived(&root, "chat", true).unwrap();

        save(
            &root,
            &json!({ "id": "chat", "messages": [{ "role": "user", "content": "later" }] }),
        )
        .unwrap();

        assert!(list(&root, false).unwrap().as_array().unwrap().is_empty());
        assert_eq!(list(&root, true).unwrap()[0]["id"], "chat");
    }

    #[test]
    fn archive_project_only_moves_matching_sessions() {
        let root = root();
        save(
            &root,
            &json!({ "id": "one", "projectSlug": "starter", "messages": [] }),
        )
        .unwrap();
        save(
            &root,
            &json!({ "id": "two", "projectSlug": "other", "messages": [] }),
        )
        .unwrap();

        let result = archive_project(&root, "starter").unwrap();
        assert_eq!(result["archived"], 1);
        assert_eq!(list(&root, true).unwrap()[0]["id"], "one");
        assert_eq!(list(&root, false).unwrap()[0]["id"], "two");
    }

    #[test]
    fn delete_project_only_removes_matching_sessions() {
        let root = root();
        save(
            &root,
            &json!({ "id": "one", "projectSlug": "starter", "messages": [] }),
        )
        .unwrap();
        save(
            &root,
            &json!({ "id": "two", "projectSlug": "other", "messages": [] }),
        )
        .unwrap();
        save(
            &root,
            &json!({ "id": "three", "projectSlug": "starter", "messages": [] }),
        )
        .unwrap();

        let result = delete_project(&root, "starter").unwrap();
        assert_eq!(result["deleted"], 2);
        assert!(load(&root, "one").is_err());
        assert!(load(&root, "three").is_err());
        assert_eq!(load(&root, "two").unwrap()["projectSlug"], "other");
    }
}
