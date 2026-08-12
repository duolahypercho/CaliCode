//! Session-scoped bridge from agents outside the webview to live editor tools.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::{broadcast, oneshot, Mutex};
use uuid::Uuid;

struct PendingEditorRequest {
    session_id: String,
    client_id: String,
    sender: oneshot::Sender<Value>,
}

#[derive(Clone)]
pub struct EditorBridge {
    events: broadcast::Sender<Value>,
    pending: Arc<Mutex<HashMap<String, PendingEditorRequest>>>,
}

impl EditorBridge {
    pub fn new(events: broadcast::Sender<Value>) -> Self {
        Self {
            events,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn call(
        &self,
        session_id: &str,
        project_slug: &str,
        workspace_root: &str,
        client_id: &str,
        tool: &str,
        arguments: Value,
    ) -> Result<Value> {
        let request_id = format!("editor-{}", Uuid::new_v4().simple());
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(
            request_id.clone(),
            PendingEditorRequest {
                session_id: session_id.to_string(),
                client_id: client_id.to_string(),
                sender: tx,
            },
        );
        let _ = self.events.send(json!({
            "type": "editor.tool_request",
            "requestId": request_id,
            "targetSessionId": session_id,
            "targetClientId": client_id,
            "projectSlug": project_slug,
            "workspaceRoot": workspace_root,
            "tool": tool,
            "arguments": arguments,
        }));
        match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
            Ok(result) => result.context("editor tool response channel closed"),
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                anyhow::bail!("editor tool {tool} timed out")
            }
        }
    }

    pub async fn submit(&self, request_id: &str, client_id: &str, result: Value) -> Result<Value> {
        let sender = {
            let mut pending = self.pending.lock().await;
            let request = pending
                .get(request_id)
                .context("editor tool request not found")?;
            if request.client_id != client_id {
                anyhow::bail!("editor tool response came from another client");
            }
            pending
                .remove(request_id)
                .expect("editor request existed while holding pending lock")
                .sender
        };
        sender
            .send(result)
            .map_err(|_| anyhow::anyhow!("editor tool request already closed"))?;
        Ok(json!({ "accepted": true }))
    }

    /// Cancel requests owned by a deleted/archived session.
    ///
    /// Dropping the oneshot senders wakes each waiting `call` immediately;
    /// otherwise an abandoned editor could keep a request alive for the full
    /// 60-second timeout and accumulate one pending entry per failed turn.
    pub async fn cancel_session(&self, session_id: &str) -> usize {
        let mut pending = self.pending.lock().await;
        let ids: Vec<String> = pending
            .iter()
            .filter(|(_, request)| request.session_id == session_id)
            .map(|(request_id, _)| request_id.clone())
            .collect();
        let cancelled = ids.len();
        for request_id in ids {
            pending.remove(&request_id);
        }
        cancelled
    }
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorAttachment {
    pub client_id: String,
    pub session_id: String,
    pub project_slug: String,
    pub workspace_root: String,
}

/// Compare workspace roots after resolving symlinks where possible.
///
/// Editor and session paths can arrive through different UI routes (for
/// example, a symlinked project folder versus the worktree's real path). The
/// lexical fallback keeps non-existent test paths comparable.
pub fn same_path(left: &str, right: &str) -> bool {
    let left_path = Path::new(left);
    let right_path = Path::new(right);
    match (left_path.canonicalize(), right_path.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left_path == right_path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn external_call_carries_session_context_and_returns_editor_result() {
        let (events, _) = broadcast::channel(8);
        let bridge = EditorBridge::new(events.clone());
        let mut receiver = events.subscribe();
        let caller = {
            let bridge = bridge.clone();
            tokio::spawn(async move {
                bridge
                    .call(
                        "session-a",
                        "demo",
                        "/tmp/worktree-a",
                        "client-a",
                        "editor_scene_inspect",
                        json!({}),
                    )
                    .await
            })
        };

        let event = receiver.recv().await.unwrap();
        assert_eq!(event["targetSessionId"], "session-a");
        assert_eq!(event["targetClientId"], "client-a");
        assert_eq!(event["workspaceRoot"], "/tmp/worktree-a");
        bridge
            .submit(
                event["requestId"].as_str().unwrap(),
                "client-a",
                json!({ "entities": 3 }),
            )
            .await
            .unwrap();
        assert_eq!(caller.await.unwrap().unwrap()["entities"], 3);
    }

    #[tokio::test]
    async fn foreign_client_cannot_steal_a_pending_request() {
        let (events, _) = broadcast::channel(8);
        let bridge = EditorBridge::new(events);
        let mut foreign_listener = bridge.events.subscribe();
        let mut owner_listener = bridge.events.subscribe();
        let caller = {
            let bridge = bridge.clone();
            tokio::spawn(async move {
                bridge
                    .call(
                        "session-a",
                        "demo",
                        "/tmp/worktree-a",
                        "client-a",
                        "editor_scene_inspect",
                        json!({}),
                    )
                    .await
            })
        };

        let foreign_event = foreign_listener.recv().await.unwrap();
        let owner_event = owner_listener.recv().await.unwrap();
        assert_eq!(foreign_event["targetClientId"], "client-a");
        assert_eq!(owner_event["targetClientId"], "client-a");
        let request_id = owner_event["requestId"].as_str().unwrap().to_string();
        let error = bridge
            .submit(&request_id, "client-b", json!({ "wrong": true }))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("another client"));
        bridge
            .submit(&request_id, "client-a", json!({ "ok": true }))
            .await
            .unwrap();
        assert_eq!(caller.await.unwrap().unwrap()["ok"], true);
    }

    #[tokio::test]
    async fn cancelling_a_session_releases_its_pending_call() {
        let (events, _) = broadcast::channel(8);
        let bridge = EditorBridge::new(events.clone());
        let mut receiver = events.subscribe();
        let caller = {
            let bridge = bridge.clone();
            tokio::spawn(async move {
                bridge
                    .call(
                        "session-a",
                        "demo",
                        "/tmp/worktree-a",
                        "client-a",
                        "editor_scene_inspect",
                        json!({}),
                    )
                    .await
            })
        };

        // Ensure the request has been inserted before cancellation.
        receiver.recv().await.unwrap();
        assert_eq!(bridge.cancel_session("session-a").await, 1);
        let result = caller.await.unwrap();
        assert!(
            result.is_err(),
            "cancelling a session must close the waiting editor call"
        );
    }
}
