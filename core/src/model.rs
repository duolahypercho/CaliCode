use crate::config::{api_key, AppConfig};
use anyhow::Result;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// Token usage reported by the provider for one completed request.
/// OpenAI-compatible providers send it in a final SSE chunk when the
/// request sets `stream_options: {"include_usage": true}`; providers that
/// ignore that option simply never produce it, so it is always optional.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Usage {
    /// Uncached prompt tokens reported by the provider. OpenAI-compatible
    /// APIs include cache reads/writes in `prompt_tokens`, so parsing removes
    /// them here and keeps each class disjoint.
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// Prompt tokens served from the provider's prefix cache.
    #[serde(default)]
    pub cache_read_tokens: u64,
    /// Prompt tokens inserted into a provider cache, when reported.
    #[serde(default)]
    pub cache_write_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone)]
pub struct ChatResult {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    /// `None` when the provider did not report usage for this request.
    pub usage: Option<Usage>,
}

/// Backoff before each retry attempt: three retries after the initial
/// request, at 250ms / 1s / 4s. Only transient failures (429, 5xx,
/// connect/timeout, pre-content stream drop) are retried — see
/// `AttemptError::retryable`.
const RETRY_BACKOFF_MS: [u64; 3] = [250, 1000, 4000];

/// Ceiling on one streamed completion. Long by HTTP standards on purpose: a
/// reasoning model with a large tool payload can stream for minutes.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// The one HTTP client every model attempt shares.
///
/// `reqwest::Client` owns the connection pool, so the previous
/// build-per-attempt threw the pool away each time: every turn, and every
/// retry inside a turn, paid a fresh DNS lookup and TLS handshake against the
/// same provider host. Built once here and handed out by reference, so
/// keep-alive connections survive across turns, retries, and provider
/// fallbacks. The builder can fail (TLS backend init), so the result is
/// cached too rather than panicking at first use.
fn http_client() -> Result<&'static reqwest::Client, AttemptError> {
    static CLIENT: std::sync::OnceLock<std::result::Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .map_err(|err| err.to_string())
        })
        .as_ref()
        .map_err(|err| AttemptError::fatal(anyhow::anyhow!("http client unavailable: {err}")))
}

/// One piece of a live model stream, tagged with which of the two streams it
/// belongs to.
///
/// Reasoning is display-only. It must stay distinguishable all the way to the
/// caller because it may never be appended to `ChatResult::content`, written
/// into the transcript, or replayed into a later request — providers charge
/// for it once and reject it as input, and a user reading the assistant
/// message must not see the model's private deliberation inside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamChunk {
    Content(String),
    Reasoning(String),
}

/// A single-attempt failure, tagged with whether retrying could help.
/// 4xx auth/validation errors and mid-stream failures (content already
/// forwarded to the caller) are never retryable.
struct AttemptError {
    retryable: bool,
    error: anyhow::Error,
    /// What the provider asked us to wait, from `Retry-After` /
    /// `retry-after-ms`. `None` means it did not say and the fixed backoff
    /// decides.
    retry_after: Option<std::time::Duration>,
}

/// Force every tool call in one response to carry a distinct id.
///
/// The agent loop answers each call with a `tool` message keyed by
/// `tool_call_id`. Two calls sharing an id therefore produce two answers to
/// one question, which providers reject for the *whole* request — so the
/// session is stuck until somebody edits the transcript by hand.
///
/// Both halves of that are real here. A provider can repeat an id, and the
/// empty-id fallback used to be `call-<argument length>`, which manufactures
/// collisions on its own: two `file_read` calls whose arguments happen to be
/// the same length got the same id. Position is used instead, which is unique
/// by construction.
///
/// Renaming is safe because these ids are opaque routing labels — nothing
/// resolves them against the provider, they only pair a call with its result
/// inside our transcript.
fn uniquify_tool_call_ids(calls: &mut [ToolCall]) {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (index, call) in calls.iter_mut().enumerate() {
        if call.id.trim().is_empty() {
            call.id = format!("call-{index}");
        }
        if seen.insert(call.id.clone()) {
            continue;
        }
        // Suffix until free. Bounded by the number of calls in one response.
        let base = call.id.clone();
        let mut attempt = 2usize;
        loop {
            let candidate = format!("{base}-{attempt}");
            if seen.insert(candidate.clone()) {
                tracing::warn!(
                    duplicate = %base,
                    replacement = %candidate,
                    "provider repeated a tool call id; renaming so the turn survives"
                );
                call.id = candidate;
                break;
            }
            attempt += 1;
        }
    }
}

/// Longest a provider may park a turn by asking.
///
/// A `Retry-After` is a request, not an instruction we owe unbounded
/// obedience to: a gateway answering "wait an hour" would otherwise hold a
/// turn open for an hour with the user watching a spinner. Past this the
/// fixed backoff runs instead and the attempt is allowed to fail normally.
const MAX_RETRY_AFTER: std::time::Duration = std::time::Duration::from_secs(30);

/// Parse `Retry-After` (delay-seconds) and the `retry-after-ms` some gateways
/// send instead.
///
/// HTTP-date form is deliberately unsupported: it needs a clock the machine
/// may have wrong, and every provider seen in the wild sends the numeric form.
/// Unparseable means "did not say", which falls back to the fixed backoff
/// rather than guessing.
fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<std::time::Duration> {
    // Finiteness is checked before clamping, not after: `"NaN"` and `"inf"`
    // both parse as `f64`, and `f64::max` *sanitises* NaN to the other operand
    // — so a guard placed after the clamp can never fire, and a malformed
    // header would quietly become "retry immediately".
    let numeric = |text: &str| -> Option<f64> {
        let parsed = text.trim().parse::<f64>().ok()?;
        parsed.is_finite().then_some(parsed.max(0.0))
    };
    let millis = headers
        .get("retry-after-ms")
        .and_then(|value| value.to_str().ok())
        .and_then(numeric);
    let seconds = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(numeric)
        .map(|secs| secs * 1000.0);
    let ms = millis.or(seconds)?;
    Some(std::time::Duration::from_millis(ms as u64).min(MAX_RETRY_AFTER))
}

impl AttemptError {
    fn transient(error: anyhow::Error) -> Self {
        Self {
            retry_after: None,
            retryable: true,
            error,
        }
    }

    fn fatal(error: anyhow::Error) -> Self {
        Self {
            retryable: false,
            error,
            // Never retried, so a wait would never be honoured anyway.
            retry_after: None,
        }
    }
}

pub async fn chat(
    config: &AppConfig,
    messages: &[Value],
    tools: Option<&[Value]>,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
) -> Result<ChatResult> {
    chat_with_session(config, messages, tools, delta_tx, None).await
}

/// Chat with a stable provider cache-affinity key.
///
/// The id does not replace the transcript: OpenAI-style prompt caches match
/// the unchanged prefix, while the key keeps successive calls for one agent
/// session routed to the same cache namespace. Standalone summaries and
/// visual reviews pass `None`, because their prompts are not reused.
pub async fn chat_with_session(
    config: &AppConfig,
    messages: &[Value],
    tools: Option<&[Value]>,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
    session_id: Option<&str>,
) -> Result<ChatResult> {
    chat_with_backoff_session(
        config,
        messages,
        tools,
        delta_tx,
        None,
        session_id,
        &RETRY_BACKOFF_MS,
    )
    .await
}

/// Chat with a per-turn reasoning effort override.
///
/// Effort is intentionally request-scoped: switching the picker must not
/// rewrite the persisted provider config or affect another session already
/// running. Providers that do not support the field return their normal
/// validation error, which is surfaced to the caller instead of pretending
/// the selected effort was honored.
/// Request-scoped effort plus a stable provider prompt-cache key.
pub async fn chat_with_effort_session(
    config: &AppConfig,
    messages: &[Value],
    tools: Option<&[Value]>,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
    reasoning_effort: Option<&str>,
    session_id: Option<&str>,
) -> Result<ChatResult> {
    chat_with_backoff_session(
        config,
        messages,
        tools,
        delta_tx,
        reasoning_effort,
        session_id,
        &RETRY_BACKOFF_MS,
    )
    .await
}

/// Make exactly one provider request with no retry or fallback.
///
/// Graph workers use this for their bounded final-response drain after the
/// last tool turn. A drain must not silently consume another model turn while
/// recovering an empty/error response, and it must stay on the same provider
/// session as the work it is reporting.
pub async fn chat_with_effort_session_once(
    config: &AppConfig,
    messages: &[Value],
    tools: Option<&[Value]>,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
    reasoning_effort: Option<&str>,
    session_id: Option<&str>,
) -> Result<ChatResult> {
    chat_once(
        config,
        messages,
        tools,
        delta_tx,
        reasoning_effort,
        session_id,
    )
    .await
    .map_err(|error| error.error)
}

/// `chat` with an injectable backoff schedule (`backoff_ms.len()` retries
/// after the initial attempt). Split out so tests can run the full
/// retry/fallback path without real sleeps.
#[cfg(test)]
async fn chat_with_backoff(
    config: &AppConfig,
    messages: &[Value],
    tools: Option<&[Value]>,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
    backoff_ms: &[u64],
) -> Result<ChatResult> {
    chat_with_backoff_session(config, messages, tools, delta_tx, None, None, backoff_ms).await
}

async fn chat_with_backoff_session(
    config: &AppConfig,
    messages: &[Value],
    tools: Option<&[Value]>,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
    reasoning_effort: Option<&str>,
    session_id: Option<&str>,
    backoff_ms: &[u64],
) -> Result<ChatResult> {
    let mut last = match chat_with_retries(
        config,
        messages,
        tools,
        delta_tx,
        reasoning_effort,
        session_id,
        backoff_ms,
    )
    .await
    {
        Ok(result) => return Ok(result),
        // Non-retryable failures (auth, bad request, mid-stream drop) are
        // real errors the user must see — fallbacks are for transient
        // outages only.
        Err(err) if !err.retryable => return Err(err.error),
        Err(err) => err.error,
    };
    // Turn-scoped fallback chain: each preset id is tried in order with a
    // cloned config, so the active provider in `config.model` is never
    // mutated — the next user message goes back to the primary.
    for preset_id in &config.fallback_providers {
        if *preset_id == config.model.provider {
            continue;
        }
        let Some(fallback) = fallback_config(config, preset_id) else {
            tracing::warn!(provider = %preset_id, "fallback provider not found in presets; skipping");
            continue;
        };
        tracing::warn!(
            provider = %preset_id,
            error = %last,
            "model provider failed after retries; trying fallback"
        );
        match chat_with_retries(
            &fallback,
            messages,
            tools,
            delta_tx,
            reasoning_effort,
            session_id,
            backoff_ms,
        )
        .await
        {
            Ok(result) => return Ok(result),
            Err(err) => last = err.error,
        }
    }
    Err(last)
}

/// Builds the turn-scoped config for one fallback preset. Keeps the current
/// model name when the preset lists it (or lists nothing), otherwise takes
/// the preset's first model.
fn fallback_config(config: &AppConfig, preset_id: &str) -> Option<AppConfig> {
    let preset = config.providers.iter().find(|p| p.id == preset_id)?;
    let mut fallback = config.clone();
    fallback.model.provider = preset.id.clone();
    fallback.model.base_url = preset.base_url.clone();
    fallback.model.api_key_env = preset.api_key_env.clone();
    if !preset.models.is_empty() && !preset.models.contains(&fallback.model.default) {
        fallback.model.default = preset.models[0].clone();
    }
    Some(fallback)
}

async fn chat_with_retries(
    config: &AppConfig,
    messages: &[Value],
    tools: Option<&[Value]>,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
    reasoning_effort: Option<&str>,
    session_id: Option<&str>,
    backoff_ms: &[u64],
) -> Result<ChatResult, AttemptError> {
    let mut attempt = 0usize;
    loop {
        match chat_once(
            config,
            messages,
            tools,
            delta_tx,
            reasoning_effort,
            session_id,
        )
        .await
        {
            // A 200 response with no visible completion is not success. A
            // few OpenAI-compatible proxies occasionally close an otherwise
            // healthy stream after emitting only usage/finish metadata; if
            // we accept that shape the agent loop turns it into a fabricated
            // "I could not produce a response." assistant message and the
            // user loses the actual provider failure. Treat it like any
            // other pre-content transient so the configured retry/fallback
            // path gets a chance to recover it.
            Ok(result) if result.content.trim().is_empty() && result.tool_calls.is_empty() => {
                let err = AttemptError::transient(anyhow::anyhow!(
                    "model returned an empty completion (no content or tool calls) for {}",
                    config.model.default
                ));
                if attempt < backoff_ms.len() {
                    tracing::warn!(
                        attempt = attempt + 1,
                        error = %err.error,
                        "empty model completion; retrying"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_ms[attempt])).await;
                    attempt += 1;
                } else {
                    return Err(err);
                }
            }
            Ok(result) => return Ok(result),
            Err(err) if err.retryable && attempt < backoff_ms.len() => {
                // The provider's own answer wins over our guess. A 429 saying
                // "wait 30s" retried after 250ms spends all three attempts
                // inside five seconds and fails a turn that would have
                // succeeded by waiting once.
                let fixed = std::time::Duration::from_millis(backoff_ms[attempt]);
                let delay = err.retry_after.unwrap_or(fixed);
                tracing::warn!(
                    attempt = attempt + 1,
                    delay_ms = delay.as_millis() as u64,
                    honoured_retry_after = err.retry_after.is_some(),
                    error = %err.error,
                    "transient model error; retrying"
                );
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Err(err) => return Err(err),
        }
    }
}

async fn chat_once(
    config: &AppConfig,
    messages: &[Value],
    tools: Option<&[Value]>,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
    reasoning_effort: Option<&str>,
    session_id: Option<&str>,
) -> Result<ChatResult, AttemptError> {
    let key = if config.model.provider == crate::config::CODEX_ROUTER_PROVIDER_ID {
        crate::config::router_key()
    } else {
        api_key(config)
    };
    if key.is_empty() && !config.model.base_url.contains("127.0.0.1") {
        return Err(AttemptError::fatal(anyhow::anyhow!(
            "model key is not configured; set {} and restart core",
            config.model.api_key_env
        )));
    }
    let cache_retention = resolve_cache_retention();
    if is_codex_router_luna(config) {
        return chat_once_responses(ResponsesRequest {
            config,
            messages,
            tools,
            delta_tx,
            reasoning_effort,
            session_id,
            key: &key,
            cache_retention,
        })
        .await;
    }
    let url = format!(
        "{}/chat/completions",
        config.model.base_url.trim_end_matches('/')
    );
    let capabilities = provider_capabilities(config);
    let supports_cache_key = provider_supports_prompt_cache_key(config);
    // Anthropic traffic carries its own breakpoints; every other provider keeps
    // the caller's messages untouched.
    let marked;
    let messages = if marks_anthropic_cache_control(config) {
        marked = apply_anthropic_cache_control(messages, cache_retention);
        marked.as_slice()
    } else {
        messages
    };
    let mut body = json!({
        "model": codex_router_chat_gateway_model(config),
        "messages": messages,
        "stream": true,
        "temperature": config.model.temperature
    });
    if capabilities.supports_usage_in_stream {
        // Ask known OpenAI-compatible providers to append a final usage chunk
        // to the stream. Unknown gateways often reject this otherwise optional
        // field instead of ignoring it.
        body["stream_options"] = json!({ "include_usage": true });
    }
    if let Some(max_tokens) = config.model.max_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    if let Some(tools) = tools {
        if !tools.is_empty() {
            body["tools"] = json!(tools);
            body["tool_choice"] = "auto".into();
        }
    }
    if let Some(effort) = reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["reasoning_effort"] = json!(effort);
    }
    let cache_session_id = (cache_retention != CacheRetention::None)
        .then_some(session_id)
        .flatten()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let sends_cache_key = cache_session_id.is_some()
        && cache_retention != CacheRetention::None
        && (supports_cache_key
            || (cache_retention == CacheRetention::Long
                && capabilities.supports_long_cache_retention));
    if sends_cache_key {
        // This field is OpenAI-specific. Several services expose an
        // OpenAI-shaped endpoint while rejecting unknown request keys, so
        // provider affinity must never break an otherwise valid model call.
        body["prompt_cache_key"] = json!(clamp_prompt_cache_key(
            cache_session_id.expect("sends_cache_key requires a session id")
        ));
    }
    if cache_retention == CacheRetention::Long && capabilities.supports_long_cache_retention {
        body["prompt_cache_retention"] = json!("24h");
    }

    let mut request = http_client()?.post(&url).json(&body);
    if !key.is_empty() {
        request = request.bearer_auth(&key);
    }
    if let Some(session_id) = cache_session_id {
        match capabilities.session_affinity {
            SessionAffinity::OpenAi => {
                request = request
                    .header("session_id", session_id)
                    .header("x-client-request-id", session_id)
                    .header("x-session-affinity", session_id);
            }
            SessionAffinity::OpenRouter => {
                request = request.header("x-session-id", session_id);
            }
            SessionAffinity::CodexRouter => {
                // The router forwards these two headers to its upstream. It
                // intentionally drops x-session-affinity, so don't depend on
                // that header for router-backed providers.
                request = request
                    .header("session_id", session_id)
                    .header("x-client-request-id", session_id);
            }
            SessionAffinity::None => {}
        }
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            // Connect refusals/resets and timeouts are transient; anything
            // else (builder, redirect policy) will not fix itself.
            let retryable = err.is_connect() || err.is_timeout();
            let error = anyhow::Error::from(err)
                .context(format!("model request failed for {}", config.model.default));
            return Err(AttemptError {
                retryable,
                error,
                // A transport failure never produced a response to ask.
                retry_after: None,
            });
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        // Read before consuming the body: `text()` takes the response.
        let retry_after = parse_retry_after(response.headers());
        let text = response.text().await.unwrap_or_default();
        // 429 and 5xx are transient; other 4xx (auth, validation) are the
        // caller's problem and must never be retried.
        let retryable = status.as_u16() == 429 || status.is_server_error();
        return Err(AttemptError {
            retryable,
            error: anyhow::anyhow!("model returned {status}: {}", truncate(&text, 500)),
            retry_after,
        });
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut content = String::new();
    let mut tool_calls: Vec<InFlightTool> = Vec::new();
    let mut usage: Option<Usage> = None;
    let mut text_filter = VisibleTextFilter::default();
    // Once any delta has been consumed (and possibly forwarded to the
    // caller's stream), a retry would duplicate output — mid-stream
    // failures surface as errors exactly as before.
    let mut received_delta = false;

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                let error = anyhow::Error::from(err).context("stream read failed");
                return Err(if received_delta {
                    AttemptError::fatal(error)
                } else {
                    AttemptError::transient(error)
                });
            }
        };
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
                    apply_payload(
                        &payload,
                        &mut content,
                        &mut tool_calls,
                        &mut usage,
                        &mut text_filter,
                        delta_tx,
                        &mut received_delta,
                    );
                }
            }
        }
    }
    // A few OpenAI-compatible gateways ignore `stream: true` for specific
    // models and return one normal JSON completion, while others omit the
    // final newline from their last SSE frame. In both cases the old parser
    // silently discarded the payload and the agent surfaced an opaque empty
    // response. Parse any trailing data as one last SSE frame or a complete
    // non-stream response before classifying it as empty.
    for line in buffer.split('\n') {
        let data = line
            .strip_prefix("data:")
            .map(str::trim)
            .unwrap_or(line.trim());
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        if let Ok(payload) = serde_json::from_str::<Value>(data) {
            apply_payload(
                &payload,
                &mut content,
                &mut tool_calls,
                &mut usage,
                &mut text_filter,
                delta_tx,
                &mut received_delta,
            );
        }
    }
    append_visible_text(
        text_filter.finish(),
        &mut content,
        delta_tx,
        &mut received_delta,
    );

    let mut tool_calls: Vec<ToolCall> = tool_calls
        .into_iter()
        .filter(|t| !t.name.is_empty())
        .map(|t| ToolCall {
            id: t.id,
            name: t.name,
            arguments: serde_json::from_str(&t.arguments).unwrap_or(Value::Null),
        })
        .collect();
    uniquify_tool_call_ids(&mut tool_calls);

    Ok(ChatResult {
        content: content.trim().to_string(),
        tool_calls,
        usage,
    })
}

/// The router registry uses a gateway id for Responses models. Keep the
/// user-facing bare model id and the provider-prefixed catalog id equivalent.
const CODEX_ROUTER_LUNA_GATEWAY_MODEL: &str = "opencode-go-responses-gpt-5-6-luna";

struct ResponsesRequest<'a> {
    config: &'a AppConfig,
    messages: &'a [Value],
    tools: Option<&'a [Value]>,
    delta_tx: Option<&'a tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
    reasoning_effort: Option<&'a str>,
    session_id: Option<&'a str>,
    key: &'a str,
    cache_retention: CacheRetention,
}

async fn chat_once_responses(request: ResponsesRequest<'_>) -> Result<ChatResult, AttemptError> {
    let ResponsesRequest {
        config,
        messages,
        tools,
        delta_tx,
        reasoning_effort,
        session_id,
        key,
        cache_retention,
    } = request;
    let url = format!("{}/responses", config.model.base_url.trim_end_matches('/'));
    let cache_session_id = (cache_retention != CacheRetention::None)
        .then_some(session_id)
        .flatten()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut body = json!({
        "model": codex_router_luna_gateway_model(&config.model.default),
        "input": responses_input(messages),
        "stream": true,
        "store": false,
        "temperature": config.model.temperature
    });
    if let Some(max_tokens) = config.model.max_tokens {
        body["max_output_tokens"] = json!(max_tokens.max(16));
    }
    if let Some(tools) = tools.filter(|tools| !tools.is_empty()) {
        body["tools"] = json!(responses_tools(tools));
    }
    if let Some(effort) = reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["reasoning"] = json!({
            "effort": effort,
            "summary": "auto"
        });
        body["include"] = json!(["reasoning.encrypted_content"]);
    }

    let capabilities = provider_capabilities(config);
    if let Some(session_id) = cache_session_id {
        if capabilities.supports_prompt_cache_key {
            body["prompt_cache_key"] = json!(clamp_prompt_cache_key(session_id));
        }
    }
    if cache_retention == CacheRetention::Long && capabilities.supports_long_cache_retention {
        body["prompt_cache_retention"] = json!("24h");
    }

    let mut request = http_client()?.post(&url).json(&body);
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    if let Some(session_id) = cache_session_id {
        // Codex Router forwards both headers to its upstream provider and
        // uses them when recording/partitioning a routed session.
        request = request
            .header("session_id", session_id)
            .header("x-client-request-id", session_id);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            let retryable = err.is_connect() || err.is_timeout();
            let error = anyhow::Error::from(err).context(format!(
                "Responses model request failed for {}",
                config.model.default
            ));
            return Err(AttemptError {
                retryable,
                error,
                // A transport failure never produced a response to ask.
                retry_after: None,
            });
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        // Read before `text()` consumes the response, as above.
        let retry_after = parse_retry_after(response.headers());
        let text = response.text().await.unwrap_or_default();
        let retryable = status.as_u16() == 429 || status.is_server_error();
        return Err(AttemptError {
            retryable,
            error: anyhow::anyhow!("model returned {status}: {}", truncate(&text, 500)),
            retry_after,
        });
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut content = String::new();
    let mut tool_calls: Vec<InFlightTool> = Vec::new();
    let mut usage: Option<Usage> = None;
    let mut received_delta = false;
    let mut text_filter = VisibleTextFilter::default();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                let error = anyhow::Error::from(err).context("Responses stream read failed");
                return Err(if received_delta {
                    AttemptError::fatal(error)
                } else {
                    AttemptError::transient(error)
                });
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].to_string();
            buffer.drain(..=pos);
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                if let Ok(payload) = serde_json::from_str::<Value>(data) {
                    if let Some(error) = apply_responses_payload(
                        &payload,
                        &mut content,
                        &mut tool_calls,
                        &mut usage,
                        &mut text_filter,
                        delta_tx,
                        &mut received_delta,
                    ) {
                        return Err(AttemptError::fatal(error));
                    }
                }
            }
        }
    }
    for line in buffer.split('\n') {
        let data = line
            .strip_prefix("data:")
            .map(str::trim)
            .unwrap_or(line.trim());
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        if let Ok(payload) = serde_json::from_str::<Value>(data) {
            if let Some(error) = apply_responses_payload(
                &payload,
                &mut content,
                &mut tool_calls,
                &mut usage,
                &mut text_filter,
                delta_tx,
                &mut received_delta,
            ) {
                return Err(AttemptError::fatal(error));
            }
        }
    }
    append_visible_text(
        text_filter.finish(),
        &mut content,
        delta_tx,
        &mut received_delta,
    );

    let mut tool_calls: Vec<ToolCall> = tool_calls
        .into_iter()
        .filter(|tool| !tool.name.is_empty())
        .map(|tool| ToolCall {
            // The Responses API pairs a call id with an item id; both are
            // needed downstream, so they travel joined.
            id: if tool.id.is_empty() || tool.item_id.is_empty() {
                tool.id
            } else {
                format!("{}|{}", tool.id, tool.item_id)
            },
            name: tool.name,
            arguments: serde_json::from_str(&tool.arguments).unwrap_or(Value::Null),
        })
        .collect();
    uniquify_tool_call_ids(&mut tool_calls);
    Ok(ChatResult {
        content: content.trim().to_string(),
        tool_calls,
        usage,
    })
}

fn codex_router_luna_gateway_model(model: &str) -> &str {
    if is_luna_model(model) {
        CODEX_ROUTER_LUNA_GATEWAY_MODEL
    } else {
        model
    }
}

/// Codex Router exposes flat gateway ids even when the picker/catalog uses a
/// provider-qualified `provider/model` id. Keep that catalog id in CaliCode's
/// config and transcripts, but translate it only at the HTTP boundary.
fn codex_router_chat_gateway_model(config: &AppConfig) -> String {
    if config
        .model
        .provider
        .eq_ignore_ascii_case(crate::config::CODEX_ROUTER_PROVIDER_ID)
    {
        config.model.default.replace('/', "-")
    } else {
        config.model.default.clone()
    }
}

fn responses_input(messages: &[Value]) -> Vec<Value> {
    let mut input = Vec::new();
    for message in messages {
        let role = message["role"].as_str().unwrap_or_default();
        match role {
            "system" => {
                if let Some(text) = message["content"].as_str().filter(|text| !text.is_empty()) {
                    input.push(json!({
                        "role": "developer",
                        "content": [{ "type": "input_text", "text": text }]
                    }));
                }
            }
            "user" | "developer" => {
                let content = responses_input_content(&message["content"]);
                if !content.is_empty() {
                    input.push(json!({
                        "role": role,
                        "content": content
                    }));
                }
            }
            "assistant" => {
                if let Some(text) =
                    response_text(&message["content"]).filter(|text| !text.is_empty())
                {
                    input.push(json!({
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": text }]
                    }));
                }
                if let Some(calls) = message["tool_calls"].as_array() {
                    for call in calls {
                        let function = &call["function"];
                        let raw_id = call["id"].as_str().unwrap_or_default();
                        let (call_id, item_id) = raw_id.split_once('|').map_or_else(
                            || (raw_id, format!("fc_{raw_id}")),
                            |(call_id, item_id)| (call_id, item_id.to_string()),
                        );
                        let name = function["name"].as_str().unwrap_or_default();
                        if name.is_empty() {
                            continue;
                        }
                        let arguments = function["arguments"]
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| function["arguments"].to_string());
                        input.push(json!({
                            "type": "function_call",
                            "id": item_id,
                            "call_id": call_id,
                            "name": name,
                            "arguments": arguments
                        }));
                    }
                }
            }
            "tool" => {
                let call_id = message["tool_call_id"]
                    .as_str()
                    .unwrap_or_default()
                    .split('|')
                    .next()
                    .unwrap_or_default();
                if call_id.is_empty() {
                    continue;
                }
                let output = message["content"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| message["content"].to_string());
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output
                }));
            }
            _ => {}
        }
    }
    input
}

fn responses_input_content(content: &Value) -> Vec<Value> {
    if let Some(text) = content.as_str() {
        return if text.is_empty() {
            Vec::new()
        } else {
            vec![json!({ "type": "input_text", "text": text })]
        };
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| {
            let kind = part["type"].as_str().unwrap_or("text");
            match kind {
                "text" | "input_text" => part["text"]
                    .as_str()
                    .map(|text| json!({ "type": "input_text", "text": text })),
                "image_url" | "input_image" => {
                    let url = part["image_url"]["url"]
                        .as_str()
                        .or_else(|| part["image_url"].as_str())
                        .or_else(|| part["url"].as_str())?;
                    Some(json!({
                        "type": "input_image",
                        "detail": "auto",
                        "image_url": url
                    }))
                }
                _ => None,
            }
        })
        .collect()
}

fn response_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let text = content
        .as_array()?
        .iter()
        .filter_map(|part| part["text"].as_str())
        .collect::<String>();
    Some(text)
}

fn responses_tools(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|tool| {
            if tool["type"].as_str().unwrap_or("function") != "function" {
                return Some(tool.clone());
            }
            let function = &tool["function"];
            let name = function["name"].as_str().filter(|name| !name.is_empty())?;
            let mut converted = json!({
                "type": "function",
                "name": name,
                "description": function["description"].as_str().unwrap_or_default(),
                "parameters": function.get("parameters").cloned().unwrap_or_else(|| json!({}))
            });
            if let Some(strict) = function.get("strict") {
                converted["strict"] = strict.clone();
            }
            Some(converted)
        })
        .collect()
}

fn apply_responses_payload(
    payload: &Value,
    content: &mut String,
    tool_calls: &mut Vec<InFlightTool>,
    usage: &mut Option<Usage>,
    text_filter: &mut VisibleTextFilter,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
    received_delta: &mut bool,
) -> Option<anyhow::Error> {
    let event_type = payload["type"].as_str().unwrap_or_default();
    if event_type == "error" {
        let code = payload["code"].as_str().unwrap_or("unknown");
        let message = payload["message"]
            .as_str()
            .unwrap_or("unknown Responses error");
        return Some(anyhow::anyhow!("Responses error {code}: {message}"));
    }
    if event_type == "response.failed" {
        let response = &payload["response"];
        let error = &response["error"];
        let message = error["message"]
            .as_str()
            .or_else(|| response["incomplete_details"]["reason"].as_str())
            .unwrap_or("Responses request failed");
        return Some(anyhow::anyhow!("{message}"));
    }

    let response = if event_type == "response.completed" || event_type == "response.incomplete" {
        payload.get("response")
    } else {
        None
    };
    if let Some(response) = response {
        if let Some(reported) = response.get("usage").filter(|value| value.is_object()) {
            *usage = Some(parse_usage(reported));
        }
        if content.is_empty() && tool_calls.is_empty() {
            if let Some(output) = response["output"].as_array() {
                for item in output {
                    if item["type"] == "message" {
                        if let Some(text) =
                            response_text(&item["content"]).filter(|text| !text.is_empty())
                        {
                            append_response_text(
                                text,
                                content,
                                text_filter,
                                delta_tx,
                                received_delta,
                            );
                        }
                    } else if item["type"] == "function_call" {
                        let index = item["output_index"]
                            .as_u64()
                            .unwrap_or(tool_calls.len() as u64)
                            as usize;
                        let slot = response_tool_slot(tool_calls, index);
                        slot.id = item["call_id"]
                            .as_str()
                            .or_else(|| item["id"].as_str())
                            .unwrap_or_default()
                            .to_string();
                        slot.item_id = item["id"].as_str().unwrap_or_default().to_string();
                        slot.name = item["name"].as_str().unwrap_or_default().to_string();
                        slot.arguments = item["arguments"].as_str().unwrap_or("{}").to_string();
                        *received_delta = true;
                    }
                }
            }
        }
        return None;
    }

    match event_type {
        // The Responses request asks for `summary: "auto"`, so a reasoning
        // model streams its summary here. Display-only, exactly like the
        // chat-completions reasoning fields.
        "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
            if let (Some(tx), Some(delta)) = (delta_tx, payload["delta"].as_str()) {
                send_reasoning(tx, delta);
            }
        }
        "response.output_text.delta" | "response.refusal.delta" => {
            if let Some(delta) = payload["delta"].as_str() {
                append_response_text(
                    delta.to_string(),
                    content,
                    text_filter,
                    delta_tx,
                    received_delta,
                );
            }
        }
        "response.function_call_arguments.delta" => {
            let index = payload["output_index"].as_u64().unwrap_or(0) as usize;
            let slot = response_tool_slot(tool_calls, index);
            if let Some(item_id) = payload["item_id"].as_str() {
                slot.item_id = item_id.to_string();
            }
            if let Some(delta) = payload["delta"].as_str() {
                slot.arguments.push_str(delta);
                *received_delta = true;
            }
        }
        "response.function_call_arguments.done" => {
            let index = payload["output_index"].as_u64().unwrap_or(0) as usize;
            let slot = response_tool_slot(tool_calls, index);
            if let Some(arguments) = payload["arguments"].as_str() {
                slot.arguments = arguments.to_string();
                *received_delta = true;
            }
        }
        "response.output_item.added" | "response.output_item.done" => {
            let item = &payload["item"];
            if item["type"] == "function_call" {
                let index = payload["output_index"].as_u64().unwrap_or(0) as usize;
                let slot = response_tool_slot(tool_calls, index);
                if let Some(id) = item["call_id"].as_str() {
                    slot.id = id.to_string();
                }
                if let Some(item_id) = item["id"].as_str() {
                    slot.item_id = item_id.to_string();
                }
                if let Some(name) = item["name"].as_str() {
                    slot.name = name.to_string();
                }
                if let Some(arguments) = item["arguments"].as_str().filter(|args| !args.is_empty())
                {
                    slot.arguments = arguments.to_string();
                    *received_delta = true;
                }
            }
        }
        _ => {}
    }
    None
}

fn append_response_text(
    text: String,
    content: &mut String,
    text_filter: &mut VisibleTextFilter,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
    received_delta: &mut bool,
) {
    append_visible_text(text_filter.push(&text), content, delta_tx, received_delta);
}

fn append_visible_text(
    text: String,
    content: &mut String,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
    received_delta: &mut bool,
) {
    if text.is_empty() {
        return;
    }
    *received_delta = true;
    content.push_str(&text);
    if let Some(tx) = delta_tx {
        let _ = tx.send(StreamChunk::Content(text));
    }
}

/// Forwards whatever reasoning the provider streamed alongside this payload.
///
/// Deliberately does not touch `content` or `received_delta`: reasoning never
/// becomes part of the answer, and a stream that emitted only reasoning before
/// dropping has produced nothing the user has to keep — flagging it as
/// consumed output would make every long-thinking model unretryable, while
/// replaying a few thinking tokens on retry costs nothing.
fn append_reasoning(
    source: &serde_json::Map<String, Value>,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
) {
    let Some(tx) = delta_tx else {
        return;
    };
    // The same text under three names: `reasoning_content` (DeepSeek and most
    // OpenAI-compatible proxies), `reasoning` (OpenRouter), and
    // `reasoning_details[]` (OpenRouter's structured form). OpenRouter sends
    // the last two together carrying identical text, so only the first source
    // that actually yields text is forwarded — emitting every present field
    // would double the thinking block on those gateways.
    for key in ["reasoning_content", "reasoning"] {
        if let Some(text) = source
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            let _ = tx.send(StreamChunk::Reasoning(text.to_string()));
            return;
        }
    }
    let Some(details) = source.get("reasoning_details").and_then(Value::as_array) else {
        return;
    };
    for detail in details {
        if let Some(text) = detail
            .get("text")
            .or_else(|| detail.get("summary"))
            .and_then(Value::as_str)
        {
            send_reasoning(tx, text);
        }
    }
}

fn send_reasoning(tx: &tokio::sync::mpsc::UnboundedSender<StreamChunk>, text: &str) {
    if text.is_empty() {
        return;
    }
    let _ = tx.send(StreamChunk::Reasoning(text.to_string()));
}

fn response_tool_slot(tool_calls: &mut Vec<InFlightTool>, index: usize) -> &mut InFlightTool {
    if tool_calls.len() <= index {
        tool_calls.resize(index + 1, InFlightTool::default());
    }
    &mut tool_calls[index]
}

fn parse_usage(reported: &Value) -> Usage {
    let reported_prompt_tokens = reported["prompt_tokens"]
        .as_u64()
        .or_else(|| reported["input_tokens"].as_u64())
        .unwrap_or(0);
    let completion_tokens = reported["completion_tokens"]
        .as_u64()
        .or_else(|| reported["output_tokens"].as_u64())
        .unwrap_or(0);
    let details = reported
        .get("prompt_tokens_details")
        .or_else(|| reported.get("input_tokens_details"));
    let cache_read_tokens = details
        .and_then(|value| value.get("cached_tokens"))
        .and_then(Value::as_u64)
        .or_else(|| reported["prompt_cache_hit_tokens"].as_u64())
        .unwrap_or(0);
    let cache_write_tokens = details
        .and_then(|value| value.get("cache_write_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let prompt_tokens = reported_prompt_tokens
        .saturating_sub(cache_read_tokens)
        .saturating_sub(cache_write_tokens);
    let total_tokens = reported["total_tokens"]
        .as_u64()
        .filter(|total| *total > 0)
        .unwrap_or(reported_prompt_tokens + completion_tokens);
    Usage {
        prompt_tokens,
        completion_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
    }
}

fn clamp_prompt_cache_key(session_id: &str) -> String {
    session_id.chars().take(64).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CacheRetention {
    None,
    Short,
    Long,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionAffinity {
    None,
    OpenAi,
    OpenRouter,
    CodexRouter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProviderCapabilities {
    supports_prompt_cache_key: bool,
    supports_long_cache_retention: bool,
    supports_usage_in_stream: bool,
    session_affinity: SessionAffinity,
}

fn resolve_cache_retention() -> CacheRetention {
    let configured = std::env::var("CALI_CACHE_RETENTION")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("PI_CACHE_RETENTION")
                .ok()
                .filter(|value| !value.trim().is_empty())
        });
    parse_cache_retention(configured.as_deref())
}

fn parse_cache_retention(value: Option<&str>) -> CacheRetention {
    match value.map(str::trim) {
        Some(value) if value.eq_ignore_ascii_case("none") => CacheRetention::None,
        Some(value) if value.eq_ignore_ascii_case("long") => CacheRetention::Long,
        Some(value) if value.eq_ignore_ascii_case("short") => CacheRetention::Short,
        _ => CacheRetention::Short,
    }
}

fn provider_capabilities(config: &AppConfig) -> ProviderCapabilities {
    let provider = config.model.provider.trim();
    let base_url = config.model.base_url.trim();
    let is_openai = provider.eq_ignore_ascii_case("openai") || is_openai_base_url(base_url);
    let is_openrouter =
        provider.eq_ignore_ascii_case("openrouter") || is_openrouter_base_url(base_url);
    let is_codex_router = provider.eq_ignore_ascii_case(crate::config::CODEX_ROUTER_PROVIDER_ID);
    let is_codex_router_luna = is_codex_router && is_luna_model(&config.model.default);

    ProviderCapabilities {
        // Pi's OpenAI Completions transport sends this for direct OpenAI, and
        // for a compatible provider only when long retention is explicitly
        // enabled. Luna is the known router-backed Responses model.
        supports_prompt_cache_key: is_openai || is_codex_router_luna,
        supports_long_cache_retention: is_openai || is_openrouter || is_codex_router_luna,
        // Codex Router's Luna entry is Responses-only; its Chat Completions
        // request must not receive a Chat Completions-only usage option.
        supports_usage_in_stream: is_openai
            || is_openrouter
            || (is_codex_router && !is_codex_router_luna),
        session_affinity: if is_openrouter {
            SessionAffinity::OpenRouter
        } else if is_codex_router {
            SessionAffinity::CodexRouter
        } else if is_openai {
            SessionAffinity::OpenAi
        } else {
            SessionAffinity::None
        },
    }
}

fn is_openai_base_url(base_url: &str) -> bool {
    base_url
        .trim_end_matches('/')
        .eq_ignore_ascii_case("https://api.openai.com/v1")
}

fn is_openrouter_base_url(base_url: &str) -> bool {
    base_url
        .trim_end_matches('/')
        .eq_ignore_ascii_case("https://openrouter.ai/api/v1")
}

fn is_luna_model(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    model.contains("gpt-5.6-luna") || model.contains("gpt-5-6-luna")
}

fn is_anthropic_model(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    model.contains("claude") || model.starts_with("anthropic/")
}

/// Whether this request must carry its own Anthropic cache breakpoints.
///
/// Scoped deliberately to OpenRouter. It does not cache Anthropic models
/// automatically — the caller places the breakpoints — and it returns 200
/// either way, so an unmarked tool-heavy loop silently re-bills its whole
/// prefix every turn. Other OpenAI-shaped gateways are excluded because a
/// proxy that already injects markers upstream would push the request past
/// Anthropic's four-breakpoint ceiling and fail the call outright.
fn marks_anthropic_cache_control(config: &AppConfig) -> bool {
    let is_openrouter = config.model.provider.eq_ignore_ascii_case("openrouter")
        || is_openrouter_base_url(config.model.base_url.trim());
    is_openrouter && is_anthropic_model(&config.model.default)
}

/// How many rolling breakpoints trail the system prompt. One closes the system
/// prompt; Anthropic allows four per request, so three may roll.
const ROLLING_CACHE_BREAKPOINTS: usize = 3;

/// Four breakpoints: one closing the system prompt, three rolling over the
/// newest markable turns.
///
/// Anchoring the tail on the newest *user* turn — the earlier layout — leaves
/// every assistant and tool message produced since that turn uncached. A goal
/// run spends most of its turns inside one tool loop with no new user message,
/// so that whole growing tail was re-billed at full price every turn. A rolling
/// window makes each turn's output a cache read on the next turn, and keeping
/// two older marks behind the newest means a shifted tail still lands on a
/// live prefix instead of rebuilding from the system prompt.
///
/// `role: "tool"` messages are never marked — OpenRouter hangs on a marker
/// there rather than rejecting it — and empty content is left alone because
/// Anthropic rejects an empty text block. Both are skipped without spending a
/// breakpoint, so an assistant turn that only carried tool calls does not
/// silently cost one of the three.
fn apply_anthropic_cache_control(messages: &[Value], retention: CacheRetention) -> Vec<Value> {
    let marker = if retention == CacheRetention::Long {
        json!({ "type": "ephemeral", "ttl": "1h" })
    } else {
        json!({ "type": "ephemeral" })
    };
    let mut out = messages.to_vec();
    let system = out
        .iter()
        .rposition(|message| message.get("role").and_then(Value::as_str) == Some("system"));
    if let Some(index) = system {
        mark_cache_control(&mut out[index], &marker);
    }
    let mut remaining = ROLLING_CACHE_BREAKPOINTS;
    for index in (0..out.len()).rev() {
        if remaining == 0 {
            break;
        }
        if matches!(
            out[index].get("role").and_then(Value::as_str),
            Some("system") | Some("tool")
        ) {
            continue;
        }
        if mark_cache_control(&mut out[index], &marker) {
            remaining -= 1;
        }
    }
    out
}

fn mark_cache_control(message: &mut Value, marker: &Value) -> bool {
    match message.get_mut("content") {
        Some(Value::String(text)) => {
            if text.trim().is_empty() {
                return false;
            }
            let text = std::mem::take(text);
            message["content"] = json!([
                { "type": "text", "text": text, "cache_control": marker }
            ]);
            true
        }
        Some(Value::Array(parts)) => match parts.last_mut() {
            Some(last) if last.is_object() => {
                last["cache_control"] = marker.clone();
                true
            }
            _ => false,
        },
        _ => false,
    }
}

fn is_codex_router_luna(config: &AppConfig) -> bool {
    config
        .model
        .provider
        .eq_ignore_ascii_case(crate::config::CODEX_ROUTER_PROVIDER_ID)
        && is_luna_model(&config.model.default)
}

fn provider_supports_prompt_cache_key(config: &AppConfig) -> bool {
    provider_capabilities(config).supports_prompt_cache_key
}

#[derive(Clone, Default)]
struct InFlightTool {
    id: String,
    item_id: String,
    name: String,
    arguments: String,
}

/// Removes provider-emitted private reasoning blocks before they reach the
/// live SSE transcript or durable assistant history. Some OpenAI-compatible
/// gateways serialize hidden reasoning as ordinary `<think>...</think>`
/// content, and tag boundaries may be split across arbitrary stream chunks.
#[derive(Default)]
struct VisibleTextFilter {
    pending: String,
    inside_think: bool,
}

impl VisibleTextFilter {
    fn push(&mut self, text: &str) -> String {
        self.pending.push_str(text);
        self.drain(false)
    }

    fn finish(&mut self) -> String {
        self.drain(true)
    }

    fn drain(&mut self, finish: bool) -> String {
        const OPEN: &str = "<think>";
        const CLOSE: &str = "</think>";
        let mut visible = String::new();
        loop {
            if self.inside_think {
                if let Some(end) = self.pending.find(CLOSE) {
                    self.pending.drain(..end + CLOSE.len());
                    self.inside_think = false;
                    continue;
                }
                if finish {
                    self.pending.clear();
                } else {
                    keep_possible_tag_suffix(&mut self.pending, CLOSE);
                }
                break;
            }

            if let Some(start) = self.pending.find(OPEN) {
                let orphan_close = self.pending.find(CLOSE);
                if orphan_close.is_none_or(|close| start <= close) {
                    visible.push_str(&self.pending[..start]);
                    self.pending.drain(..start + OPEN.len());
                    self.inside_think = true;
                    continue;
                }
            }
            if let Some(close) = self.pending.find(CLOSE) {
                visible.push_str(&self.pending[..close]);
                self.pending.drain(..close + CLOSE.len());
                continue;
            }
            if finish {
                visible.push_str(&self.pending);
                self.pending.clear();
            } else {
                let keep = possible_tag_suffix_len(&self.pending, OPEN)
                    .max(possible_tag_suffix_len(&self.pending, CLOSE));
                let emit = self.pending.len().saturating_sub(keep);
                visible.push_str(&self.pending[..emit]);
                self.pending.drain(..emit);
            }
            break;
        }
        visible
    }
}

fn possible_tag_suffix_len(text: &str, tag: &str) -> usize {
    let max = text.len().min(tag.len().saturating_sub(1));
    (1..=max)
        .rev()
        .find(|&length| text.ends_with(&tag[..length]))
        .unwrap_or(0)
}

fn keep_possible_tag_suffix(text: &mut String, tag: &str) {
    let keep = possible_tag_suffix_len(text, tag);
    if keep == 0 {
        text.clear();
    } else {
        text.drain(..text.len() - keep);
    }
}

/// Merge one OpenAI-compatible response payload into the streamed result.
///
/// Normal streaming responses use `choices[0].delta`; gateways that ignore
/// streaming use `choices[0].message`. Keeping both shapes here prevents a
/// successful provider response from being misclassified as an empty one.
fn apply_payload(
    payload: &Value,
    content: &mut String,
    tool_calls: &mut Vec<InFlightTool>,
    usage: &mut Option<Usage>,
    text_filter: &mut VisibleTextFilter,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
    received_delta: &mut bool,
) {
    // OpenAI sends `"usage": null` on content chunks and the real object in a
    // final chunk with empty `choices`; keep the last object seen. Missing
    // fields default to 0 and a missing/zero total falls back to
    // prompt + completion.
    if let Some(reported) = payload.get("usage").filter(|value| value.is_object()) {
        *usage = Some(parse_usage(reported));
    }

    let Some(choice) = payload["choices"]
        .as_array()
        .and_then(|choices| choices.first())
    else {
        return;
    };
    if let Some(delta) = choice.get("delta").and_then(Value::as_object) {
        append_reasoning(delta, delta_tx);
        append_content(delta, content, text_filter, delta_tx, received_delta);
        append_tool_calls(delta, tool_calls, received_delta, true);
        return;
    }
    if let Some(message) = choice.get("message").and_then(Value::as_object) {
        append_reasoning(message, delta_tx);
        append_content(message, content, text_filter, delta_tx, received_delta);
        append_tool_calls(message, tool_calls, received_delta, false);
    }
}

fn append_content(
    source: &serde_json::Map<String, Value>,
    content: &mut String,
    text_filter: &mut VisibleTextFilter,
    delta_tx: Option<&tokio::sync::mpsc::UnboundedSender<StreamChunk>>,
    received_delta: &mut bool,
) {
    if let Some(text) = source.get("content").and_then(Value::as_str) {
        append_visible_text(text_filter.push(text), content, delta_tx, received_delta);
    }
}

fn append_tool_calls(
    source: &serde_json::Map<String, Value>,
    tool_calls: &mut Vec<InFlightTool>,
    received_delta: &mut bool,
    streaming_delta: bool,
) {
    let Some(calls) = source.get("tool_calls").and_then(Value::as_array) else {
        return;
    };
    for call in calls {
        *received_delta = true;
        // Streaming deltas often omit `index` on continuation chunks; those
        // must keep appending to slot 0 as the legacy parser did. A complete
        // non-stream `message.tool_calls` array has no continuation semantics,
        // so each index-less call gets the next slot instead.
        let index = call["index"]
            .as_u64()
            .map(|value| value as usize)
            .unwrap_or_else(|| if streaming_delta { 0 } else { tool_calls.len() });
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

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        text.to_string()
    } else {
        format!("{}...", &text[..max])
    }
}

#[cfg(test)]
mod tool_call_id_tests {
    use super::{uniquify_tool_call_ids, ToolCall};
    use serde_json::json;

    fn call(id: &str, name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: args,
        }
    }

    fn ids(calls: &[ToolCall]) -> Vec<String> {
        calls.iter().map(|c| c.id.clone()).collect()
    }

    #[test]
    fn distinct_ids_are_left_exactly_alone() {
        // Renaming what was already fine would break nothing, but it would
        // make the logs lie about what the provider sent.
        let mut calls = vec![
            call("a", "file_read", json!({})),
            call("b", "file_read", json!({})),
        ];
        uniquify_tool_call_ids(&mut calls);
        assert_eq!(ids(&calls), vec!["a", "b"]);
    }

    #[test]
    fn a_repeated_id_is_renamed_so_the_turn_survives() {
        // Two answers to one question makes the provider reject the whole
        // request, and the session stays stuck that way.
        let mut calls = vec![
            call("dup", "file_read", json!({ "path": "a" })),
            call("dup", "file_read", json!({ "path": "b" })),
            call("dup", "file_read", json!({ "path": "c" })),
        ];
        uniquify_tool_call_ids(&mut calls);
        let out = ids(&calls);
        assert_eq!(out[0], "dup", "the first occurrence keeps its id");
        assert_eq!(out.len(), 3);
        assert_eq!(
            out.iter().collect::<std::collections::HashSet<_>>().len(),
            3,
            "every id must be distinct: {out:?}"
        );
    }

    #[test]
    fn empty_ids_are_numbered_by_position_not_by_argument_length() {
        // The old fallback was `call-<argument length>`, which manufactured
        // collisions: two calls whose arguments happened to be the same length
        // got the same id. Position cannot collide.
        let mut calls = vec![
            call("", "file_read", json!({ "path": "aa" })),
            call("", "file_read", json!({ "path": "bb" })),
        ];
        uniquify_tool_call_ids(&mut calls);
        let out = ids(&calls);
        assert_eq!(out, vec!["call-0", "call-1"]);
    }

    #[test]
    fn a_synthetic_id_that_collides_with_a_real_one_still_resolves() {
        // A provider is free to send a literal "call-1"; the synthetic scheme
        // must not assume its namespace is private.
        let mut calls = vec![
            call("call-1", "file_read", json!({})),
            call("", "file_glob", json!({})),
        ];
        uniquify_tool_call_ids(&mut calls);
        let out = ids(&calls);
        assert_eq!(out[0], "call-1");
        assert_ne!(
            out[1], "call-1",
            "the synthetic id must step aside: {out:?}"
        );
    }

    #[test]
    fn whitespace_only_ids_count_as_absent() {
        let mut calls = vec![call("   ", "file_read", json!({}))];
        uniquify_tool_call_ids(&mut calls);
        assert_eq!(ids(&calls), vec!["call-0"]);
    }
}

#[cfg(test)]
mod retry_after_tests {
    use super::parse_retry_after;
    use super::MAX_RETRY_AFTER;
    use reqwest::header::HeaderMap;
    use std::time::Duration;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        map
    }

    #[test]
    fn a_provider_that_says_nothing_leaves_the_backoff_alone() {
        // `None` is what makes the fixed schedule the default; a zero here
        // would turn silence into "retry immediately".
        assert_eq!(parse_retry_after(&headers(&[])), None);
    }

    #[test]
    fn delay_seconds_are_honoured() {
        assert_eq!(
            parse_retry_after(&headers(&[("retry-after", "3")])),
            Some(Duration::from_secs(3))
        );
        // Fractional seconds appear in the wild despite the RFC.
        assert_eq!(
            parse_retry_after(&headers(&[("retry-after", "1.5")])),
            Some(Duration::from_millis(1500))
        );
    }

    #[test]
    fn the_millisecond_header_some_gateways_send_wins() {
        // `retry-after-ms` is more precise, so it is preferred where both are
        // present rather than being silently ignored.
        let both = headers(&[("retry-after", "5"), ("retry-after-ms", "250")]);
        assert_eq!(parse_retry_after(&both), Some(Duration::from_millis(250)));
    }

    #[test]
    fn an_absurd_wait_is_capped_rather_than_obeyed() {
        // A gateway answering "wait an hour" would otherwise hold the turn
        // open for an hour with the user watching a spinner.
        assert_eq!(
            parse_retry_after(&headers(&[("retry-after", "3600")])),
            Some(MAX_RETRY_AFTER)
        );
    }

    #[test]
    fn unparseable_and_hostile_values_fall_back_rather_than_guess() {
        // HTTP-date form is deliberately unsupported — it needs a clock the
        // machine may have wrong.
        assert_eq!(
            parse_retry_after(&headers(&[(
                "retry-after",
                "Wed, 21 Oct 2026 07:28:00 GMT"
            )])),
            None
        );
        assert_eq!(
            parse_retry_after(&headers(&[("retry-after", "soon")])),
            None
        );
        assert_eq!(parse_retry_after(&headers(&[("retry-after", "NaN")])), None);
        // Negative means "now", not "travel backwards".
        assert_eq!(
            parse_retry_after(&headers(&[("retry-after", "-10")])),
            Some(Duration::ZERO)
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ModelConfig;
    use axum::http::HeaderMap;
    use axum::http::StatusCode;
    use axum::response::sse::{Event, Sse};
    use axum::response::{IntoResponse, Response};
    use axum::routing::post;
    use axum::Router;
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

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

    /// Feeds payloads through `apply_payload` and returns
    /// (visible content, streamed visible, streamed reasoning).
    fn stream_payloads(payloads: &[Value]) -> (String, String, String) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut content = String::new();
        let mut calls = Vec::new();
        let mut usage = None;
        let mut received = false;
        let mut text_filter = VisibleTextFilter::default();
        for payload in payloads {
            apply_payload(
                payload,
                &mut content,
                &mut calls,
                &mut usage,
                &mut text_filter,
                Some(&tx),
                &mut received,
            );
        }
        append_visible_text(text_filter.finish(), &mut content, Some(&tx), &mut received);
        drop(tx);
        let (visible, reasoning) = drain_stream(&mut rx);
        (content, visible, reasoning)
    }

    #[test]
    fn streamed_reasoning_content_never_enters_visible_content() {
        let (content, visible, reasoning) = stream_payloads(&[
            json!({ "choices": [{ "delta": { "reasoning_content": "weighing options" } }] }),
            json!({ "choices": [{ "delta": { "reasoning_content": " carefully" } }] }),
            json!({ "choices": [{ "delta": { "content": "Here is the answer." } }] }),
        ]);
        assert_eq!(content, "Here is the answer.");
        assert_eq!(visible, "Here is the answer.");
        assert_eq!(reasoning, "weighing options carefully");
    }

    #[test]
    fn openrouter_reasoning_string_and_details_array_both_stream() {
        let (content, visible, reasoning) = stream_payloads(&[
            json!({ "choices": [{ "delta": { "reasoning": "step one" } }] }),
            json!({
                "choices": [{
                    "delta": {
                        "reasoning_details": [
                            { "type": "reasoning.text", "text": " step two" },
                            { "type": "reasoning.text", "text": " step three" }
                        ]
                    }
                }]
            }),
            json!({ "choices": [{ "delta": { "content": "done" } }] }),
        ]);
        assert_eq!(content, "done");
        assert_eq!(visible, "done");
        assert_eq!(reasoning, "step one step two step three");
    }

    #[test]
    fn openrouter_duplicate_reasoning_fields_stream_the_text_once() {
        // OpenRouter puts the same text in `reasoning` and in
        // `reasoning_details[]`; forwarding both would double the thinking
        // block in the UI.
        let (_, _, reasoning) = stream_payloads(&[json!({
            "choices": [{
                "delta": {
                    "reasoning": "one thought",
                    "reasoning_details": [{ "type": "reasoning.text", "text": "one thought" }]
                }
            }]
        })]);
        assert_eq!(reasoning, "one thought");
    }

    #[test]
    fn non_streaming_message_shape_carries_reasoning_too() {
        let (content, visible, reasoning) = stream_payloads(&[json!({
            "choices": [{
                "message": { "reasoning_content": "thought it through", "content": "final" }
            }]
        })]);
        assert_eq!(content, "final");
        assert_eq!(visible, "final");
        assert_eq!(reasoning, "thought it through");
    }

    #[test]
    fn payload_without_reasoning_streams_only_visible_text() {
        let (content, visible, reasoning) = stream_payloads(&[
            json!({ "choices": [{ "delta": { "content": "plain " } }] }),
            json!({ "choices": [{ "delta": { "content": "answer" } }] }),
        ]);
        assert_eq!(content, "plain answer");
        assert_eq!(visible, "plain answer");
        assert!(reasoning.is_empty());
    }

    #[test]
    fn reasoning_alone_does_not_mark_the_stream_as_consumed() {
        // A stream that emitted only reasoning before dropping has produced
        // nothing the user keeps, so it must still be retryable.
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let mut content = String::new();
        let mut calls = Vec::new();
        let mut usage = None;
        let mut received = false;
        let mut text_filter = VisibleTextFilter::default();
        apply_payload(
            &json!({ "choices": [{ "delta": { "reasoning_content": "still thinking" } }] }),
            &mut content,
            &mut calls,
            &mut usage,
            &mut text_filter,
            Some(&tx),
            &mut received,
        );
        assert!(!received);
        assert!(content.is_empty());
    }

    #[test]
    fn responses_reasoning_summary_deltas_stream_as_reasoning() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut content = String::new();
        let mut calls = Vec::new();
        let mut usage = None;
        let mut received = false;
        let mut text_filter = VisibleTextFilter::default();
        for payload in [
            json!({ "type": "response.reasoning_summary_text.delta", "delta": "planning" }),
            json!({ "type": "response.output_text.delta", "delta": "shipped" }),
        ] {
            assert!(apply_responses_payload(
                &payload,
                &mut content,
                &mut calls,
                &mut usage,
                &mut text_filter,
                Some(&tx),
                &mut received,
            )
            .is_none());
        }
        append_visible_text(text_filter.finish(), &mut content, Some(&tx), &mut received);
        drop(tx);
        let (visible, reasoning) = drain_stream(&mut rx);
        assert_eq!(content, "shipped");
        assert_eq!(visible, "shipped");
        assert_eq!(reasoning, "planning");
    }

    #[test]
    fn streaming_tool_deltas_without_indexes_stay_in_one_call() {
        // Continuation chunks from some gateways omit `index`. They still
        // belong to the first streamed call; treating each as a new slot
        // loses the completed arguments and makes the next agent turn fail.
        let mut content = String::new();
        let mut calls = Vec::new();
        let mut usage = None;
        let mut received = false;
        let mut text_filter = VisibleTextFilter::default();
        apply_payload(
            &json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "id": "call-1",
                            "function": { "name": "editor_echo", "arguments": "{\"message\":" }
                        }]
                    }
                }]
            }),
            &mut content,
            &mut calls,
            &mut usage,
            &mut text_filter,
            None,
            &mut received,
        );
        apply_payload(
            &json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "function": { "arguments": "\"hello\"}" }
                        }]
                    }
                }]
            }),
            &mut content,
            &mut calls,
            &mut usage,
            &mut text_filter,
            None,
            &mut received,
        );
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call-1");
        assert_eq!(calls[0].name, "editor_echo");
        assert_eq!(
            serde_json::from_str::<Value>(&calls[0].arguments).unwrap(),
            json!({ "message": "hello" })
        );
    }

    #[test]
    fn private_think_blocks_never_reach_stream_or_history_across_chunk_boundaries() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut filter = VisibleTextFilter::default();
        let mut content = String::new();
        let mut received = false;
        for chunk in [
            "<thi",
            "nk>private deliberation",
            " split over chunks</thi",
            "nk>Visible answer",
        ] {
            append_response_text(
                chunk.to_string(),
                &mut content,
                &mut filter,
                Some(&tx),
                &mut received,
            );
        }
        append_visible_text(filter.finish(), &mut content, Some(&tx), &mut received);
        drop(tx);
        let (streamed, reasoning) = drain_stream(&mut rx);
        assert_eq!(content, "Visible answer");
        assert_eq!(streamed, "Visible answer");
        assert_eq!(reasoning, "");
        assert!(received);
    }

    /// Splits a finished stream into (visible, reasoning) so a test can assert
    /// that neither leaked into the other.
    fn drain_stream(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<StreamChunk>,
    ) -> (String, String) {
        let mut visible = String::new();
        let mut reasoning = String::new();
        while let Ok(chunk) = rx.try_recv() {
            match chunk {
                StreamChunk::Content(text) => visible.push_str(&text),
                StreamChunk::Reasoning(text) => reasoning.push_str(&text),
            }
        }
        (visible, reasoning)
    }

    #[test]
    fn ordinary_angle_bracket_text_and_unclosed_reasoning_are_handled_safely() {
        let mut filter = VisibleTextFilter::default();
        assert_eq!(
            filter.push("Use <code> normally. <thi"),
            "Use <code> normally. "
        );
        assert_eq!(filter.push("nk>never expose this"), "");
        assert_eq!(filter.finish(), "");

        let mut orphan = VisibleTextFilter::default();
        assert_eq!(orphan.push("Visible</thi"), "Visible");
        assert_eq!(
            orphan.push("nk> answer <code>x</code>"),
            " answer <code>x</code>"
        );
        assert_eq!(orphan.finish(), "");
    }

    fn success_sse() -> Sse<futures::stream::Iter<std::vec::IntoIter<Result<Event, Infallible>>>> {
        let events = vec![
            Ok(Event::default()
                .data(r#"{"choices":[{"delta":{"role":"assistant","content":"Hello "}}]}"#)),
            Ok(Event::default().data(r#"{"choices":[{"delta":{"content":"from CaliCode"}}]}"#)),
            Ok(Event::default().data("[DONE]")),
        ];
        Sse::new(futures::stream::iter(events))
    }

    /// Serves `/v1/chat/completions`, failing the first `fail_first` requests
    /// with `fail_status`, then streaming a success. Returns the bound
    /// address and a hit counter.
    async fn spawn_mock(fail_first: usize, fail_status: StatusCode) -> (String, Arc<AtomicUsize>) {
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_for_route = hits.clone();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move || {
                let hits = hits_for_route.clone();
                async move {
                    let n = hits.fetch_add(1, Ordering::SeqCst);
                    if n < fail_first {
                        (fail_status, "injected failure").into_response()
                    } else {
                        success_sse().into_response()
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{}/v1", addr), hits)
    }

    /// Serves one empty 200/SSE completion, then a normal completion. Empty
    /// successful responses must take the same retry path as a pre-content
    /// transport failure instead of being returned as a fake assistant turn.
    async fn spawn_empty_then_success() -> (String, Arc<AtomicUsize>) {
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_for_route = hits.clone();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move || {
                let hits = hits_for_route.clone();
                async move {
                    let n = hits.fetch_add(1, Ordering::SeqCst);
                    if n == 0 {
                        Sse::new(futures::stream::iter(vec![
                            Ok::<_, Infallible>(
                                Event::default().data(r#"{"choices":[{"delta":{}}]}"#),
                            ),
                            Ok(Event::default().data("[DONE]")),
                        ]))
                        .into_response()
                    } else {
                        success_sse().into_response()
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}/v1"), hits)
    }

    /// A keep-alive HTTP/1.1 mock spoken by hand, counting *connections*
    /// rather than requests. axum's serve loop hides that number; here every
    /// accept is visible, which is exactly what connection pooling changes.
    /// Each connection serves requests until the peer hangs up.
    async fn spawn_keepalive_mock() -> (String, Arc<AtomicUsize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let counter = connections.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf: Vec<u8> = Vec::new();
                    let mut scratch = [0u8; 1024];
                    loop {
                        // Headers first, then exactly Content-Length body
                        // bytes — anything left over belongs to the next
                        // request on this same connection.
                        let (header_end, body_len) = loop {
                            if let Some(pos) =
                                buf.windows(4).position(|window| window == b"\r\n\r\n")
                            {
                                let headers =
                                    String::from_utf8_lossy(&buf[..pos]).to_ascii_lowercase();
                                let len = headers
                                    .lines()
                                    .find_map(|line| line.strip_prefix("content-length:"))
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                                    .unwrap_or(0);
                                break (pos + 4, len);
                            }
                            match socket.read(&mut scratch).await {
                                Ok(0) | Err(_) => return,
                                Ok(n) => buf.extend_from_slice(&scratch[..n]),
                            }
                        };
                        while buf.len() < header_end + body_len {
                            match socket.read(&mut scratch).await {
                                Ok(0) | Err(_) => return,
                                Ok(n) => buf.extend_from_slice(&scratch[..n]),
                            }
                        }
                        buf.drain(..header_end + body_len);
                        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"pooled\"}}]}\n\ndata: [DONE]\n\n";
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{body}",
                            body.len()
                        );
                        if socket.write_all(response.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        (format!("http://{addr}/v1"), connections)
    }

    fn test_config(base_url: String) -> AppConfig {
        AppConfig {
            model: ModelConfig {
                default: "mock-model".into(),
                provider: "mock".into(),
                base_url,
                api_key_env: "CALI_MOCK_KEY".into(),
                temperature: 0.0,
                max_tokens: Some(32),
                roles: Default::default(),
            },
            providers: vec![],
            ..Default::default()
        }
    }

    #[test]
    fn http_client_is_built_once() {
        // `AttemptError` is deliberately not `Debug`, so unwrap by hand.
        let first = http_client().unwrap_or_else(|_| panic!("http client must build"));
        let second = http_client().unwrap_or_else(|_| panic!("http client must build"));
        // Same allocation, so the same connection pool. Building per attempt
        // handed back two unrelated clients and two unrelated pools.
        assert!(std::ptr::eq(first, second));
        assert_eq!(REQUEST_TIMEOUT, std::time::Duration::from_secs(300));
    }

    #[tokio::test]
    async fn chat_reuses_one_connection_across_calls() {
        let (base_url, connections) = spawn_keepalive_mock().await;
        let config = test_config(base_url);
        for _ in 0..3 {
            let result = chat(
                &config,
                &[json!({ "role": "user", "content": "hello" })],
                None,
                None,
            )
            .await
            .unwrap();
            assert_eq!(result.content, "pooled");
        }
        assert_eq!(
            connections.load(Ordering::SeqCst),
            1,
            "three sequential completions must ride one pooled connection; \
             a per-attempt reqwest::Client opens three"
        );
    }

    #[tokio::test]
    async fn chat_streams_from_mock_provider() {
        let (base_url, hits) = spawn_mock(0, StatusCode::OK).await;
        let config = test_config(base_url);
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
        assert!(
            result.usage.is_none(),
            "a stream without a usage chunk must yield usage: None"
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn chat_accepts_a_non_stream_json_completion() {
        // Some gateways fall back to a regular Chat Completions JSON body for
        // models that do not support streaming. The body is still a valid
        // successful completion and must not enter the empty-response retry
        // path.
        let app = Router::new().route(
            "/v1/chat/completions",
            post(|| async {
                let body = json!({
                    "choices": [{
                        "message": { "role": "assistant", "content": "JSON fallback" }
                    }]
                })
                .to_string();
                Response::builder()
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap()
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let config = test_config(format!("http://{addr}/v1"));
        let result = chat_with_backoff(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
            &[],
        )
        .await
        .expect("a normal JSON completion is valid");
        assert_eq!(result.content, "JSON fallback");
    }

    #[tokio::test]
    async fn empty_completion_retries_before_returning_success() {
        let (base_url, hits) = spawn_empty_then_success().await;
        let config = test_config(base_url);
        let result = chat_with_backoff(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
            &[0],
        )
        .await
        .expect("an empty 200 response should be retried");
        assert_eq!(result.content, "Hello from CaliCode");
        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "the initial empty response plus one retry must be observed"
        );
    }

    #[tokio::test]
    async fn exhausted_empty_completions_surface_an_error() {
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_for_route = hits.clone();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move || {
                let hits = hits_for_route.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    Sse::new(futures::stream::iter(vec![
                        Ok::<_, Infallible>(Event::default().data(r#"{"choices":[{"delta":{}}]}"#)),
                        Ok(Event::default().data("[DONE]")),
                    ]))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let config = test_config(format!("http://{addr}/v1"));
        let error = chat_with_backoff(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
            &[],
        )
        .await
        .expect_err("empty completion must not be reported as success");
        assert!(
            error.to_string().contains("empty completion"),
            "unexpected error: {error}"
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn chat_parses_usage_from_stream() {
        // Mirrors the OpenAI shape: `"usage": null` on content chunks, then a
        // final chunk with empty `choices` carrying the real usage object.
        // Also captures the request body to prove include_usage was requested.
        let captured: Arc<std::sync::Mutex<Option<Value>>> = Arc::new(std::sync::Mutex::new(None));
        let captured_for_route = captured.clone();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |axum::Json(body): axum::Json<Value>| {
                let captured = captured_for_route.clone();
                async move {
                    *captured.lock().unwrap() = Some(body);
                    let events = vec![
                        Ok::<_, Infallible>(Event::default().data(
                            r#"{"choices":[{"delta":{"role":"assistant","content":"Hi"}}],"usage":null}"#,
                        )),
                        Ok(Event::default().data(
                            r#"{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}"#,
                        )),
                        Ok(Event::default().data("[DONE]")),
                    ];
                    Sse::new(futures::stream::iter(events))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut config = test_config(format!("http://{}/v1", addr));
        // This mock intentionally exercises the known OpenAI request shape;
        // arbitrary compatible providers are gated from optional fields.
        config.model.provider = "openai".into();
        let result = chat_with_effort_session(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
            Some("max"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(result.content, "Hi");
        assert_eq!(
            result.usage,
            Some(Usage {
                prompt_tokens: 12,
                completion_tokens: 5,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                total_tokens: 17,
            })
        );
        let body = captured.lock().unwrap().clone().expect("request captured");
        assert_eq!(
            body["stream_options"]["include_usage"],
            json!(true),
            "streaming requests must ask the provider for usage"
        );
        assert_eq!(
            body["reasoning_effort"],
            json!("max"),
            "the selected per-turn effort must reach the provider request"
        );
    }

    #[tokio::test]
    async fn codex_router_luna_uses_responses_with_tools_cache_and_effort() {
        let captured: Arc<std::sync::Mutex<Option<Value>>> = Arc::new(std::sync::Mutex::new(None));
        let captured_headers: Arc<std::sync::Mutex<Option<HeaderMap>>> =
            Arc::new(std::sync::Mutex::new(None));
        let captured_for_route = captured.clone();
        let headers_for_route = captured_headers.clone();
        let app = Router::new().route(
            "/v1/responses",
            post(
                move |headers: HeaderMap, axum::Json(body): axum::Json<Value>| {
                    let captured = captured_for_route.clone();
                    let captured_headers = headers_for_route.clone();
                    async move {
                        *captured.lock().unwrap() = Some(body);
                        *captured_headers.lock().unwrap() = Some(headers);
                        let events = vec![
                            Ok::<_, Infallible>(
                                Event::default().data(
                                    json!({
                                        "type": "response.output_text.delta",
                                        "delta": "Luna"
                                    })
                                    .to_string(),
                                ),
                            ),
                            Ok(Event::default().data(
                                json!({
                                    "type": "response.output_item.added",
                                    "output_index": 1,
                                    "item": {
                                        "type": "function_call",
                                        "id": "fc_1",
                                        "call_id": "call_1",
                                        "name": "editor_echo",
                                        "arguments": ""
                                    }
                                })
                                .to_string(),
                            )),
                            Ok(Event::default().data(
                                json!({
                                    "type": "response.function_call_arguments.delta",
                                    "output_index": 1,
                                    "item_id": "fc_1",
                                    "delta": "{\"message\":\"hi\"}"
                                })
                                .to_string(),
                            )),
                            Ok(Event::default().data(
                                json!({
                                    "type": "response.completed",
                                    "response": {
                                        "usage": {
                                            "input_tokens": 100,
                                            "output_tokens": 7,
                                            "total_tokens": 107,
                                            "input_tokens_details": {
                                                "cached_tokens": 80,
                                                "cache_write_tokens": 4
                                            }
                                        }
                                    }
                                })
                                .to_string(),
                            )),
                            Ok(Event::default().data("[DONE]")),
                        ];
                        Sse::new(futures::stream::iter(events))
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let mut config = test_config(format!("http://{addr}/v1"));
        config.model.provider = crate::config::CODEX_ROUTER_PROVIDER_ID.into();
        config.model.default = "gpt-5.6-luna".into();
        let session_id = "s".repeat(80);
        let result = chat_with_effort_session(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            Some(&[json!({
                "type": "function",
                "function": {
                    "name": "editor_echo",
                    "description": "Echo text",
                    "parameters": { "type": "object" }
                }
            })]),
            None,
            Some("max"),
            Some(&session_id),
        )
        .await
        .unwrap();

        assert_eq!(result.content, "Luna");
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].id, "call_1|fc_1");
        assert_eq!(result.tool_calls[0].name, "editor_echo");
        assert_eq!(result.tool_calls[0].arguments, json!({ "message": "hi" }));
        assert_eq!(
            result.usage,
            Some(Usage {
                prompt_tokens: 16,
                completion_tokens: 7,
                cache_read_tokens: 80,
                cache_write_tokens: 4,
                total_tokens: 107,
            })
        );

        let body = captured.lock().unwrap().clone().expect("request captured");
        assert_eq!(
            body["model"],
            json!(CODEX_ROUTER_LUNA_GATEWAY_MODEL),
            "router receives its gateway model id, not the bare catalog id"
        );
        assert_eq!(body["reasoning"]["effort"], json!("max"));
        assert_eq!(body["reasoning"]["summary"], json!("auto"));
        assert_eq!(body["tools"][0]["name"], json!("editor_echo"));
        assert_eq!(body["tools"][0]["function"], Value::Null);
        assert!(body.get("stream_options").is_none());
        assert_eq!(body["prompt_cache_key"].as_str().unwrap().len(), 64);
        assert_eq!(body["prompt_cache_retention"], Value::Null);

        let headers = captured_headers
            .lock()
            .unwrap()
            .clone()
            .expect("headers captured");
        assert_eq!(
            headers
                .get("session_id")
                .and_then(|value| value.to_str().ok()),
            Some(session_id.as_str())
        );
        assert_eq!(
            headers
                .get("x-client-request-id")
                .and_then(|value| value.to_str().ok()),
            Some(session_id.as_str())
        );
    }

    #[tokio::test]
    async fn usage_total_falls_back_to_prompt_plus_completion() {
        // Some proxies omit total_tokens; a partial usage object must still
        // parse, with the total derived from the two known fields.
        let app = Router::new().route(
            "/v1/chat/completions",
            post(|| async {
                let events = vec![
                    Ok::<_, Infallible>(
                        Event::default().data(r#"{"choices":[{"delta":{"content":"Hi"}}]}"#),
                    ),
                    Ok(Event::default().data(
                        r#"{"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3}}"#,
                    )),
                    Ok(Event::default().data("[DONE]")),
                ];
                Sse::new(futures::stream::iter(events))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let config = test_config(format!("http://{}/v1", addr));
        let result = chat(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            result.usage,
            Some(Usage {
                prompt_tokens: 8,
                completion_tokens: 3,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                total_tokens: 11,
            })
        );
    }

    #[tokio::test]
    async fn session_key_and_cached_usage_are_preserved() {
        let captured: Arc<std::sync::Mutex<Option<Value>>> = Arc::new(std::sync::Mutex::new(None));
        let captured_for_route = captured.clone();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |axum::Json(body): axum::Json<Value>| {
                let captured = captured_for_route.clone();
                async move {
                    *captured.lock().unwrap() = Some(body);
                    let events = vec![
                        Ok::<_, Infallible>(
                            Event::default().data(r#"{"choices":[{"delta":{"content":"Hi"}}]}"#),
                        ),
                        Ok(Event::default().data(
                            r#"{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,"prompt_tokens_details":{"cached_tokens":80,"cache_write_tokens":4}}}"#,
                        )),
                        Ok(Event::default().data("[DONE]")),
                    ];
                    Sse::new(futures::stream::iter(events))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut config = test_config(format!("http://{addr}/v1"));
        config.model.provider = "openai".into();
        let session_id = "s".repeat(80);

        let result = chat_with_session(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
            Some(&session_id),
        )
        .await
        .unwrap();

        assert_eq!(
            result.usage,
            Some(Usage {
                prompt_tokens: 16,
                completion_tokens: 5,
                cache_read_tokens: 80,
                cache_write_tokens: 4,
                total_tokens: 105,
            })
        );
        let body = captured.lock().unwrap().clone().expect("request captured");
        assert_eq!(body["prompt_cache_key"].as_str().unwrap().len(), 64);
    }

    #[tokio::test]
    async fn compatible_provider_does_not_receive_openai_cache_key() {
        let captured: Arc<std::sync::Mutex<Option<Value>>> = Arc::new(std::sync::Mutex::new(None));
        let captured_for_route = captured.clone();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |axum::Json(body): axum::Json<Value>| {
                let captured = captured_for_route.clone();
                async move {
                    *captured.lock().unwrap() = Some(body);
                    success_sse()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let config = test_config(format!("http://{addr}/v1"));

        chat_with_session(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
            Some("session-1"),
        )
        .await
        .unwrap();

        let body = captured.lock().unwrap().clone().expect("request captured");
        assert!(body.get("prompt_cache_key").is_none());
        assert!(
            body.get("stream_options").is_none(),
            "unknown compatible providers must not receive optional stream fields"
        );
    }

    #[test]
    fn anthropic_cache_control_marks_the_system_and_a_rolling_window() {
        let messages = vec![
            json!({ "role": "system", "content": "you are cali" }),
            json!({ "role": "user", "content": "build a level" }),
            json!({ "role": "assistant", "content": "", "tool_calls": [] }),
            json!({ "role": "tool", "tool_call_id": "c1", "content": "{\"ok\":true}" }),
            json!({ "role": "assistant", "content": "placed the floor" }),
            json!({ "role": "user", "content": "continue" }),
        ];
        let marked = apply_anthropic_cache_control(&messages, CacheRetention::Short);

        let ephemeral = json!({ "type": "ephemeral" });
        assert_eq!(marked[0]["content"][0]["cache_control"], ephemeral);
        assert_eq!(marked[0]["content"][0]["text"], json!("you are cali"));
        // The three newest markable turns, so a tool loop's own output is a
        // cache read next turn instead of a full re-bill.
        for index in [1, 4, 5] {
            assert_eq!(
                marked[index]["content"][0]["cache_control"], ephemeral,
                "message {index} should carry a rolling breakpoint"
            );
        }
        // A marker on a tool result hangs OpenRouter, so that role stays bare.
        assert_eq!(marked[3], messages[3]);
        // An assistant turn carrying only tool calls has no markable content;
        // it is skipped without spending one of the three breakpoints.
        assert_eq!(marked[2], messages[2]);
    }

    #[test]
    fn anthropic_cache_control_never_exceeds_the_four_breakpoint_ceiling() {
        let mut messages = vec![json!({ "role": "system", "content": "you are cali" })];
        for turn in 0..20 {
            messages.push(json!({ "role": "user", "content": format!("turn {turn}") }));
            messages.push(json!({ "role": "assistant", "content": format!("done {turn}") }));
        }
        let marked = apply_anthropic_cache_control(&messages, CacheRetention::Short);
        let breakpoints = marked
            .iter()
            .filter(|message| {
                message["content"].as_array().is_some_and(|parts| {
                    parts.iter().any(|part| part.get("cache_control").is_some())
                })
            })
            .count();
        assert_eq!(
            breakpoints, 4,
            "Anthropic rejects a request carrying more than four breakpoints"
        );
    }

    #[test]
    fn anthropic_cache_control_skips_empty_content_and_uses_long_ttl() {
        let empty = vec![json!({ "role": "user", "content": "   " })];
        assert_eq!(
            apply_anthropic_cache_control(&empty, CacheRetention::Short),
            empty,
            "an empty text block would be rejected by Anthropic"
        );

        let parts = vec![json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "look" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }
            ]
        })];
        let marked = apply_anthropic_cache_control(&parts, CacheRetention::Long);
        assert_eq!(
            marked[0]["content"][1]["cache_control"],
            json!({ "type": "ephemeral", "ttl": "1h" })
        );
        assert!(marked[0]["content"][0].get("cache_control").is_none());
    }

    #[tokio::test]
    async fn openrouter_claude_receives_cache_control_but_gpt_does_not() {
        for (model, expects_marker) in [
            ("anthropic/claude-sonnet-4-5", true),
            ("openai/gpt-4o", false),
        ] {
            let captured: Arc<std::sync::Mutex<Option<Value>>> =
                Arc::new(std::sync::Mutex::new(None));
            let captured_for_route = captured.clone();
            let app = Router::new().route(
                "/v1/chat/completions",
                post(move |axum::Json(body): axum::Json<Value>| {
                    let captured = captured_for_route.clone();
                    async move {
                        *captured.lock().unwrap() = Some(body);
                        success_sse()
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

            let mut config = test_config(format!("http://{addr}/v1"));
            config.model.provider = "openrouter".into();
            config.model.default = model.into();
            chat_with_session(
                &config,
                &[
                    json!({ "role": "system", "content": "you are cali" }),
                    json!({ "role": "user", "content": "hello" }),
                ],
                None,
                None,
                Some("session-1"),
            )
            .await
            .unwrap();

            let body = captured.lock().unwrap().clone().expect("request captured");
            let system = &body["messages"][0];
            if expects_marker {
                assert_eq!(
                    system["content"][0]["cache_control"],
                    json!({ "type": "ephemeral" }),
                    "{model} must carry its own breakpoints"
                );
            } else {
                assert_eq!(
                    system["content"],
                    json!("you are cali"),
                    "{model} caches automatically; markers would be wrong"
                );
            }
        }
    }

    #[tokio::test]
    async fn codex_router_chat_flattens_provider_qualified_catalog_model() {
        let captured: Arc<std::sync::Mutex<Option<Value>>> = Arc::new(std::sync::Mutex::new(None));
        let captured_for_route = captured.clone();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |axum::Json(body): axum::Json<Value>| {
                let captured = captured_for_route.clone();
                async move {
                    *captured.lock().unwrap() = Some(body);
                    success_sse()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let mut config = test_config(format!("http://{addr}/v1"));
        config.model.provider = crate::config::CODEX_ROUTER_PROVIDER_ID.into();
        config.model.default = "minimax-token-plan/minimax-m3".into();
        chat_with_effort_session(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
            Some("high"),
            Some("session-minimax"),
        )
        .await
        .unwrap();

        let body = captured.lock().unwrap().clone().expect("request captured");
        assert_eq!(body["model"], json!("minimax-token-plan-minimax-m3"));
        assert_eq!(body["reasoning_effort"], json!("high"));
        assert_eq!(config.model.default, "minimax-token-plan/minimax-m3");
    }

    #[test]
    fn cache_retention_parsing_matches_pi_defaults() {
        assert_eq!(parse_cache_retention(None), CacheRetention::Short);
        assert_eq!(parse_cache_retention(Some(" long ")), CacheRetention::Long);
        assert_eq!(parse_cache_retention(Some("NONE")), CacheRetention::None);
        assert_eq!(
            parse_cache_retention(Some("unexpected")),
            CacheRetention::Short
        );
    }

    #[test]
    fn luna_uses_router_responses_transport_and_gateway_id() {
        let mut config = test_config("http://127.0.0.1:4100/v1".into());
        config.model.provider = crate::config::CODEX_ROUTER_PROVIDER_ID.into();
        config.model.default = "opencode-go-responses/gpt-5.6-luna".into();
        assert!(is_codex_router_luna(&config));
        assert_eq!(
            codex_router_luna_gateway_model(&config.model.default),
            CODEX_ROUTER_LUNA_GATEWAY_MODEL
        );
        assert!(!provider_capabilities(&config).supports_usage_in_stream);
    }

    #[test]
    fn responses_input_preserves_tool_call_pairs() {
        let input = responses_input(&[
            json!({ "role": "system", "content": "rules" }),
            json!({ "role": "user", "content": "hello" }),
            json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call-1",
                    "type": "function",
                    "function": { "name": "editor_echo", "arguments": "{\"message\":\"hi\"}" }
                }]
            }),
            json!({ "role": "tool", "tool_call_id": "call-1", "content": "{\"ok\":true}" }),
        ]);
        assert_eq!(input[0]["role"], json!("developer"));
        assert_eq!(input[1]["content"][0]["type"], json!("input_text"));
        assert_eq!(input[2]["type"], json!("function_call"));
        assert_eq!(input[2]["call_id"], json!("call-1"));
        assert_eq!(input[3]["type"], json!("function_call_output"));
        assert_eq!(input[3]["call_id"], json!("call-1"));
    }

    #[test]
    fn responses_payload_parses_text_tools_and_usage() {
        let mut content = String::new();
        let mut tools = Vec::new();
        let mut usage = None;
        let mut received = false;
        let mut text_filter = VisibleTextFilter::default();
        let payloads = [
            json!({ "type": "response.output_text.delta", "delta": "Hello" }),
            json!({
                "type": "response.output_item.added",
                "output_index": 1,
                "item": { "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "editor_echo", "arguments": "" }
            }),
            json!({
                "type": "response.function_call_arguments.delta",
                "output_index": 1,
                "item_id": "fc_1",
                "delta": "{\"message\":\"hi\"}"
            }),
            json!({
                "type": "response.completed",
                "response": {
                    "usage": {
                        "input_tokens": 100,
                        "output_tokens": 7,
                        "total_tokens": 107,
                        "input_tokens_details": { "cached_tokens": 80, "cache_write_tokens": 4 }
                    }
                }
            }),
        ];
        for payload in payloads {
            assert!(apply_responses_payload(
                &payload,
                &mut content,
                &mut tools,
                &mut usage,
                &mut text_filter,
                None,
                &mut received
            )
            .is_none());
        }
        assert_eq!(content, "Hello");
        assert_eq!(tools[1].id, "call_1");
        assert_eq!(tools[1].name, "editor_echo");
        assert_eq!(tools[1].arguments, "{\"message\":\"hi\"}");
        assert_eq!(
            usage,
            Some(Usage {
                prompt_tokens: 16,
                completion_tokens: 7,
                cache_read_tokens: 80,
                cache_write_tokens: 4,
                total_tokens: 107,
            })
        );
    }

    #[tokio::test]
    async fn chat_survives_one_injected_500() {
        let (base_url, hits) = spawn_mock(1, StatusCode::INTERNAL_SERVER_ERROR).await;
        let config = test_config(base_url);
        // Public path: proves the default schedule retries transparently.
        let result = chat(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
        )
        .await
        .unwrap();
        assert!(result.content.contains("Hello from CaliCode"));
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn chat_does_not_retry_401() {
        let (base_url, hits) = spawn_mock(usize::MAX, StatusCode::UNAUTHORIZED).await;
        let config = test_config(base_url);
        let err = chat_with_backoff(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
            &[0, 0, 0],
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("401"), "unexpected error: {err}");
        assert_eq!(hits.load(Ordering::SeqCst), 1, "401 must not be retried");
    }

    #[tokio::test]
    async fn chat_retries_429_until_exhausted() {
        let (base_url, hits) = spawn_mock(usize::MAX, StatusCode::TOO_MANY_REQUESTS).await;
        let config = test_config(base_url);
        let err = chat_with_backoff(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
            &[0, 0, 0],
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("429"), "unexpected error: {err}");
        // Initial attempt + one retry per backoff slot.
        assert_eq!(hits.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn fallback_provider_engages_after_retries_exhaust() {
        let (primary_url, primary_hits) =
            spawn_mock(usize::MAX, StatusCode::INTERNAL_SERVER_ERROR).await;
        let (fallback_url, fallback_hits) = spawn_mock(0, StatusCode::OK).await;
        let mut config = test_config(primary_url);
        config.providers = vec![crate::config::ProviderPreset {
            id: "fb".into(),
            label: "Fallback".into(),
            base_url: fallback_url,
            api_key_env: "CALI_FB_KEY".into(),
            models: vec!["fb-model".into()],
        }];
        config.fallback_providers = vec!["fb".into()];
        let result = chat_with_backoff(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
            &[0],
        )
        .await
        .unwrap();
        assert!(result.content.contains("Hello from CaliCode"));
        assert_eq!(primary_hits.load(Ordering::SeqCst), 2); // initial + 1 retry
        assert_eq!(fallback_hits.load(Ordering::SeqCst), 1);
        // Turn-scoped: the active provider config is untouched.
        assert_eq!(config.model.provider, "mock");
    }

    #[tokio::test]
    async fn fallback_does_not_engage_on_auth_error() {
        let (primary_url, _primary_hits) = spawn_mock(usize::MAX, StatusCode::UNAUTHORIZED).await;
        let (fallback_url, fallback_hits) = spawn_mock(0, StatusCode::OK).await;
        let mut config = test_config(primary_url);
        config.providers = vec![crate::config::ProviderPreset {
            id: "fb".into(),
            label: "Fallback".into(),
            base_url: fallback_url,
            api_key_env: "CALI_FB_KEY".into(),
            models: vec![],
        }];
        config.fallback_providers = vec!["fb".into()];
        let err = chat_with_backoff(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
            &[0, 0, 0],
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("401"), "unexpected error: {err}");
        assert_eq!(
            fallback_hits.load(Ordering::SeqCst),
            0,
            "auth errors must not trigger fallback"
        );
    }

    #[tokio::test]
    async fn mid_stream_failure_is_not_retried() {
        // Streams one real delta, then kills the connection mid-body.
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_for_route = hits.clone();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move || {
                let hits = hits_for_route.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    // Delay before the injected error so the client reliably
                    // consumes the first delta before the connection dies.
                    let chunks = futures::stream::iter(vec![Ok::<_, std::io::Error>(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
                    )])
                    .chain(futures::stream::once(async {
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        Err(std::io::Error::other("injected mid-stream drop"))
                    }));
                    Response::builder()
                        .header("content-type", "text/event-stream")
                        .body(axum::body::Body::from_stream(chunks))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let config = test_config(format!("http://{}/v1", addr));
        let err = chat_with_backoff(
            &config,
            &[json!({ "role": "user", "content": "hello" })],
            None,
            None,
            &[0, 0, 0],
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains("stream read failed"),
            "unexpected error: {err}"
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "mid-stream failures after content must not be retried"
        );
    }

    #[test]
    fn fallback_config_swaps_provider_fields() {
        let mut config = test_config("http://127.0.0.1:1/v1".into());
        config.providers = vec![crate::config::ProviderPreset {
            id: "fb".into(),
            label: "Fallback".into(),
            base_url: "http://127.0.0.1:2/v1".into(),
            api_key_env: "CALI_FB_KEY".into(),
            models: vec!["fb-model".into()],
        }];
        let fb = fallback_config(&config, "fb").unwrap();
        assert_eq!(fb.model.provider, "fb");
        assert_eq!(fb.model.base_url, "http://127.0.0.1:2/v1");
        assert_eq!(fb.model.api_key_env, "CALI_FB_KEY");
        // Preset doesn't list the current model → first preset model wins.
        assert_eq!(fb.model.default, "fb-model");
        assert!(fallback_config(&config, "missing").is_none());
    }
}
