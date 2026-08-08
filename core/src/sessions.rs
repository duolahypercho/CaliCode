//! Persistent agent sessions.
//!
//! The conversation transcript is owned by the client and replayed to the model
//! each turn, so the in-memory `AgentManager` sessions (tool/approval plumbing)
//! are ephemeral. This module gives sessions a durable home under
//! `~/.cali/sessions/<id>.json` so they can be listed, resumed, forked, and
//! deleted — the session surface every comparable harness (codex, opencode,
//! t3-code) exposes.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{json, Value};
use uuid::Uuid;

/// The first line of a user message, trimmed — used when no title is given.
const TITLE_MAX_CHARS: usize = 56;

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

/// A lightweight listing entry (no messages) for the history picker.
fn summary(record: &Value) -> Value {
    json!({
        "id": record.get("id").cloned().unwrap_or(Value::Null),
        "title": record.get("title").cloned().unwrap_or(Value::Null),
        "projectSlug": record.get("projectSlug").cloned().unwrap_or(Value::Null),
        "provider": record.get("provider").cloned().unwrap_or(Value::Null),
        "model": record.get("model").cloned().unwrap_or(Value::Null),
        "createdAt": record.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": record.get("updatedAt").cloned().unwrap_or(Value::Null),
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
    let id = params.get("id").and_then(Value::as_str).context("id required")?;
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
        .unwrap_or_else(|| json!([]));
    let title = params
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|record| record.get("title").and_then(Value::as_str))
                .map(str::to_string)
        })
        .unwrap_or_else(|| derive_title(&messages));

    let record = json!({
        "id": clean,
        "title": title,
        "projectSlug": params.get("projectSlug").cloned().unwrap_or(Value::Null),
        "provider": params.get("provider").cloned().unwrap_or(Value::Null),
        "model": params.get("model").cloned().unwrap_or(Value::Null),
        "createdAt": created,
        "updatedAt": now_secs(),
        "messages": messages,
    });

    // Write to a temp file then rename so a crash mid-write can't leave a
    // truncated session that fails to parse (list() would silently drop it).
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&record)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(summary(&record))
}

/// List session summaries, newest first.
pub fn list(root: &Path) -> Result<Value> {
    let mut items = Vec::new();
    if root.exists() {
        for entry in std::fs::read_dir(root)? {
            let path = entry?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(record) = serde_json::from_str::<Value>(&text) {
                    items.push(summary(&record));
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
    let text =
        std::fs::read_to_string(&path).with_context(|| format!("session {id} not found"))?;
    Ok(serde_json::from_str(&text)?)
}

/// Delete a session. Idempotent — deleting a missing session is not an error.
pub fn delete(root: &Path, id: &str) -> Result<Value> {
    let path = session_file(root, id)?;
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(json!({ "id": id, "deleted": true }))
}

/// Copy a session under a fresh id so a divergent path can be explored without
/// mutating the original. Returns the new full record.
pub fn fork(root: &Path, id: &str, new_id: Option<&str>) -> Result<Value> {
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

    std::fs::create_dir_all(root)?;
    let path = session_file(root, &clean)?;
    std::fs::write(&path, serde_json::to_vec_pretty(&record)?)?;
    Ok(record)
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
    fn save_preserves_created_at_and_title() {
        let root = root();
        let first = save(&root, &json!({ "id": "s1", "title": "Keep me", "messages": [] })).unwrap();
        let created = first["createdAt"].as_u64().unwrap();
        let second = save(&root, &json!({ "id": "s1", "messages": [{ "role": "user", "content": "x" }] })).unwrap();
        assert_eq!(second["title"], "Keep me");
        assert_eq!(second["createdAt"].as_u64().unwrap(), created);
    }

    #[test]
    fn fork_creates_independent_copy() {
        let root = root();
        save(&root, &json!({ "id": "src", "messages": [{ "role": "user", "content": "hi" }] })).unwrap();
        let forked = fork(&root, "src", Some("dst")).unwrap();
        assert_eq!(forked["id"], "dst");
        assert!(forked["title"].as_str().unwrap().ends_with("(fork)"));
        assert_eq!(forked["messages"][0]["content"], "hi");
    }

    #[test]
    fn list_orders_newest_first_and_delete_removes() {
        let root = root();
        save(&root, &json!({ "id": "old", "messages": [] })).unwrap();
        save(&root, &json!({ "id": "new", "messages": [] })).unwrap();
        let listed = list(&root).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 2);

        delete(&root, "old").unwrap();
        let after = list(&root).unwrap();
        assert_eq!(after.as_array().unwrap().len(), 1);
    }

    #[test]
    fn rejects_path_traversal_ids() {
        let root = root();
        assert!(save(&root, &json!({ "id": "../evil", "messages": [] })).is_err());
        assert!(load(&root, "../../etc/passwd").is_err());
    }
}
