//! The one place an approval can be created, answered, or abandoned.
//!
//! Approvals used to live in `AgentSession.pending` beside browser-tool
//! waiters, keyed by request id in a single map. Two request kinds sharing one
//! keyspace meant `agent_tool_result` carrying an `approval-…` id delivered a
//! tool-result JSON to an approval waiter, where `approved` is absent and
//! `unwrap_or(false)` read it as a denial. Separating the maps is what makes
//! that unrepresentable rather than merely unlikely.
//!
//! The governing invariant of the whole subsystem:
//!
//! > Only two things may produce a denial — a human clicking Deny, or core's
//! > own bounded timer. No inference, no transport failure, no state
//! > transition, on either side, ever.
//!
//! Cancelling a finished run's approvals is not a denial. It is core declining
//! to keep waiting for work that no longer exists, and it is reported as its
//! own [`Resolution`] so nobody downstream can mistake it for one.

use anyhow::Result;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, oneshot, Mutex};

/// How long core waits for a human before giving up on an approval.
pub const APPROVAL_TIMEOUT_SECS: u64 = 300;

/// A request waiting on an answer.
///
/// Everything a cancellation needs to find this entry is stored as data, so no
/// caller has to hold a session handle to reach it.
struct PendingApproval {
    /// Session the answer is addressed to — the root ancestor whose panel is
    /// watching. Kept for `cancel_by_session`.
    answer_session: String,
    /// The one window that may answer. `None` means nobody is attached and
    /// therefore nobody may answer: an unaddressed approval parks until it
    /// times out or its run is cancelled.
    target_client_id: Option<String>,
    /// The panel whose work this is. Display on the client, and a second key
    /// for `cancel_by_session`.
    owner_session: Option<String>,
    /// The graph run this belongs to. Display on the client, and the key for
    /// `cancel_by_graph`.
    owner_graph: Option<String>,
    sender: oneshot::Sender<Value>,
}

/// Every way an approval can leave the pending map.
///
/// Matched exhaustively with no `_ =>` arm anywhere: adding a variant must
/// fail the build rather than silently fall into an existing bucket.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// A human clicked. The only path that can carry `approved: false`.
    Answered { approved: bool },
    /// Core's own bounded timer expired.
    TimedOut,
    /// The run that raised this is over; there is nothing left to approve.
    RunCancelled,
    /// The session this was addressed to was deleted or evicted.
    SessionGone,
    /// Core is shutting down.
    CoreShutdown,
}

impl Resolution {
    /// Wire spelling, mirroring the enum exhaustively.
    pub fn outcome(&self) -> &'static str {
        match self {
            Self::Answered { approved: true } => "answered-approved",
            Self::Answered { approved: false } => "answered-denied",
            Self::TimedOut => "timed-out",
            Self::RunCancelled => "run-cancelled",
            Self::SessionGone => "session-gone",
            Self::CoreShutdown => "core-shutdown",
        }
    }

    /// The value handed to the waiting tool call. Only `Answered` can approve;
    /// every other exit is an absence of an answer, not a denial, and the
    /// caller reports it as such (see [`Approvals::request`]).
    fn payload(&self) -> Value {
        match self {
            Self::Answered { approved } => json!({ "approved": approved }),
            Self::TimedOut => json!({ "abandoned": "timed-out" }),
            Self::RunCancelled => json!({ "abandoned": "run-cancelled" }),
            Self::SessionGone => json!({ "abandoned": "session-gone" }),
            Self::CoreShutdown => json!({ "abandoned": "core-shutdown" }),
        }
    }
}

/// What [`Approvals::request`] observed. `Approved` is the only variant that
/// lets a tool run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApprovalOutcome {
    Approved,
    /// A human clicked Deny.
    Denied,
    /// Nobody answered and the request left the map for a non-human reason.
    /// Carries the wire spelling so the tool error names the real cause
    /// instead of claiming a denial nobody issued.
    Abandoned(&'static str),
}

/// Fields core needs to raise an approval. Grouped so the call site in
/// `agent.rs` stays a single statement.
pub struct ApprovalRequest<'a> {
    pub answer_session: &'a str,
    pub target_client_id: Option<String>,
    pub owner_session: Option<String>,
    pub owner_graph: Option<String>,
    pub asking_session: &'a str,
    pub tool: &'a str,
    pub arguments: Value,
}

#[derive(Clone)]
pub struct Approvals {
    events: broadcast::Sender<Value>,
    pending: Arc<Mutex<HashMap<String, PendingApproval>>>,
}

impl Approvals {
    pub fn new(events: broadcast::Sender<Value>) -> Self {
        Self {
            events,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Register a request, broadcast it, and wait for an answer up to
    /// [`APPROVAL_TIMEOUT_SECS`].
    pub async fn request(&self, request: ApprovalRequest<'_>) -> ApprovalOutcome {
        let request_id = format!("approval-{}", uuid::Uuid::new_v4().simple());
        let (tx, rx) = oneshot::channel();
        let raised_at_ms = now_ms();
        self.pending.lock().await.insert(
            request_id.clone(),
            PendingApproval {
                answer_session: request.answer_session.to_string(),
                target_client_id: request.target_client_id.clone(),
                owner_session: request.owner_session.clone(),
                owner_graph: request.owner_graph.clone(),
                sender: tx,
            },
        );
        let mut event = json!({
            "type": "agent.approval_request",
            // Where the answer goes. Kept for display and for older clients;
            // `agent_approval_response` is keyed on `requestId` alone.
            "sessionId": request.answer_session,
            // The one window that may answer. Always present; `null` means no
            // window is attached, and the client must show nothing rather than
            // a card it cannot answer. A *missing* field means a core older
            // than this change, which the client distinguishes.
            "targetClientId": request.target_client_id,
            // Whose work this is. Display only on the client from here on:
            // routing is `targetClientId`, and leaving a second thing to branch
            // on is how the heuristics grew back the last three times.
            "ownerSession": request.owner_session,
            // Which run raised it. `null` means this is not graph work. A graph
            // node and every agent below it name the graph, so a panel labels
            // the prompt without having to have seen a session id first.
            "ownerGraph": request.owner_graph,
            "requestId": request_id,
            "tool": request.tool,
            "arguments": request.arguments,
            // Core's clock, so the client's TTL stops guessing when this began.
            "raisedAtMs": raised_at_ms,
        });
        if request.asking_session != request.answer_session {
            event["subagentSessionId"] = json!(request.asking_session);
        }
        let _ = self.events.send(event);

        let answer =
            match tokio::time::timeout(std::time::Duration::from_secs(APPROVAL_TIMEOUT_SECS), rx)
                .await
            {
                Ok(Ok(answer)) => answer,
                // Sender dropped without `resolve` — only reachable if the map
                // was torn down. Treat as abandoned, never as denied.
                Ok(Err(_)) => {
                    return ApprovalOutcome::Abandoned(Resolution::SessionGone.outcome());
                }
                Err(_) => {
                    self.resolve(&request_id, Resolution::TimedOut).await;
                    return ApprovalOutcome::Abandoned(Resolution::TimedOut.outcome());
                }
            };
        // A human's answer is the only payload carrying `approved`. Anything
        // else arrived through `resolve` and names its own cause.
        match answer.get("approved").and_then(Value::as_bool) {
            Some(true) => ApprovalOutcome::Approved,
            Some(false) => ApprovalOutcome::Denied,
            None => {
                ApprovalOutcome::Abandoned(match answer.get("abandoned").and_then(Value::as_str) {
                    Some("run-cancelled") => Resolution::RunCancelled.outcome(),
                    Some("core-shutdown") => Resolution::CoreShutdown.outcome(),
                    Some("timed-out") => Resolution::TimedOut.outcome(),
                    _ => Resolution::SessionGone.outcome(),
                })
            }
        }
    }

    /// Answer a request on behalf of `client_id`.
    ///
    /// This is the enforcement point. A request is addressed to exactly one
    /// window; any other window — and any caller that names no window at all —
    /// is refused. Without the refusal the address is decoration: a second
    /// panel that merely ignores the event by convention is one refresh away
    /// from answering it anyway.
    pub async fn respond(
        &self,
        request_id: &str,
        client_id: Option<&str>,
        approved: bool,
    ) -> Result<Value> {
        {
            let pending = self.pending.lock().await;
            let entry = pending
                .get(request_id)
                .ok_or_else(|| anyhow::anyhow!("no pending approval {request_id}"))?;
            match (&entry.target_client_id, client_id) {
                (Some(target), Some(actual)) if target == actual => {}
                (Some(_), _) => {
                    anyhow::bail!("approval {request_id} belongs to another CaliCode window")
                }
                (None, _) => anyhow::bail!(
                    "approval {request_id} has no attached window and cannot be answered"
                ),
            }
        }
        if self
            .resolve(request_id, Resolution::Answered { approved })
            .await
        {
            Ok(json!({ "accepted": true }))
        } else {
            anyhow::bail!("no pending approval {request_id}")
        }
    }

    /// Drop every approval raised by a graph run. Called when the run reaches a
    /// terminal state or is cancelled.
    ///
    /// This is what pays for the client never auto-denying: a walked-away-from
    /// run's prompts die immediately, from the party that actually knows the
    /// run is over, instead of costing 300 seconds per attempt.
    pub async fn cancel_by_graph(&self, graph_id: &str) -> usize {
        let ids: Vec<String> = {
            let pending = self.pending.lock().await;
            pending
                .iter()
                .filter(|(_, entry)| entry.owner_graph.as_deref() == Some(graph_id))
                .map(|(request_id, _)| request_id.clone())
                .collect()
        };
        let mut cancelled = 0;
        for request_id in ids {
            if self.resolve(&request_id, Resolution::RunCancelled).await {
                cancelled += 1;
            }
        }
        cancelled
    }

    /// Drop every approval bound to a session, whether as the answer address or
    /// as the owning panel.
    pub async fn cancel_by_session(&self, session_id: &str) -> usize {
        let ids: Vec<String> = {
            let pending = self.pending.lock().await;
            pending
                .iter()
                .filter(|(_, entry)| {
                    entry.answer_session == session_id
                        || entry.owner_session.as_deref() == Some(session_id)
                })
                .map(|(request_id, _)| request_id.clone())
                .collect()
        };
        let mut cancelled = 0;
        for request_id in ids {
            if self.resolve(&request_id, Resolution::SessionGone).await {
                cancelled += 1;
            }
        }
        cancelled
    }

    /// Is anybody parked on an approval bound to this session?
    ///
    /// Session eviction used to filter victims on `session.pending.is_empty()`.
    /// With approvals out of that map an approval-parked session looks idle, so
    /// eviction has to ask here instead.
    pub async fn waits_on_session(&self, session_id: &str) -> bool {
        self.pending.lock().await.values().any(|entry| {
            entry.answer_session == session_id || entry.owner_session.as_deref() == Some(session_id)
        })
    }

    /// Number of requests currently waiting. Test/diagnostic use only.
    pub async fn pending_count(&self) -> usize {
        self.pending.lock().await.len()
    }

    /// Remove a request and announce how it ended. The single exit from the
    /// map — every other method funnels here so no path can leave without a
    /// broadcast.
    async fn resolve(&self, request_id: &str, resolution: Resolution) -> bool {
        let entry = self.pending.lock().await.remove(request_id);
        let Some(entry) = entry else {
            return false;
        };
        let _ = entry.sender.send(resolution.payload());
        let _ = self.events.send(json!({
            "type": "agent.approval_resolved",
            "requestId": request_id,
            "outcome": resolution.outcome(),
            "sessionId": entry.answer_session,
            "ownerSession": entry.owner_session,
            "ownerGraph": entry.owner_graph,
            "targetClientId": entry.target_client_id,
        }));
        true
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approvals() -> (Approvals, broadcast::Receiver<Value>) {
        let (tx, rx) = broadcast::channel(64);
        (Approvals::new(tx), rx)
    }

    fn request<'a>(answer_session: &'a str, client: Option<&str>) -> ApprovalRequest<'a> {
        ApprovalRequest {
            answer_session,
            target_client_id: client.map(str::to_string),
            owner_session: Some(answer_session.to_string()),
            owner_graph: None,
            asking_session: answer_session,
            tool: "file_write",
            arguments: json!({ "path": "a.txt" }),
        }
    }

    async fn next_request_id(rx: &mut broadcast::Receiver<Value>) -> String {
        loop {
            let event = rx.recv().await.expect("event");
            if event["type"] == "agent.approval_request" {
                return event["requestId"].as_str().unwrap().to_string();
            }
        }
    }

    /// Defect 3. The direct port of `editor_bridge`'s
    /// `foreign_client_cannot_steal_a_pending_request`: the address is only
    /// worth having if the wrong window is refused, not merely expected to
    /// behave.
    #[tokio::test]
    async fn foreign_client_cannot_answer_an_addressed_approval() {
        let (approvals, mut rx) = approvals();
        let waiter = {
            let approvals = approvals.clone();
            tokio::spawn(async move {
                approvals
                    .request(request("session-a", Some("window-a")))
                    .await
            })
        };
        let request_id = next_request_id(&mut rx).await;

        let stolen = approvals
            .respond(&request_id, Some("window-b"), true)
            .await
            .expect_err("a foreign window must be refused");
        assert!(
            stolen.to_string().contains("another CaliCode window"),
            "unexpected refusal: {stolen}"
        );
        // And the refusal must not have consumed the request.
        approvals
            .respond(&request_id, Some("window-a"), true)
            .await
            .expect("the addressed window still answers");
        assert_eq!(waiter.await.unwrap(), ApprovalOutcome::Approved);
    }

    #[tokio::test]
    async fn an_unaddressed_approval_cannot_be_answered_by_anyone() {
        let (approvals, mut rx) = approvals();
        let waiter = {
            let approvals = approvals.clone();
            tokio::spawn(async move { approvals.request(request("session-a", None)).await })
        };
        let request_id = next_request_id(&mut rx).await;

        for client in [None, Some("window-a"), Some("window-b")] {
            let refused = approvals
                .respond(&request_id, client, true)
                .await
                .expect_err("an unaddressed approval is answerable by nobody");
            assert!(
                refused.to_string().contains("no attached window"),
                "unexpected refusal: {refused}"
            );
        }
        assert_eq!(approvals.cancel_by_session("session-a").await, 1);
        assert!(matches!(
            waiter.await.unwrap(),
            ApprovalOutcome::Abandoned("session-gone")
        ));
    }

    /// A cancelled run's approvals must not read as denials anywhere: the
    /// waiter learns `Abandoned`, and the broadcast names the real cause.
    #[tokio::test]
    async fn cancelling_a_run_abandons_its_approvals_without_denying_them() {
        let (approvals, mut rx) = approvals();
        let waiter = {
            let approvals = approvals.clone();
            tokio::spawn(async move {
                approvals
                    .request(ApprovalRequest {
                        owner_graph: Some("graph-1".into()),
                        ..request("session-a", Some("window-a"))
                    })
                    .await
            })
        };
        let request_id = next_request_id(&mut rx).await;

        assert_eq!(approvals.cancel_by_graph("graph-1").await, 1);
        assert_eq!(
            waiter.await.unwrap(),
            ApprovalOutcome::Abandoned("run-cancelled")
        );

        let resolved = loop {
            let event = rx.recv().await.expect("event");
            if event["type"] == "agent.approval_resolved" {
                break event;
            }
        };
        assert_eq!(resolved["requestId"], json!(request_id));
        assert_eq!(resolved["outcome"], json!("run-cancelled"));
    }

    #[tokio::test]
    async fn cancel_by_graph_leaves_other_runs_alone() {
        let (approvals, mut rx) = approvals();
        for graph in ["graph-1", "graph-2"] {
            let approvals = approvals.clone();
            let graph = graph.to_string();
            tokio::spawn(async move {
                approvals
                    .request(ApprovalRequest {
                        owner_graph: Some(graph),
                        ..request("session-a", Some("window-a"))
                    })
                    .await
            });
        }
        let _ = next_request_id(&mut rx).await;
        let _ = next_request_id(&mut rx).await;
        assert_eq!(approvals.cancel_by_graph("graph-1").await, 1);
        assert_eq!(approvals.pending_count().await, 1);
    }

    #[tokio::test]
    async fn a_denial_is_reported_as_a_denial_and_nothing_else_is() {
        let (approvals, mut rx) = approvals();
        let waiter = {
            let approvals = approvals.clone();
            tokio::spawn(async move {
                approvals
                    .request(request("session-a", Some("window-a")))
                    .await
            })
        };
        let request_id = next_request_id(&mut rx).await;
        approvals
            .respond(&request_id, Some("window-a"), false)
            .await
            .expect("the addressed window may deny");
        assert_eq!(waiter.await.unwrap(), ApprovalOutcome::Denied);
    }

    #[tokio::test]
    async fn waits_on_session_sees_both_the_answer_address_and_the_owner() {
        let (approvals, mut rx) = approvals();
        {
            let approvals = approvals.clone();
            tokio::spawn(async move {
                approvals
                    .request(ApprovalRequest {
                        owner_session: Some("session-owner".into()),
                        ..request("session-answer", Some("window-a"))
                    })
                    .await
            });
        }
        let _ = next_request_id(&mut rx).await;
        assert!(approvals.waits_on_session("session-answer").await);
        assert!(approvals.waits_on_session("session-owner").await);
        assert!(!approvals.waits_on_session("session-other").await);
    }

    #[test]
    fn every_resolution_has_a_distinct_wire_spelling() {
        let all = [
            Resolution::Answered { approved: true },
            Resolution::Answered { approved: false },
            Resolution::TimedOut,
            Resolution::RunCancelled,
            Resolution::SessionGone,
            Resolution::CoreShutdown,
        ];
        let mut seen = std::collections::HashSet::new();
        for resolution in all {
            assert!(
                seen.insert(resolution.outcome()),
                "duplicate outcome spelling for {resolution:?}"
            );
        }
        assert_eq!(seen.len(), 6);
    }
}
