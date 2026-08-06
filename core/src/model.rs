use crate::config::{api_key, AppConfig};
use anyhow::{Context, Result};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone)]
pub struct ChatResult {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
}

pub async fn chat(
    config: &AppConfig,
    messages: &[Value],
    tools: Option<&[Value]>,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<String>>,
) -> Result<ChatResult> {
    let key = if config.model.provider == crate::config::CODEX_ROUTER_PROVIDER_ID {
        crate::config::router_key()
    } else {
        api_key(config)
    };
    if key.is_empty() && !config.model.base_url.contains("127.0.0.1") {
        anyhow::bail!(
            "model key is not configured; set {} and restart core",
            config.model.api_key_env
        );
    }
    let url = format!("{}/chat/completions", config.model.base_url.trim_end_matches('/'));
    let mut body = json!({
        "model": config.model.default,
        "messages": messages,
        "stream": true,
        "temperature": config.model.temperature
    });
    if let Some(max_tokens) = config.model.max_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    if let Some(tools) = tools {
        if !tools.is_empty() {
            body["tools"] = json!(tools);
            body["tool_choice"] = "auto".into();
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()?;
    let mut request = client.post(&url).json(&body);
    if !key.is_empty() {
        request = request.bearer_auth(&key);
    }
    let response = request
        .send()
        .await
        .with_context(|| format!("model request failed for {}", config.model.default))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        anyhow::bail!("model returned {status}: {}", truncate(&text, 500));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut content = String::new();
    let mut tool_calls: Vec<InFlightTool> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("stream read failed")?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].to_string();
            buffer.drain(..=pos);
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data == "[DONE]" {
                    break;
                }
                if let Ok(payload) = serde_json::from_str::<Value>(data) {
                    if let Some(delta) = payload["choices"][0]["delta"].as_object() {
                        if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
                            content.push_str(text);
                            if let Some(tx) = delta_tx {
                                let _ = tx.send(text.to_string());
                            }
                        }
                        if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                            for call in calls {
                                let index = call["index"].as_u64().unwrap_or(0) as usize;
                                if tool_calls.len() <= index {
                                    tool_calls.resize(index + 1, InFlightTool::default());
                                }
                                let slot = &mut tool_calls[index];
                                if let Some(id) = call["id"].as_str() {
                                    slot.id = id.to_string();
                                }
                                if let Some(name) = call["function"]["name"].as_str() {
                                    slot.name = name.to_string();
                                }
                                if let Some(args) = call["function"]["arguments"].as_str() {
                                    slot.arguments.push_str(args);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let tool_calls: Vec<ToolCall> = tool_calls
        .into_iter()
        .filter(|t| !t.name.is_empty())
        .map(|t| ToolCall {
            id: if t.id.is_empty() { format!("call-{}", t.arguments.len()) } else { t.id },
            name: t.name,
            arguments: serde_json::from_str(&t.arguments).unwrap_or(Value::Null),
        })
        .collect();

    Ok(ChatResult {
        content: content.trim().to_string(),
        tool_calls,
    })
}

#[derive(Clone, Default)]
struct InFlightTool {
    id: String,
    name: String,
    arguments: String,
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        text.to_string()
    } else {
        format!("{}...", &text[..max])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ModelConfig;
    use axum::routing::post;
    use axum::Router;
    use axum::response::sse::{Event, Sse};
    use std::convert::Infallible;

    #[test]
    fn tool_call_parse() {
        let payload = json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call-1",
                        "function": { "name": "project_list", "arguments": "{}" }
                    }]
                }
            }]
        });
        let delta = payload["choices"][0]["delta"].clone();
        assert_eq!(delta["tool_calls"][0]["function"]["name"], "project_list");
    }

    #[tokio::test]
    async fn chat_streams_from_mock_provider() {
        let app = Router::new().route("/v1/chat/completions", post(mock_chat));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let config = AppConfig {
            model: ModelConfig {
                default: "mock-model".into(),
                provider: "mock".into(),
                base_url: format!("http://{}/v1", addr),
                api_key_env: "CALI_MOCK_KEY".into(),
                temperature: 0.0,
                max_tokens: Some(32),
            },
            providers: vec![],
            projects_dir: None,
        };
        let result = chat(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
        )
        .await
        .unwrap();
        assert!(result.content.contains("Hello from CaliCode"));
        assert!(result.tool_calls.is_empty());
    }

    async fn mock_chat() -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let events = vec![
            Ok(Event::default().data(r#"{"choices":[{"delta":{"role":"assistant","content":"Hello "}}]}"#)),
            Ok(Event::default().data(r#"{"choices":[{"delta":{"content":"from CaliCode"}}]}"#)),
            Ok(Event::default().data("[DONE]")),
        ];
        Sse::new(futures::stream::iter(events))
    }
}
