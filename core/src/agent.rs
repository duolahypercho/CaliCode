use crate::model::{self, ToolCall};
use crate::tools::{core_tool_defs, execute_core_tool, to_openai_schema, ToolDef};
use crate::AppState;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

#[derive(Clone)]
pub struct AgentManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<AgentSession>>>>>,
    events: tokio::sync::broadcast::Sender<Value>,
}

pub struct AgentSession {
    pub id: String,
    pub messages: Vec<Value>,
    pub pending: HashMap<String, oneshot::Sender<Value>>,
}

#[derive(Clone, Default)]
pub struct AgentOptions {
    pub permission_mode: String,
    pub max_turns: usize,
    pub system: Option<String>,
    pub project_slug: Option<String>,
}

impl AgentManager {
    pub fn new(events: tokio::sync::broadcast::Sender<Value>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            events,
        }
    }

    pub async fn chat(
        &self,
        state: &AppState,
        registered_tools: &HashMap<String, ToolDef>,
        session_id: Option<&str>,
        messages: &[Value],
        options: AgentOptions,
    ) -> Result<Value> {
        let session = self.get_or_create(session_id).await?;
        let sid = session.lock().await.id.clone();
        let mut guard = session.lock().await;
        if options.system.is_some() && guard.messages.is_empty() {
            guard.messages.push(json!({
                "role": "system",
                "content": options.system.clone().unwrap_or_default()
            }));
        }
        for message in messages {
            guard.messages.push(message.clone());
        }
        let mut turns = 0usize;
        let max_turns = options.max_turns.clamp(1, 30);
        let tool_calls_log: Vec<Value> = Vec::new();

        loop {
            if turns >= max_turns {
                break;
            }
            turns += 1;
            let defs = self.build_tools(registered_tools);
            let schemas: Vec<Value> = defs.iter().map(to_openai_schema).collect();
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            let bus = self.events.clone();
            let sid_for_delta = sid.clone();
            tokio::spawn(async move {
                while let Some(delta) = rx.recv().await {
                    let _ = bus.send(json!({
                        "type": "agent.delta",
                        "sessionId": sid_for_delta,
                        "delta": delta
                    }));
                }
            });
            let config = state.config.read().await;
            let result = model::chat(&*config, &guard.messages, Some(&schemas), Some(&tx)).await?;
            drop(config);
            drop(tx);
            if result.content.is_empty() && result.tool_calls.is_empty() {
                guard
                    .messages
                    .push(json!({ "role": "assistant", "content": "I could not produce a response." }));
                break;
            }

            if result.tool_calls.is_empty() {
                guard
                    .messages
                    .push(json!({ "role": "assistant", "content": result.content }));
                return Ok(json!({
                    "sessionId": sid,
                    "reply": result.content,
                    "toolCalls": tool_calls_log,
                    "turns": turns
                }));
            }

            guard.messages.push(json!({
                "role": "assistant",
                "content": result.content,
                "tool_calls": result.tool_calls.iter().map(assistant_tool_call).collect::<Vec<_>>()
            }));

            for call in &result.tool_calls {
                let _ = self.events.send(json!({
                    "type": "agent.tool_started",
                    "sessionId": sid,
                    "tool": call.name,
                    "arguments": call.arguments
                }));
                let outcome = self
                    .execute_tool_call(
                        state,
                        registered_tools,
                        &mut guard,
                        &sid,
                        call,
                        &options,
                    )
                    .await;
                let outcome = match outcome {
                    Ok(value) => value,
                    Err(error) => json!({ "error": error.to_string() }),
                };
                guard
                    .messages
                    .push(json!({ "role": "tool", "tool_call_id": call.id, "content": outcome.to_string() }));
                let _ = self.events.send(json!({
                    "type": "agent.tool_finished",
                    "sessionId": sid,
                    "tool": call.name,
                    "result": outcome
                }));
            }
        }

        let last = guard
            .messages
            .iter()
            .rev()
            .find(|m| m["role"] == "assistant")
            .and_then(|m| m["content"].as_str())
            .unwrap_or("Turn limit reached");
        Ok(json!({
            "sessionId": sid,
            "reply": last,
            "toolCalls": tool_calls_log,
            "turns": turns
        }))
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

    pub async fn submit_approval(
        &self,
        session_id: &str,
        request_id: &str,
        approved: bool,
    ) -> Result<Value> {
        let session = self.session(session_id).await?;
        let mut guard = session.lock().await;
        if let Some(tx) = guard.pending.remove(request_id) {
            let _ = tx.send(json!({ "approved": approved }));
            Ok(json!({ "accepted": true }))
        } else {
            anyhow::bail!("no pending approval {}", request_id)
        }
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
        let id = format!("session-{}", Uuid::new_v4().simple());
        let session = Arc::new(Mutex::new(AgentSession {
            id: id.clone(),
            messages: Vec::new(),
            pending: HashMap::new(),
        }));
        guard.insert(id, session.clone());
        Ok(session)
    }

    async fn session(&self, session_id: &str) -> Result<Arc<Mutex<AgentSession>>> {
        let guard = self.sessions.lock().await;
        guard
            .get(session_id)
            .cloned()
            .context("session not found")
    }

    fn build_tools(&self, registered: &HashMap<String, ToolDef>) -> Vec<ToolDef> {
        let mut defs = core_tool_defs();
        defs.extend(registered.values().cloned());
        defs
    }

    async fn execute_tool_call(
        &self,
        state: &AppState,
        registered: &HashMap<String, ToolDef>,
        session: &mut AgentSession,
        sid: &str,
        call: &ToolCall,
        options: &AgentOptions,
    ) -> Result<Value> {
        let core_def = core_tool_defs().into_iter().find(|d| d.name == call.name);
        let def = if let Some(def) = core_def {
            def
        } else {
            registered.get(&call.name).cloned().context("tool not registered")?
        };

        if requires_approval(&options.permission_mode, &def.name) {
            let request_id = format!("approval-{}", Uuid::new_v4().simple());
            let (tx, rx) = oneshot::channel();
            session.pending.insert(request_id.clone(), tx);
            let _ = self.events.send(json!({
                "type": "agent.approval_request",
                "sessionId": sid,
                "requestId": request_id,
                "tool": def.name,
                "arguments": call.arguments
            }));
            let response = tokio::time::timeout(std::time::Duration::from_secs(300), rx)
                .await
                .context("approval timed out")?
                .context("approval channel closed")?;
            if response.get("approved").and_then(|v| v.as_bool()).unwrap_or(false) == false {
                anyhow::bail!("approval denied for {}", def.name);
            }
        }

        if def.kind == crate::tools::ToolKind::Core {
            return execute_core_tool(&def, &call.arguments, state, &state.projects_root).await;
        }

        let request_id = format!("tool-{}", Uuid::new_v4().simple());
        let (tx, rx) = oneshot::channel();
        session.pending.insert(request_id.clone(), tx);
        let _ = self.events.send(json!({
            "type": "agent.tool_request",
            "sessionId": sid,
            "requestId": request_id,
            "tool": def.name,
            "arguments": call.arguments
        }));
        tokio::time::timeout(std::time::Duration::from_secs(300), rx)
            .await
            .context("browser tool timed out")?
            .context("browser tool channel closed")
    }
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

fn requires_approval(mode: &str, tool: &str) -> bool {
    match mode {
        "supervised" => true,
        "auto-accept-edits" => tool == "project.revert" || tool.starts_with("image3d."),
        _ => false,
    }
}
