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
        let current_session_id = {
            let guard = session.lock().await;
            guard.id.clone()
        };
        {
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
        }
        let mut turns = 0usize;
        let max_turns = options.max_turns.clamp(1, 30);
        let mut tool_calls_log: Vec<Value> = Vec::new();

        loop {
            if turns >= max_turns {
                break;
            }
            turns += 1;
            let defs = self.build_tools(registered_tools);
            let schemas: Vec<Value> = defs.iter().map(to_openai_schema).collect();
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            let bus = self.events.clone();
            let sid_for_delta = current_session_id.clone();
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
            let snapshot = {
                let guard = session.lock().await;
                guard.messages.clone()
            };
            let result = model::chat(&*config, &snapshot, Some(&schemas), Some(&tx)).await?;
            drop(config);
            drop(tx);
            if result.content.is_empty() && result.tool_calls.is_empty() {
                let mut guard = session.lock().await;
                guard.messages.push(json!({ "role": "assistant", "content": "I could not produce a response." }));
                break;
            }

            if result.tool_calls.is_empty() {
                {
                    let mut guard = session.lock().await;
                    guard.messages.push(json!({ "role": "assistant", "content": result.content.clone() }));
                }
                return Ok(json!({
                    "sessionId": current_session_id,
                    "reply": result.content,
                    "toolCalls": tool_calls_log,
                    "turns": turns
                }));
            }

            {
                let mut guard = session.lock().await;
                guard.messages.push(json!({
                    "role": "assistant",
                    "content": result.content,
                    "tool_calls": result.tool_calls.iter().map(assistant_tool_call).collect::<Vec<_>>()
                }));
            }

            for call in &result.tool_calls {
                tool_calls_log.push(json!({
                    "name": call.name,
                    "arguments": call.arguments,
                    "id": call.id
                }));
                let _ = self.events.send(json!({
                    "type": "agent.tool_started",
                    "sessionId": current_session_id,
                    "tool": call.name,
                    "arguments": call.arguments
                }));
                let outcome = self
                    .execute_tool_call(
                        state,
                        registered_tools,
                        &session,
                        &current_session_id,
                        call,
                        &options,
                    )
                    .await;
                let outcome = match outcome {
                    Ok(value) => value,
                    Err(error) => json!({ "error": error.to_string() }),
                };
                {
                    let mut guard = session.lock().await;
                    guard.messages.push(json!({ "role": "tool", "tool_call_id": call.id, "content": outcome.to_string() }));
                }
                let _ = self.events.send(json!({
                    "type": "agent.tool_finished",
                    "sessionId": current_session_id,
                    "tool": call.name,
                    "result": outcome
                }));
            }
        }

        let last = {
            let guard = session.lock().await;
            guard
                .messages
                .iter()
                .rev()
                .find(|m| m["role"] == "assistant")
                .and_then(|m| m["content"].as_str())
                .unwrap_or("Turn limit reached")
                .to_string()
        };
        Ok(json!({
            "sessionId": current_session_id,
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
        session: &Arc<Mutex<AgentSession>>,
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
            {
                let mut guard = session.lock().await;
                guard.pending.insert(request_id.clone(), tx);
            }
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
        {
            let mut guard = session.lock().await;
            guard.pending.insert(request_id.clone(), tx);
        }
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
        "auto-accept-edits" => tool == "project_revert" || tool.starts_with("image3d_"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AppConfig, ModelConfig};
    use axum::extract::State;
    use axum::response::sse::{Event, Sse};
    use axum::routing::post;
    use axum::Router;
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn mock_chat_stream(has_tool_result: bool) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let events = if has_tool_result {
            vec![
                Ok(Event::default().data(r#"{"choices":[{"delta":{"role":"assistant","content":"Echo: "}}]}"#)),
                Ok(Event::default().data(r#"{"choices":[{"delta":{"content":"hello-agent"}}]}"#)),
                Ok(Event::default().data("[DONE]")),
            ]
        } else {
            vec![
                Ok(Event::default().data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"editor_echo","arguments":"{\"message\":\"hello-agent\"}"}}]}}]}"#)),
                Ok(Event::default().data(r#"{"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}]}"#)),
                Ok(Event::default().data("[DONE]")),
            ]
        };
        Sse::new(futures::stream::iter(events))
    }

    async fn mock_provider(
        State(calls): State<Arc<AtomicUsize>>,
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let has_tool_result = body
            .get("messages")
            .and_then(|m| m.as_array())
            .map(|messages| messages.iter().any(|m| m["role"] == "tool"))
            .unwrap_or(false);
        calls.fetch_add(1, Ordering::SeqCst);
        mock_chat_stream(has_tool_result)
    }

    #[tokio::test]
    async fn browser_tool_loop_completes() {
        let app = Router::new()
            .route("/v1/chat/completions", post(mock_provider))
            .with_state(Arc::new(AtomicUsize::new(0)));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let config = AppConfig {
            model: ModelConfig {
                default: "mock".into(),
                provider: "mock".into(),
                base_url: format!("http://{}/v1", addr),
                api_key_env: "CALI_MOCK_KEY".into(),
                temperature: 0.0,
                max_tokens: Some(128),
            },
            providers: vec![],
            projects_dir: None,
        };
        let (bus, _) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::from([(
            "editor_echo".to_string(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}),
                kind: crate::tools::ToolKind::Browser,
            },
        )]);
        let state = crate::AppState {
            config: std::sync::Arc::new(tokio::sync::RwLock::new(config)),
            projects_root: tempfile::tempdir().unwrap().path().to_path_buf(),
            agents: agents.clone(),
            bus: bus.clone(),
            tools: std::sync::Arc::new(tokio::sync::RwLock::new(tools.clone())),
        };

        let responder_agents = agents.clone();
        let responder = tokio::spawn(async move {
            let mut rx = bus.subscribe();
            while let Ok(event) = rx.recv().await {
                if event["type"] == "agent.tool_request" {
                    let session_id = event["sessionId"].as_str().unwrap().to_string();
                    let request_id = event["requestId"].as_str().unwrap().to_string();
                    responder_agents
                        .submit_tool_result(&session_id, &request_id, json!({ "message": "hello-agent" }))
                        .await
                        .unwrap();
                }
            }
        });

        let options = AgentOptions {
            permission_mode: "full-access".into(),
            max_turns: 5,
            system: None,
            project_slug: None,
        };
        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "call editor_echo" })],
                options,
            )
            .await
            .unwrap();
        assert_eq!(result["toolCalls"].as_array().unwrap().len(), 1);
        assert!(result["reply"].as_str().unwrap().contains("hello-agent"));
        responder.abort();
    }

    #[tokio::test]
    async fn supervised_approval_flow_completes() {
        let app = Router::new()
            .route("/v1/chat/completions", post(mock_provider))
            .with_state(Arc::new(AtomicUsize::new(0)));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let config = AppConfig {
            model: ModelConfig {
                default: "mock".into(),
                provider: "mock".into(),
                base_url: format!("http://{}/v1", addr),
                api_key_env: "CALI_MOCK_KEY".into(),
                temperature: 0.0,
                max_tokens: Some(128),
            },
            providers: vec![],
            projects_dir: None,
        };
        let (bus, _) = tokio::sync::broadcast::channel(64);
        let agents = AgentManager::new(bus.clone());
        let tools = HashMap::from([(
            "editor_echo".to_string(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}),
                kind: crate::tools::ToolKind::Browser,
            },
        )]);
        let state = crate::AppState {
            config: std::sync::Arc::new(tokio::sync::RwLock::new(config)),
            projects_root: tempfile::tempdir().unwrap().path().to_path_buf(),
            agents: agents.clone(),
            bus: bus.clone(),
            tools: std::sync::Arc::new(tokio::sync::RwLock::new(tools.clone())),
        };

        let responder_agents = agents.clone();
        let responder = tokio::spawn(async move {
            let mut rx = bus.subscribe();
            while let Ok(event) = rx.recv().await {
                if event["type"] == "agent.approval_request" {
                    let session_id = event["sessionId"].as_str().unwrap().to_string();
                    let request_id = event["requestId"].as_str().unwrap().to_string();
                    responder_agents
                        .submit_approval(&session_id, &request_id, true)
                        .await
                        .unwrap();
                }
                if event["type"] == "agent.tool_request" {
                    let session_id = event["sessionId"].as_str().unwrap().to_string();
                    let request_id = event["requestId"].as_str().unwrap().to_string();
                    responder_agents
                        .submit_tool_result(&session_id, &request_id, json!({ "message": "hello-agent" }))
                        .await
                        .unwrap();
                }
            }
        });

        let options = AgentOptions {
            permission_mode: "supervised".into(),
            max_turns: 5,
            system: None,
            project_slug: None,
        };
        let result = agents
            .chat(
                &state,
                &tools,
                None,
                &[json!({ "role": "user", "content": "call editor_echo" })],
                options,
            )
            .await
            .unwrap();
        assert_eq!(result["toolCalls"].as_array().unwrap().len(), 1);
        assert!(result["reply"].as_str().unwrap().contains("hello-agent"));
        responder.abort();
    }
}
