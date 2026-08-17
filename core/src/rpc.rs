use crate::agent::AgentOptions;
use crate::assets;
use crate::baselines;
use crate::checkpoints;
use crate::devserver;
use crate::image3d;
use crate::starters;
use crate::store;
use crate::tools::{model_list, model_switch, ToolDef};
use crate::video_analysis;
use crate::workspace;
use crate::AppState;
use anyhow::{Context, Result};
use async_trait::async_trait;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::State;
use axum::extract::{FromRequest, Request};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

/// Maximum bytes accepted on `/rpc`. Mirrored on the request via
/// `DefaultBodyLimit::max` so a body larger than this returns a structured
/// JSON-RPC error instead of axum's plain-text 413, which the client used to
/// mis-parse as a transport outage and surface as "core offline".
pub const RPC_BODY_LIMIT_BYTES: usize = video_analysis::RPC_BODY_LIMIT_BYTES;

/// JSON-RPC envelope extracted from the request body. The body cap is
/// enforced by the `DefaultBodyLimit` layer on the `/rpc` route; this
/// extractor funnels both "body too large" and "malformed JSON" through one
/// path that emits a proper JSON-RPC error envelope. The client can then
/// surface `error.message` instead of failing on `response.json()`.
pub struct RpcEnvelope {
    pub value: Value,
}

#[async_trait]
impl<S> FromRequest<S> for RpcEnvelope
where
    Bytes: FromRequest<S, Rejection = BytesRejection>,
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = Bytes::from_request(req, state).await.map_err(|err| {
            let (code, message) = if err.status() == StatusCode::PAYLOAD_TOO_LARGE {
                (
                    -32001,
                    format!(
                        "request body exceeds the {} MB RPC limit",
                        RPC_BODY_LIMIT_BYTES / (1024 * 1024)
                    ),
                )
            } else {
                (-32000, format!("request body error: {}", err.body_text()))
            };
            jsonrpc_error_response(Value::Null, code, &message)
        })?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|err| {
            let id = peek_id_from_bytes(&bytes).unwrap_or(Value::Null);
            jsonrpc_error_response(id, -32700, &format!("invalid JSON: {err}"))
        })?;
        Ok(RpcEnvelope { value })
    }
}

/// Builds a JSON-RPC error envelope with HTTP 200 so the response is
/// always valid JSON-RPC. The application error lives inside the envelope;
/// the transport-level status stays 200 per JSON-RPC 2.0 over HTTP guidance.
fn jsonrpc_error_response(id: Value, code: i32, message: &str) -> Response {
    Json(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    }))
    .into_response()
}

/// Best-effort `id` extraction from a possibly-truncated JSON body so the
/// error envelope still references the request it failed on. Returns `None`
/// when the body is not valid JSON.
fn peek_id_from_bytes(bytes: &[u8]) -> Option<Value> {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| value.get("id").cloned())
}

pub async fn rpc_handler(State(state): State<AppState>, envelope: RpcEnvelope) -> Json<Value> {
    let id = envelope.value.get("id").cloned().unwrap_or(Value::Null);
    let method = envelope
        .value
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let params = envelope
        .value
        .get("params")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let result = dispatch(&state, &method, params).await;
    match result {
        Ok(value) => Json(json!({ "jsonrpc": "2.0", "id": id, "result": value })),
        Err(error) => Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32000, "message": error.to_string() }
        })),
    }
}

async fn dispatch(state: &AppState, method: &str, params: Value) -> Result<Value> {
    match method {
        "ping" => Ok(json!({ "pong": true, "version": env!("CARGO_PKG_VERSION") })),
        "config.read" => {
            let config = state.config.read().await;
            let mut value = serde_json::to_value(&*config)?;
            // The *resolved* confinement state, not the configured one. The
            // config says what was asked for; `sandbox::status()` says what
            // this machine actually got — Seatbelt can be unavailable, or
            // switched off by `CALI_SANDBOX`. The UI told the user "not
            // sandboxed" from a hardcoded string, which is a claim that cannot
            // be right in every case and was never checked against anything.
            //
            // Carried on `config.read` rather than a new method because the
            // client already fetches it for the context meter; a second round
            // trip to answer one line of dropdown text is not worth it.
            if let Some(object) = value.as_object_mut() {
                object.insert("sandboxStatus".into(), crate::sandbox::status());
            }
            Ok(value)
        }
        "model_list" => {
            let config = state.config.read().await;
            Ok(model_list(&config)?)
        }
        // Per-model token totals for Settings → Status. Read-only and cheap:
        // the ledger is already in memory, so the page may poll it.
        "usage_stats" => Ok(state.agents.usage_ledger().report()),
        "usage_reset" => {
            state.agents.usage_ledger().reset();
            Ok(state.agents.usage_ledger().report())
        }
        "model_switch" => {
            let mut config = state.config.write().await;
            Ok(model_switch(
                &mut config,
                str_param(&params, "provider")?,
                str_param(&params, "model")?,
            )?)
        }
        "model_provider_upsert" => {
            let models: Vec<String> = params
                .get("models")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let mut config = state.config.write().await;
            Ok(crate::tools::model_provider_upsert(
                &mut config,
                str_param(&params, "id")?,
                params.get("label").and_then(Value::as_str),
                params.get("baseUrl").and_then(Value::as_str),
                params.get("apiKey").and_then(Value::as_str),
                &models,
            )?)
        }
        // `ownerSession` is the caller's own session: a directly spawned
        // subagent asks for approval under a fresh session id no panel has
        // open, so without it the prompt is addressed to nobody and parks
        // until core's approval timeout. It only names the owner — routing and
        // permissions are unchanged — and it is read from the RPC params here
        // rather than from the tool arguments, which a model controls.
        "subagent_spawn" => {
            crate::tools::spawn_subagent_for_client(
                state,
                &params,
                params
                    .get("ownerSession")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|session| !session.is_empty()),
            )
            .await
        }
        "project_create" => {
            let slug = str_param(&params, "slug")?;
            let title = params.get("title").and_then(|v| v.as_str()).unwrap_or(slug);
            let template = params
                .get("template")
                .and_then(Value::as_str)
                .unwrap_or(store::DEFAULT_PROJECT_TEMPLATE);
            Ok(store::create_project_from_template(
                &state.projects_root,
                slug,
                title,
                template,
            )?)
        }
        "project_list" => Ok(store::list_projects(&state.projects_root)?),
        "project_open" => {
            let slug = str_param(&params, "slug")?;
            let project = store::read_project(&state.projects_root, slug)?;
            // Apply this project's MCP scope: `.cali/config.yaml` in the
            // attached workspace (or the project folder) merged per-id over
            // the global server list. Reconciliation leaves unchanged servers
            // running, so re-opening a project is cheap.
            let base = project
                .get("workspaceRoot")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(std::path::PathBuf::from)
                .filter(|path| path.is_dir())
                .or_else(|| store::project_dir(&state.projects_root, slug).ok());
            if let Some(base) = base {
                apply_mcp_project_scope(state, &base).await;
            }
            Ok(project)
        }
        "project_save" => {
            let project = params.get("project").context("project missing")?;
            store::validate_project(project)?;
            let slug = str_param(project, "slug")?;
            store::write_project(&state.projects_root, slug, project)?;
            Ok(json!({ "saved": true, "slug": slug }))
        }
        "project_set_workspace" => Ok(store::set_workspace_root(
            &state.projects_root,
            str_param(&params, "slug")?,
            params.get("workspaceRoot").and_then(|v| v.as_str()),
        )?),
        "project_rename" => Ok(store::rename_project(
            &state.projects_root,
            str_param(&params, "slug")?,
            str_param(&params, "title")?,
        )?),
        "project_reveal" => {
            let path = store::project_location(&state.projects_root, str_param(&params, "slug")?)?;
            reveal_in_file_manager(&path)?;
            Ok(json!({ "path": path }))
        }
        "project_create_worktree" => Ok(store::create_permanent_worktree(
            &state.projects_root,
            str_param(&params, "slug")?,
        )?),
        "project_delete" => {
            let slug = str_param(&params, "slug")?;
            // Delete the project first so a failed "last project" guard or
            // other store error leaves every session/worktree recoverable.
            let project = store::delete_project(&state.projects_root, slug)?;
            let sessions = delete_project_sessions(state, slug).await?;
            Ok(json!({ "project": project, "sessions": sessions }))
        }
        "project_checkpoint" => Ok(store::checkpoint_project(
            &state.projects_root,
            str_param(&params, "slug")?,
        )?),
        "project_revert" => Ok(store::revert_checkpoint(
            &state.projects_root,
            str_param(&params, "slug")?,
            str_param(&params, "checkpointId")?,
        )?),
        "project_starter" => Ok(serde_json::from_str(store::SAMPLE_PROJECT)?),

        // Restore points. `project_checkpoint`/`project_revert` above remain
        // the project-directory-only pair the agent's tools call; these four
        // are the surface that also covers an attached repository, and the
        // only one that can enumerate or bound what is on disk.
        "checkpoint_create" => {
            checkpoints::create(&state.projects_root, str_param(&params, "slug")?)
        }
        "checkpoint_list" => checkpoints::list(&state.projects_root, str_param(&params, "slug")?),
        "checkpoint_restore" => checkpoints::restore(
            &state.projects_root,
            str_param(&params, "slug")?,
            str_param(&params, "id")?,
        ),
        "checkpoint_prune" => checkpoints::prune(
            &state.projects_root,
            str_param(&params, "slug")?,
            params
                .get("keep")
                .and_then(Value::as_u64)
                .context("missing required number keep")? as usize,
        ),

        // Workspaces: a real folder on disk that CaliCode edits in place.
        // workspace_open is the only method that accepts an absolute path.
        "workspace_open" => {
            let path = str_param(&params, "path")?;
            // Probe before taking the registry lock. A folder on a volume the
            // app has not been granted access to does not error — the read
            // blocks indefinitely, which used to hang this RPC forever while
            // holding the write lock, freezing every other workspace call and
            // showing the user nothing but "no folder attached".
            probe_readable(path).await?;
            let mut registry = state.workspaces.write().await;
            let described = workspace::open(
                &mut registry,
                path,
                params.get("name").and_then(Value::as_str),
            )?;
            persist_workspaces(state, workspace::roots(&registry)).await;
            drop(registry);
            // A freshly attached folder may carry `.cali/config.yaml` MCP
            // overrides — apply them the same way project_open does.
            if let Some(root) = described.get("root").and_then(Value::as_str) {
                apply_mcp_project_scope(state, std::path::Path::new(root)).await;
            }
            Ok(described)
        }
        "starter_list" => Ok(json!({
            "starters": starters::list().iter().map(starters::Starter::describe).collect::<Vec<_>>(),
        })),
        "workspace_create_from_template" => {
            let template = str_param(&params, "templateId")?;
            let path = str_param(&params, "path")?;
            let starter = starters::get(template)?;
            let root = starters::create(template, path)?;

            let mut registry = state.workspaces.write().await;
            let described = workspace::open(
                &mut registry,
                &root.to_string_lossy(),
                params.get("name").and_then(Value::as_str),
            )?;
            persist_workspaces(state, workspace::roots(&registry)).await;
            drop(registry);

            Ok(json!({
                "workspace": described,
                "starter": starter.describe(),
                // The client offers this; core never spawns it. Installing
                // needs the network, and the only sanctioned way to run a
                // command on the user's machine is a user-initiated terminal.
                "install": starter.manifest.install,
            }))
        }
        "workspace_list" => Ok(workspace::list(&*state.workspaces.read().await)),
        "workspace_browse" => {
            // Same volume-permission hazard as workspace_open: probe before
            // the blocking read so an unauthorized folder can't hang the RPC.
            let expanded = params
                .get("path")
                .and_then(Value::as_str)
                .filter(|p| !p.trim().is_empty())
                .map(workspace::shellexpand);
            if let Some(path) = expanded.as_deref() {
                probe_readable(path).await?;
            }
            workspace::browse(expanded.as_deref())
        }
        "workspace_close" => {
            let id = str_param(&params, "id")?.to_string();
            devserver::stop(&mut *state.dev_servers.write().await, &id).await?;
            let roots = {
                let mut registry = state.workspaces.write().await;
                registry.remove(&id);
                workspace::roots(&registry)
            };
            persist_workspaces(state, roots).await;
            Ok(json!({ "closed": true, "id": id }))
        }
        "workspace_tree" => {
            let registry = state.workspaces.read().await;
            let workspace = workspace::get(&registry, str_param(&params, "id")?)?;
            let depth = params.get("depth").and_then(Value::as_u64).unwrap_or(1) as u32;
            let hidden = params
                .get("includeHidden")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            workspace::tree(
                workspace,
                params.get("path").and_then(Value::as_str).unwrap_or(""),
                depth,
                hidden,
            )
        }
        "workspace_file_read" => {
            let registry = state.workspaces.read().await;
            let workspace = workspace::get(&registry, str_param(&params, "id")?)?;
            workspace::read_file(workspace, str_param(&params, "path")?)
        }
        "workspace_file_write" => {
            let registry = state.workspaces.read().await;
            let workspace = workspace::get(&registry, str_param(&params, "id")?)?;
            workspace::write_file(
                workspace,
                str_param(&params, "path")?,
                str_param(&params, "content")?,
                params.get("expectedSha256").and_then(Value::as_str),
            )
        }
        "devserver_start" => {
            let registry = state.workspaces.read().await;
            let workspace = workspace::get(&registry, str_param(&params, "id")?)?.clone();
            drop(registry);
            let script = params
                .get("script")
                .and_then(Value::as_str)
                .unwrap_or("dev");
            devserver::start(
                &mut *state.dev_servers.write().await,
                &workspace,
                script,
                state.bus.clone(),
            )
            .await
        }
        "devserver_stop" => {
            devserver::stop(
                &mut *state.dev_servers.write().await,
                str_param(&params, "id")?,
            )
            .await
        }
        "devserver_status" => Ok(devserver::status(
            &*state.dev_servers.read().await,
            str_param(&params, "id")?,
        )),
        "devserver_logs" => {
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(200) as usize;
            Ok(devserver::logs(
                &*state.dev_servers.read().await,
                str_param(&params, "id")?,
                limit.min(2000),
            ))
        }
        // Terminal: shell work the *user* asked for, in their workspace.
        // Deliberately outside the agent approval flow and absent from
        // `tools.rs` — and the pty half is not confined to the workspace at
        // all. Read the module comment in `terminal.rs` before changing that.
        "terminal_run" => state.terminals.start(
            &terminal_root(state, &params).await?,
            str_param(&params, "command")?,
            params.get("cwd").and_then(Value::as_str),
            state.bus.clone(),
        ),
        // Browser: the BROWSER tab and the agent drive the same Chrome.
        //
        // The tab's URL bar goes through the agent's own tool defs (the
        // `asset_search` parity pattern above) rather than a parallel handler,
        // so a URL the user types and a URL the model navigates to are
        // normalized, refused, and settled by exactly one code path.
        "browser_navigate" | "browser_search" | "browser_snapshot" | "browser_click"
        | "browser_type" | "browser_key" | "browser_scroll" | "browser_mouse_move"
        | "browser_play" | "browser_screenshot" | "browser_look" | "browser_console"
        | "browser_downloads" | "browser_eval" | "browser_close" => {
            let def = crate::tools::core_tool_defs()
                .into_iter()
                .find(|tool| tool.name == method)
                .with_context(|| format!("{method} tool is unavailable"))?;
            crate::tools::execute_core_tool(&def, &params, state, &state.projects_root, None).await
        }
        // The desktop shell hands core the panel it just created, so core drives
        // the view the user is looking at instead of a headless Chrome of its
        // own. Not discovered by url or title: guessing would eventually pick
        // the editor's own window and core would start driving the app.
        "browser_attach" => {
            let browser = state
                .browsers
                .attach(
                    str_param(&params, "endpoint")?,
                    str_param(&params, "targetId")?,
                    state.bus.clone(),
                )
                .await?;
            let (width, height) = browser.shape();
            Ok(json!({
                "attached": true,
                "viewport": { "width": width, "height": height },
            }))
        }
        // Deliberately never launches one: the tab polls this, and a poll that
        // starts a browser would have every open editor spawn a Chrome.
        "browser_status" => match state.browsers.current().await {
            Some(browser) => {
                let location = browser.location().await.unwrap_or_else(|_| json!({}));
                let (width, height) = browser.shape();
                Ok(json!({
                    "running": true,
                    "icon": browser.icon().await,
                    "viewport": { "width": width, "height": height },
                    "url": location.get("url").cloned().unwrap_or(Value::Null),
                    "title": location.get("title").cloned().unwrap_or(Value::Null),
                }))
            }
            None => Ok(json!({ "running": false })),
        },
        // The tab reports its own shape; core decides what to do with it.
        "browser_viewport" => {
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            let shape = browser
                .set_shape(
                    params["width"].as_u64().unwrap_or(0) as u32,
                    params["height"].as_u64().unwrap_or(0) as u32,
                )
                .await?;
            // Reshaping changes the aspect of every future frame, but chrome
            // emits one only on repaint — and a settled results page never
            // repaints. The panel was left scaling its last frame, taken at
            // the previous shape, into a box that no longer matches it: the
            // page appeared zoomed and cropped, permanently. Pushing a capture
            // is what makes the new shape visible.
            if let Some(frame) = browser.current_frame().await {
                let _ = state.bus.send(frame);
            }
            Ok(shape)
        }
        "browser_cast_start" => {
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            // The panel reports the pixel width it will draw into; anything
            // beyond that is decoded and scaled away on arrival.
            if let Some(width) = params["width"].as_u64() {
                browser.set_cast_size(width as u32).await?;
            }
            browser.start_cast().await?;
            // The current frame rides back with the reply so a panel that just
            // mounted paints immediately instead of waiting for a repaint —
            // which on a still page never comes at all.
            Ok(json!({ "casting": true, "frame": browser.current_frame().await }))
        }
        // Called when the tab is hidden or unmounted. Frames share the SSE bus
        // with agent tokens, so an unwatched screencast is the loudest thing
        // on it for no benefit.
        // A panel that finds itself with no frame asks for one here rather
        // than waiting on a repaint that may never come.
        "browser_frame" => match state.browsers.current().await {
            Some(browser) => Ok(json!({ "frame": browser.current_frame().await })),
            None => Ok(json!({ "frame": Value::Null })),
        },
        "browser_cast_stop" => {
            if let Some(browser) = state.browsers.current().await {
                browser.stop_cast().await?;
            }
            Ok(json!({ "casting": false }))
        }
        "browser_input" => {
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            browser_input(&browser, &params).await
        }
        "browser_history" => {
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            let delta = params["delta"].as_i64().unwrap_or(-1);
            browser
                .eval(&format!("history.go({delta}); true"))
                .await
                .map(|_| json!({ "moved": delta }))
        }
        "browser_reload" => {
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            browser
                .call("Page.reload", json!({ "ignoreCache": false }))
                .await
                .map(|_| json!({ "reloaded": true }))
        }
        "terminal_kill" => Ok(state.terminals.kill(str_param(&params, "runId")?)),
        "terminal_runs" => Ok(state.terminals.list()),
        "terminal_open" => {
            state
                .terminals
                .open(
                    &terminal_root(state, &params).await?,
                    size_param(&params, "cols", crate::terminal::DEFAULT_COLS),
                    size_param(&params, "rows", crate::terminal::DEFAULT_ROWS),
                    state.bus.clone(),
                )
                .await
        }
        "terminal_input" => {
            state
                .terminals
                .input(
                    str_param(&params, "sessionId")?,
                    str_param(&params, "data")?,
                )
                .await
        }
        "terminal_resize" => state.terminals.resize(
            str_param(&params, "sessionId")?,
            size_param(&params, "cols", crate::terminal::DEFAULT_COLS),
            size_param(&params, "rows", crate::terminal::DEFAULT_ROWS),
        ),
        "terminal_close" => Ok(state.terminals.close(str_param(&params, "sessionId")?)),
        "terminal_sessions" => Ok(state.terminals.sessions()),
        "file_read" => {
            let slug = str_param(&params, "slug")?;
            let (_, path) = crate::tools::resolve_game_file(
                &state.projects_root,
                slug,
                str_param(&params, "path")?,
            )?;
            let content = std::fs::read_to_string(&path)?;
            Ok(json!({ "path": params["path"], "content": content }))
        }
        "file_write" => {
            let slug = str_param(&params, "slug")?;
            let (base, path) = crate::tools::resolve_game_file(
                &state.projects_root,
                slug,
                str_param(&params, "path")?,
            )?;
            crate::tools::reject_protected_write(&base, &path)?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, str_param(&params, "content")?)?;
            Ok(json!({ "path": params["path"], "written": true }))
        }
        "asset_import_file" => {
            let tags = params["tags"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Ok(assets::import_file(
                &state.projects_root,
                str_param(&params, "slug")?,
                str_param(&params, "name")?,
                str_param(&params, "data")?,
                str_param(&params, "mime")?,
                tags,
            )?)
        }
        "blender_asset_import" => Ok(crate::blender::import_asset(
            &state.projects_root,
            str_param(&params, "slug")?,
            str_param(&params, "name")?,
            str_param(&params, "data")?,
        )?),
        "blender_asset_open" => crate::blender::open(
            &state.projects_root,
            str_param(&params, "slug")?,
            str_param(&params, "assetId")?,
        ),
        "blender_asset_export" => {
            crate::blender::export(
                &state.projects_root,
                str_param(&params, "slug")?,
                str_param(&params, "assetId")?,
                crate::blender::DEFAULT_EXPORT_TIMEOUT,
            )
            .await
        }
        "blender_asset_status" => crate::blender::status(
            &state.projects_root,
            str_param(&params, "slug")?,
            str_param(&params, "assetId")?,
        ),
        "asset_list" => {
            let project = store::read_project(&state.projects_root, str_param(&params, "slug")?)?;
            Ok(project["assets"].clone())
        }
        "asset_files" => Ok(assets::list_files(
            &state.projects_root,
            str_param(&params, "slug")?,
        )?),
        "asset_hash_dedupe" => Ok(assets::dedupe(
            &state.projects_root,
            str_param(&params, "slug")?,
        )?),
        "asset_usage" => Ok(assets::usage(
            &state.projects_root,
            str_param(&params, "slug")?,
        )?),
        "asset_export_gltf" => Ok(image3d::export_gltf(
            &state.projects_root,
            str_param(&params, "slug")?,
            str_param(&params, "assetId")?,
        )?),
        // Client parity with the agent tools: same defs, same dispatch, so
        // the UI and the agent can never diverge on argument handling.
        "asset_search" | "asset_pick" | "image3d_mesh" => {
            let def = crate::tools::core_tool_defs()
                .into_iter()
                .find(|def| def.name == method)
                .context("core tool def missing")?;
            crate::tools::execute_core_tool(&def, &params, state, &state.projects_root, None).await
        }
        "asset_catalog_publish" => {
            // Whole-set replacement: the client owns the catalogue and
            // republishes it on change, so stale library entries never linger.
            let entries = crate::asset_search::normalize_catalog_entries(&params["entries"])?;
            let count = entries.len();
            *state.asset_catalog.write().await = entries;
            Ok(json!({ "count": count }))
        }
        "project_asset_write" => Ok(assets::write_project_asset(
            &state.projects_root,
            str_param(&params, "slug")?,
            str_param(&params, "assetId")?,
            str_param(&params, "content")?,
        )?),
        "skill_list" => {
            let skills_cfg = { state.config.read().await.skills.clone() };
            let slug = params.get("projectSlug").and_then(Value::as_str);
            Ok(json!({
                "skills": crate::skills::list_skills(&state.projects_root, slug, &skills_cfg)
            }))
        }
        // The loop driver lives in core so a run outlives the tab that
        // started it (`loop_run.rs`). The prompt-assembly stays here, where
        // `default_system_prompt` already lives.
        "loop_start" => {
            let slug = str_param(&params, "projectSlug")?.to_string();
            let goal = str_param(&params, "goal")?.to_string();
            let profile = crate::loop_run::LoopProfile::parse(
                params.get("profile").and_then(Value::as_str).unwrap_or(""),
            );
            let permission_mode = params
                .get("permissionMode")
                .and_then(Value::as_str)
                .unwrap_or(crate::agent::DEFAULT_PERMISSION_MODE)
                .to_string();
            let mut registered = state.tools.read().await.clone();
            registered.extend(state.mcp.tool_defs().await);
            let (skills_cfg, hooks_cfg) = {
                let config = state.config.read().await;
                (config.skills.clone(), config.hooks.clone())
            };
            let mut system = default_system_prompt(state, &slug, &skills_cfg, &registered);
            system.push_str(permission_mode_prompt(&permission_mode));
            let workspace_root = params
                .get("workspaceRoot")
                .and_then(Value::as_str)
                .map(String::from);
            if !hooks_cfg.is_empty() {
                system.push_str(
                    &crate::hooks::session_start(&hooks_cfg, workspace_root.as_deref()).await,
                );
            }
            let spec = crate::loop_run::LoopSpec {
                slug,
                goal,
                profile,
                interval_ms: params.get("intervalMs").and_then(Value::as_u64),
                session_id: params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(String::from),
                workspace_root,
                permission_mode,
                system: Some(system),
                context_length: params
                    .get("contextLength")
                    .and_then(Value::as_u64)
                    .map(|value| value as u32),
                guardian_model: params
                    .get("guardianModel")
                    .and_then(Value::as_str)
                    .map(String::from),
                max_iterations: params
                    .get("maxIterations")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize)
                    .unwrap_or(crate::loop_run::MAX_ITERATIONS),
            };
            Ok(json!({ "loop": state.loops.start(state, spec).await? }))
        }
        "loop_stop" => {
            let loop_id = str_param(&params, "loopId")?;
            Ok(json!({ "loop": state.loops.stop(loop_id).await? }))
        }
        "loop_status" => {
            let loop_id = str_param(&params, "loopId")?;
            Ok(json!({ "loop": state.loops.status(loop_id).await? }))
        }
        "loop_runs" => Ok(json!({ "loops": state.loops.list().await })),
        "agent_list" => {
            let slug = params.get("projectSlug").and_then(Value::as_str);
            Ok(json!({
                "agents": crate::agents::list_agents(&state.projects_root, slug),
                "builtinRoles": crate::agents::BUILTIN_ROLES,
            }))
        }
        "command_list" => {
            let slug = params.get("projectSlug").and_then(Value::as_str);
            Ok(json!({
                "commands": crate::commands::list_commands(&state.projects_root, slug)
            }))
        }
        // Expansion is a separate call from listing because the body never
        // belongs in the menu: the client shows descriptions, and asks for the
        // prompt only when the user actually fires the command.
        "command_render" => {
            let slug = params.get("projectSlug").and_then(Value::as_str);
            let name = str_param(&params, "name")?;
            let args = params
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let (info, prompt) = crate::commands::render(&state.projects_root, slug, name, args)?;
            Ok(json!({ "name": info.name, "scope": info.scope, "prompt": prompt }))
        }
        "skill_read" => {
            // UI preview: a disabled skill is still readable, so the empty
            // disabled slice is deliberate.
            let slug = params.get("projectSlug").and_then(Value::as_str);
            // UI preview reads a disabled skill too, so the disabled list is
            // cleared while the roots are kept.
            let skills_cfg = crate::config::SkillsConfig {
                disabled: Vec::new(),
                ..state.config.read().await.skills.clone()
            };
            let (info, body) = crate::skills::load_skill(
                &state.projects_root,
                slug,
                str_param(&params, "name")?,
                &skills_cfg,
            )?;
            Ok(json!({
                "name": info.name,
                "scope": info.scope,
                "path": info.path,
                "instructions": body
            }))
        }
        "skill_set_enabled" => {
            let scope: crate::skills::SkillScope = serde_json::from_value(params["scope"].clone())
                .context("scope must be \"global\" or \"project\"")?;
            let name = str_param(&params, "name")?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .context("enabled must be a boolean")?;
            let key = crate::skills::disabled_key(scope, name);
            // Idempotent by key; an unknown name is not an error.
            let disabled = {
                let mut config = state.config.write().await;
                if enabled {
                    config.skills.disabled.retain(|entry| entry != &key);
                } else if !config.skills.disabled.contains(&key) {
                    config.skills.disabled.push(key);
                }
                crate::config::save(&config)?;
                config.skills.disabled.clone()
            };
            Ok(json!({ "disabled": disabled }))
        }
        // `projectFingerprint` identifies the project's MCP config exactly as
        // listed here; the client echoes it back when approving so consent
        // can only ever apply to what was actually on screen.
        "mcp_list" => {
            let fingerprint = match state.mcp.project_scope_base().await {
                Some(base) => {
                    let global = { state.config.read().await.mcp_servers.clone() };
                    let project = crate::config::load_project_config(&base);
                    let merged = crate::config::merge_mcp_servers(&global, &project.mcp_servers);
                    Some(crate::config::project_mcp_fingerprint(&merged))
                }
                None => None,
            };
            Ok(json!({
                "servers": state.mcp.status().await,
                "projectFingerprint": fingerprint,
            }))
        }
        "mcp_reload" => {
            // Clone-then-drop: the config lock must not be held across the
            // reload's process spawns.
            let servers = { state.config.read().await.mcp_servers.clone() };
            Ok(json!({ "servers": state.mcp.reload(&servers).await }))
        }
        // Approve (or revoke) the MCP servers a project declares in its own
        // `.cali/config.yaml`. The fingerprint is recomputed here rather than
        // taken from the caller, so approving cannot be aimed at a config the
        // user never saw, and a later edit to that file re-blocks it.
        "mcp_approve_project" => {
            // `base` is optional: with none supplied this approves the
            // project scope core currently has applied, which is exactly what
            // the settings panel is displaying.
            let base = match params.get("base").and_then(Value::as_str) {
                Some(path) if !path.trim().is_empty() => std::path::PathBuf::from(path),
                _ => state
                    .mcp
                    .project_scope_base()
                    .await
                    .context("no project scope is applied")?,
            };
            let approve = params
                .get("approve")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let global = { state.config.read().await.mcp_servers.clone() };
            let project = crate::config::load_project_config(&base);
            let merged = crate::config::merge_mcp_servers(&global, &project.mcp_servers);
            let fingerprint = crate::config::project_mcp_fingerprint(&merged);
            // Close the gap between what the user was shown and what is on
            // disk now. A repository can rewrite its own `.cali/config.yaml`
            // at any moment — a dev server running out of that very repo is
            // enough — so a client that tells us which fingerprint it
            // displayed gets a hard refusal if the file moved underneath it,
            // rather than silently approving servers nobody reviewed.
            if let Some(seen) = params.get("fingerprint").and_then(Value::as_str) {
                if approve && seen != fingerprint {
                    anyhow::bail!(
                        "the project's MCP config changed since it was displayed; \
                         review it again before approving"
                    );
                }
            }
            {
                let mut config = state.config.write().await;
                let key = base.display().to_string();
                if approve {
                    config.approved_project_mcp.insert(key, fingerprint.clone());
                } else {
                    config.approved_project_mcp.remove(&key);
                }
                crate::config::save(&config)?;
            }
            apply_mcp_project_scope(state, &base).await;
            Ok(json!({ "servers": state.mcp.status().await, "fingerprint": fingerprint }))
        }
        "mcp_set_enabled" => {
            let id = str_param(&params, "id")?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .context("enabled must be a boolean")?;
            let entry = {
                let mut config = state.config.write().await;
                let entry = config
                    .mcp_servers
                    .iter_mut()
                    .find(|server| server.id == id)
                    .ok_or_else(|| anyhow::anyhow!("unknown mcp server {}", id))?;
                entry.enabled = enabled;
                let entry = entry.clone();
                crate::config::save(&config)?;
                entry
            };
            state.mcp.apply_one(&entry).await;
            Ok(json!({ "servers": state.mcp.status().await }))
        }
        "graph_plan" => crate::graph::plan_tool(state, &params).await,
        // `ownerSession` is the calling panel's own session, and starting a run
        // moves the graph's ownership onto it: the prompts this run raises are
        // for work that panel just asked for, and they must be answerable
        // there rather than in whichever window happened to plan the graph.
        // Read from the RPC params, never from tool arguments — this path is
        // the editor's, not the model's.
        "graph_run" => {
            crate::graph::run(
                state,
                str_param(&params, "graphId")?,
                params
                    .get("ownerSession")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|session| !session.is_empty()),
            )
            .await
        }
        "graph_status" => crate::graph::status(state, &params),
        "graph_list" => crate::graph::list_tool(state, &params),
        "graph_cancel" => crate::graph::cancel_tool(state, &params).await,
        "template_list" => Ok(json!({
            "templates": crate::graph::list_templates(&state.sessions_root)
        })),
        "video_contact_sheet" => {
            let def = crate::tools::core_tool_defs()
                .into_iter()
                .find(|tool| tool.name == method)
                .with_context(|| format!("{method} tool is unavailable"))?;
            crate::tools::execute_core_tool(&def, &params, state, &state.projects_root, None).await
        }
        // This RPC is the browser half of `editor_persist_capture`. Browser
        // requests arrive from a session worktree, while visual evidence and
        // loop reports are durable project-store artifacts. Keep the raw core
        // tool (used by headless/file-tool callers) workspace-aware, but force
        // the browser RPC to the canonical project root so its returned path
        // is exactly what graph/report readers verify later.
        "capture_persist" => Ok(crate::capture_persist::as_json(
            &crate::capture_persist::persist_project_evidence(
                &state.projects_root,
                str_param(&params, "slug")?,
                str_param(&params, "path")?,
                str_param(&params, "dataUrl")?,
            )?,
        )),
        "test_baseline_save" => Ok(baselines::save_baseline(
            &state.projects_root,
            str_param(&params, "slug")?,
            str_param(&params, "name")?,
            str_param(&params, "image")?,
        )?),
        "test_baseline_compare" => Ok(baselines::compare_baseline(
            &state.projects_root,
            str_param(&params, "slug")?,
            str_param(&params, "name")?,
            str_param(&params, "image")?,
            params
                .get("threshold")
                .and_then(|v| v.as_u64())
                .unwrap_or(8) as u32,
        )?),
        "image3d_ingest" => Ok(image3d::ingest(
            &state.projects_root,
            str_param(&params, "slug")?,
            str_param(&params, "name")?,
            str_param(&params, "image")?,
        )?),
        "image3d_assess" => Ok(image3d::assess(
            str_param(&params, "name")?,
            str_param(&params, "sourceHash")?,
            params.get("width").and_then(|v| v.as_u64()).unwrap_or(512) as u32,
            params.get("height").and_then(|v| v.as_u64()).unwrap_or(512) as u32,
        )),
        "image3d_spec" => Ok(image3d::spec(
            str_param(&params, "name")?,
            str_param(&params, "sourceHash")?,
            params.get("width").and_then(|v| v.as_u64()).unwrap_or(512) as u32,
            params.get("height").and_then(|v| v.as_u64()).unwrap_or(512) as u32,
        )),
        "image3d_validate" => Ok(image3d::validate_spec(&params["spec"])?),
        "image3d_generate" => {
            // serde_json IndexMut panics when indexing a non-object, and the
            // handler assigns into `spec`. A caller sending {"spec":"x"} took
            // the request down.
            if !params.get("spec").is_some_and(Value::is_object) {
                anyhow::bail!("spec must be an object");
            }
            let mut spec = params.get("spec").cloned().unwrap_or_else(|| json!({}));
            if spec.get("assessment").is_none() {
                spec["assessment"] = image3d::assess(
                    spec["targetName"].as_str().unwrap_or("Cali Asset"),
                    spec["sourceHash"].as_str().unwrap_or("unknown"),
                    spec["silhouette"]["width"].as_u64().unwrap_or(512) as u32,
                    spec["silhouette"]["height"].as_u64().unwrap_or(512) as u32,
                );
            }
            if spec.get("seed").is_none() {
                spec["seed"] = json!(0xCA11);
            }
            Ok(image3d::generate(
                &state.projects_root,
                str_param(&params, "slug")?,
                spec,
            )?)
        }
        "image3d_review" => Ok(image3d::review(
            &state.projects_root,
            str_param(&params, "slug")?,
            str_param(&params, "assetId")?,
            str_param(&params, "image")?,
            str_param(&params, "passId")?,
        )
        .await?),
        "tool_register" => {
            // Registration replaces the browser tool set outright. It used to
            // accumulate, so tools from a closed editor tab stayed advertised
            // to the model forever and every call to one blocked for the full
            // 300s tool timeout with nobody listening.
            let reserved: std::collections::HashSet<String> = crate::tools::core_tool_defs()
                .into_iter()
                .map(|tool| tool.name)
                .collect();

            let mut next = std::collections::HashMap::new();
            let mut rejected = Vec::new();
            for item in params["tools"].as_array().into_iter().flatten() {
                let name = item["name"].as_str().unwrap_or_default().to_string();
                let valid = !name.is_empty()
                    && name.len() <= 64
                    && name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                    // The mcp__ prefix is reserved for MCP-server tools; a
                    // browser tool squatting on it would shadow or spoof them.
                    && !crate::mcp::is_mcp_name(&name);
                // A browser tool shadowing a core tool emitted two functions
                // with the same name in the provider's tools array, which
                // 400s every agent_chat in every session until core restarts.
                if !valid || reserved.contains(&name) {
                    rejected.push(name);
                    continue;
                }
                next.insert(
                    name.clone(),
                    ToolDef {
                        name,
                        description: item["description"].as_str().unwrap_or_default().to_string(),
                        parameters: item
                            .get("parameters")
                            .cloned()
                            .unwrap_or_else(|| json!({"type":"object"})),
                        kind: crate::tools::ToolKind::Browser,
                        // Editor tools are registered by the client at
                        // runtime, so there is no literal to enforce and
                        // `is_destructive` classifies them by name. Closed
                        // here so a future reader of this field is never told
                        // something reassuring that was never decided.
                        access: crate::tools::Access::Guarded,
                    },
                );
            }

            if !rejected.is_empty() {
                tracing::warn!(?rejected, "rejected tool registrations");
            }
            let registered = next.len();
            *state.tools.write().await = next;
            Ok(json!({ "registered": registered, "rejected": rejected }))
        }
        "tool_list" => {
            let tools = state.tools.read().await;
            let list: Vec<Value> = tools
                .values()
                .map(|t| json!({ "name": t.name, "description": t.description, "parameters": t.parameters, "kind": "browser" }))
                .collect();
            Ok(json!(list))
        }
        "editor_attach" => {
            let session_id = str_param(&params, "sessionId")?;
            let client_id = params
                .get("clientId")
                .and_then(Value::as_str)
                .unwrap_or(session_id);
            let project_slug = str_param(&params, "projectSlug")?;
            let workspace_root = str_param(&params, "workspaceRoot")?;
            let mut record = crate::sessions::load(&state.sessions_root, session_id)?;
            let transcript: Vec<Value> = record
                .get("messages")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|message| {
                    matches!(
                        message.get("role").and_then(Value::as_str),
                        Some("user" | "assistant")
                    )
                })
                .cloned()
                .collect();
            state
                .agents
                .restore_session(session_id, &transcript)
                .await?;
            let saved_slug = record.get("projectSlug").and_then(Value::as_str);
            if saved_slug.is_some_and(|saved| saved != project_slug) {
                anyhow::bail!("session belongs to project {saved_slug:?}, not {project_slug}");
            }
            let saved_root = record.get("workspaceRoot").and_then(Value::as_str);
            if let Some(saved_root) = saved_root {
                if !crate::editor_bridge::same_path(saved_root, workspace_root) {
                    anyhow::bail!("session is bound to a different workspace");
                }
            } else {
                record["projectSlug"] = json!(project_slug);
                record["workspaceRoot"] = json!(workspace_root);
                crate::sessions::save(&state.sessions_root, &record)?;
            }
            state.editor_attachment.write().await.insert(
                session_id.to_string(),
                crate::editor_bridge::EditorAttachment {
                    client_id: client_id.to_string(),
                    session_id: session_id.to_string(),
                    project_slug: project_slug.to_string(),
                    workspace_root: workspace_root.to_string(),
                },
            );
            Ok(json!({ "attached": true, "sessionId": session_id, "clientId": client_id }))
        }
        "editor_tool_call" => {
            let session_id = str_param(&params, "sessionId")?;
            let tool = str_param(&params, "tool")?;
            let record = crate::sessions::load(&state.sessions_root, session_id)?;
            let project_slug = record
                .get("projectSlug")
                .and_then(Value::as_str)
                .context("session has no project binding")?;
            let workspace_root = record
                .get("workspaceRoot")
                .and_then(Value::as_str)
                .context("session has no workspace binding")?;
            let attachment = state
                .editor_attachment
                .read()
                .await
                .get(session_id)
                .cloned()
                .context("no CaliCode editor is attached")?;
            if attachment.session_id != session_id
                || attachment.project_slug != project_slug
                || !crate::editor_bridge::same_path(&attachment.workspace_root, workspace_root)
            {
                anyhow::bail!(
                    "editor is attached to a different project/workspace; open {session_id} in CaliCode first"
                );
            }
            if !state.tools.read().await.contains_key(tool) {
                anyhow::bail!("unknown editor tool {tool}");
            }
            state
                .editor_bridge
                .call(
                    session_id,
                    project_slug,
                    workspace_root,
                    &attachment.client_id,
                    tool,
                    params
                        .get("arguments")
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                )
                .await
        }
        "loop_report_list" => Ok(json!({
            "reports": crate::loop_report::list(
                &state.projects_root,
                str_param(&params, "slug")?
            )?
        })),
        "loop_report_start"
        | "loop_report_iteration"
        | "loop_report_update"
        | "loop_report_open" => {
            let def = crate::tools::core_tool_defs()
                .into_iter()
                .find(|tool| tool.name == method)
                .with_context(|| format!("{method} tool is unavailable"))?;
            crate::tools::execute_core_tool(&def, &params, state, &state.projects_root, None).await
        }
        "editor_tool_result" => {
            state
                .editor_bridge
                .submit(
                    str_param(&params, "requestId")?,
                    params
                        .get("clientId")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    params.get("result").cloned().unwrap_or(Value::Null),
                )
                .await
        }
        "agent_chat" => {
            let session_id = params.get("sessionId").and_then(Value::as_str);
            let mut project_slug = params
                .get("projectSlug")
                .and_then(Value::as_str)
                .map(String::from);
            let mut workspace_root = params
                .get("workspaceRoot")
                .and_then(Value::as_str)
                .map(String::from);
            if let Some(record) =
                session_id.and_then(|id| crate::sessions::load(&state.sessions_root, id).ok())
            {
                if let Some(saved) = record.get("projectSlug").and_then(Value::as_str) {
                    if project_slug
                        .as_deref()
                        .is_some_and(|requested| requested != saved)
                    {
                        anyhow::bail!("session is bound to project {saved}");
                    }
                    project_slug = Some(saved.to_string());
                }
                if let Some(saved) = record.get("workspaceRoot").and_then(Value::as_str) {
                    if workspace_root
                        .as_deref()
                        .is_some_and(|requested| !crate::editor_bridge::same_path(requested, saved))
                    {
                        anyhow::bail!("session is bound to a different workspace");
                    }
                    workspace_root = Some(saved.to_string());
                }
            }
            let messages = params
                .get("messages")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let mut registered = state.tools.read().await.clone();
            registered.extend(state.mcp.tool_defs().await);
            // Clone-then-drop; the config lock must never be held across
            // chat().await (fair RwLock starvation, see agent.rs).
            let (skills_cfg, permission_rules, hooks_cfg) = {
                let config = state.config.read().await;
                (
                    config.skills.clone(),
                    agent_permission_rules(&config.permissions),
                    config.hooks.clone(),
                )
            };
            let permission_mode = params
                .get("permissionMode")
                .and_then(|v| v.as_str())
                .unwrap_or(crate::agent::DEFAULT_PERMISSION_MODE)
                .to_string();
            let mut system = params
                .get("system")
                .and_then(|v| v.as_str())
                .map(String::from);
            // Spelled out rather than `.or_else`, because a SessionStart hook
            // is a child process and the closure cannot await one.
            if system.is_none() {
                if let Some(slug) = project_slug.as_deref() {
                    let mut prompt = default_system_prompt(state, slug, &skills_cfg, &registered);
                    // Appended last so the static body stays a shared
                    // prompt-cache prefix: switching modes mid-session
                    // invalidates this tail and nothing above it.
                    prompt.push_str(permission_mode_prompt(&permission_mode));
                    // Hook output lands after the mode text, still inside that
                    // volatile tail. A caller supplying its own `system` gets
                    // exactly what it asked for and no injection.
                    if !hooks_cfg.is_empty() {
                        prompt.push_str(
                            &crate::hooks::session_start(&hooks_cfg, workspace_root.as_deref())
                                .await,
                        );
                    }
                    system = Some(prompt);
                }
            }
            let options = AgentOptions {
                tool_allowlist: Vec::new(),
                // Fail closed on an omitted mode. `requires_approval` already
                // treats an unknown mode as "prompt for everything", so this
                // default was the single place the harness chose the loosest
                // setting for a caller who never asked for it — and the panel
                // always sends one, so the only callers reaching this line are
                // scripts and outside MCP clients, which is exactly the set
                // that should not silently get full access.
                permission_mode: permission_mode.clone(),
                max_turns: params
                    .get("maxTurns")
                    .and_then(|v| v.as_u64())
                    .map(|value| value as usize)
                    .unwrap_or(crate::agent::DEFAULT_MAX_TURNS),
                // The client owns model metadata (models.dev via
                // `@opencode-ai/models`); core deliberately keeps no catalog,
                // so the window arrives with the turn. A zero or absent value
                // means "unknown", never "no context".
                context_length: params
                    .get("contextLength")
                    .and_then(|v| v.as_u64())
                    .filter(|value| *value > 0)
                    .map(|value| value.min(u64::from(u32::MAX)) as u32),
                // Which model reviews calls in `auto`. Arrives with the turn
                // for the same reason `contextLength` does: the catalogue is
                // the client's, and a model name literal in core is the stale
                // list AGENTS.md exists to keep out. Absent falls back to
                // `approvals.guardian_model`, then to the session's model.
                guardian_model: params
                    .get("guardianModel")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                    .map(str::to_string),
                final_response_drain: params
                    .get("finalResponseDrain")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    && params
                        .get("loopId")
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty()),
                reasoning_effort: params
                    .get("effort")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && value.len() <= 32)
                    .map(str::to_string),
                loop_id: params
                    .get("loopId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && value.len() <= 64)
                    .map(str::to_string),
                system,
                // A top-level chat is the model picker's own turn: it runs
                // the selected model, and role routing starts below it.
                model_roles: Vec::new(),
                project_slug,
                workspace_root,
                // Top-level chat: approvals stay on its own session, depth 0,
                // and the panel watching that session owns them. It is not
                // graph work, so it names no run — a graph this turn starts
                // through the `graph_run` tool names itself.
                approval_session: None,
                approval_owner: crate::agent::ApprovalOwner::OwnSession,
                owner_graph: None,
                subagent_depth: 0,
                permission_rules,
            };
            Ok(state
                .agents
                .chat(state, &registered, session_id, &messages, options)
                .await?)
        }
        "agent_tool_result" => Ok(state
            .agents
            .submit_tool_result(
                str_param(&params, "sessionId")?,
                str_param(&params, "requestId")?,
                params.get("result").cloned().unwrap_or(Value::Null),
            )
            .await?),
        // Keyed on `requestId` alone: the registry holds the answer address as
        // data, so a client no longer has to echo back a session id it may
        // never have learned. `sessionId` is still accepted so a dev client
        // mid-rebuild does not 400, and is deliberately never read.
        //
        // `clientId` is the authorization: the request names the one window
        // that may answer it, and `respond` refuses every other caller. Without
        // that refusal the address is decoration.
        "agent_approval_response" => {
            let approved = params
                .get("approved")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            // `always` only ever widens an approval, so a denial ignores it
            // outright rather than recording a grant nobody gave.
            let always = approved
                && params
                    .get("always")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            let client_id = params
                .get("clientId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|client| !client.is_empty());
            let mut answer = state
                .agents
                .approvals()
                .respond(
                    str_param(&params, "requestId")?,
                    client_id,
                    approved,
                    params.get("reason").and_then(Value::as_str),
                )
                .await?;
            if always {
                let session = answer["sessionId"].as_str().unwrap_or_default().to_string();
                let tool = answer["tool"].as_str().unwrap_or_default().to_string();
                // Failure to record must not un-answer the approval the user
                // just gave: the call itself has already been let through.
                match state.agents.always_allow(&session, &tool).await {
                    Ok(added) => answer["alwaysAllowed"] = json!(added),
                    Err(error) => {
                        tracing::warn!(%error, %session, %tool, "could not record always-allow");
                        answer["alwaysAllowed"] = json!(false);
                    }
                }
                // Cascade regardless of whether the grant was newly recorded:
                // "already granted" is exactly the state where sibling cards
                // are still up, because the turn's rules were snapshotted
                // before the grant existed.
                if let Some(client) = client_id {
                    answer["alsoApproved"] = json!(
                        state
                            .agents
                            .approvals()
                            .grant_pending(&session, &tool, client)
                            .await
                    );
                }
            }
            Ok(answer)
        }
        "agent_sessions" => Ok(json!(state.agents.sessions().await)),
        // The stop button's actual reach into the loop. Aborting the client's
        // HTTP request leaves `chat` running its full turn budget — tools,
        // writes and tokens — with nobody reading the reply, so a stop has to
        // be a request core receives rather than a connection the client drops.
        //
        // A stop that finds no running turn is reported, not raised: the press
        // races the loop finishing, and both orders are ordinary.
        "agent_cancel" => {
            let session_id = str_param(&params, "sessionId")?;
            let (found, newly_cancelled) = state.agents.cancel_session(session_id).await;
            Ok(json!({
                "sessionId": session_id,
                "found": found,
                "cancelled": newly_cancelled,
            }))
        }
        // Tool-less per-turn verifier behind the client's `/goal` command.
        // The evaluator judges only the evidence already in the transcript,
        // so it cannot confirm a goal by running something itself.
        "goal_evaluate" => {
            crate::goal::evaluate(
                state,
                str_param(&params, "goal")?,
                str_param(&params, "transcript")?,
                params.get("projectSlug").and_then(Value::as_str),
            )
            .await
        }
        // Side conversation *about* a run. Unlike `agent_chat` this registers
        // no tools and touches no session: the advisor can only read the
        // transcript excerpt it is handed, so a question about a run can
        // neither act on the project nor append to the transcript it is being
        // asked about. The client owns the advisor's history and replays it.
        "advisor_chat" => {
            let messages = params
                .get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            // The side chat carries its own model pick. It applies to this
            // call only — nothing here rewrites the saved active model.
            let model = params
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|model| {
                    (
                        params
                            .get("provider")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .unwrap_or_default(),
                        model,
                    )
                });
            crate::advisor::advise(
                state,
                crate::advisor::AdvisorRequest {
                    messages: &messages,
                    transcript: params
                        .get("transcript")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    project_slug: params.get("projectSlug").and_then(Value::as_str),
                    effort: params
                        .get("effort")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty() && value.len() <= 32),
                    model,
                    // Opt-in: only a client that minted a stream id gets deltas.
                    stream_id: params
                        .get("streamId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty() && value.len() <= 64),
                    // The step the question was opened from, when the client
                    // anchored it to one.
                    anchor: params
                        .get("anchor")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty()),
                },
            )
            .await
        }
        // Compact a live agent session: prune old tool results, summarize the
        // middle via one model call, soft-archive the replaced turns in the
        // session file, and rewrite the in-memory transcript.
        "session_compact" => {
            // Absent `instructions` keeps the session's standing steer; an
            // empty string is how `/compact clear` drops it. The two cannot
            // be collapsed: "I said nothing this time" and "forget what I
            // said" are opposite instructions to every later auto-compaction.
            let instructions = match params.get("instructions") {
                None | Some(Value::Null) => crate::agent::CompactInstructions::Unchanged,
                Some(Value::String(text)) if text.trim().is_empty() => {
                    crate::agent::CompactInstructions::Clear
                }
                Some(Value::String(text)) => crate::agent::CompactInstructions::Set(text),
                Some(_) => anyhow::bail!("instructions must be a string"),
            };
            Ok(state
                .agents
                .compact_session(
                    state,
                    str_param(&params, "sessionId")?,
                    instructions,
                    crate::agent::CompactTrigger::Manual,
                )
                .await?)
        }
        "session_save" => crate::sessions::save(&state.sessions_root, &params),
        "session_create" => {
            let project_slug = str_param(&params, "projectSlug")?;
            let created = crate::sessions::create(
                &state.sessions_root,
                &json!({ "projectSlug": project_slug }),
            )?;
            let session_id = created["id"]
                .as_str()
                .context("created session has no id")?;
            let workspace = match store::create_session_workspace(
                &state.projects_root,
                project_slug,
                session_id,
            ) {
                Ok(workspace) => workspace,
                Err(error) => {
                    let _ = crate::sessions::delete(&state.sessions_root, session_id);
                    return Err(error);
                }
            };
            let summary = match crate::sessions::save(
                &state.sessions_root,
                &json!({
                    "id": session_id,
                    "workspaceRoot": workspace["path"],
                    "worktreeId": workspace["worktreeId"],
                    "branch": workspace["branch"],
                }),
            ) {
                Ok(summary) => summary,
                Err(error) => {
                    let _ = store::cleanup_session_workspace(
                        &state.projects_root,
                        project_slug,
                        workspace["path"].as_str(),
                        workspace["worktreeId"].as_str(),
                        workspace["branch"].as_str(),
                    );
                    let _ = crate::sessions::delete(&state.sessions_root, session_id);
                    return Err(error);
                }
            };
            if let Err(error) = state.agents.ensure_session(session_id).await {
                let _ = store::cleanup_session_workspace(
                    &state.projects_root,
                    project_slug,
                    workspace["path"].as_str(),
                    workspace["worktreeId"].as_str(),
                    workspace["branch"].as_str(),
                );
                let _ = crate::sessions::delete(&state.sessions_root, session_id);
                return Err(error);
            }
            Ok(summary)
        }
        // `archived: true` asks for the archive settings shows; the default is
        // the live list the sidebar renders.
        "session_list" => crate::sessions::list(
            &state.sessions_root,
            params
                .get("archived")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
        "session_load" => crate::sessions::load(&state.sessions_root, str_param(&params, "id")?),
        // Archiving leaves the transcript, the worktree and any running agent
        // in place — only `session_delete` discards those.
        "session_archive" => {
            crate::sessions::set_archived(&state.sessions_root, str_param(&params, "id")?, true)
        }
        "session_restore" => {
            crate::sessions::set_archived(&state.sessions_root, str_param(&params, "id")?, false)
        }
        "session_delete" => {
            let id = str_param(&params, "id")?;
            let record = crate::sessions::load(&state.sessions_root, id).ok();
            let cleanup = cleanup_session_record(state, id, record.as_ref()).await;
            let mut result = crate::sessions::delete(&state.sessions_root, id)?;
            if let Some(object) = result.as_object_mut() {
                object.insert("cleanup".into(), cleanup);
            }
            Ok(result)
        }
        "session_archive_project" => {
            crate::sessions::archive_project(&state.sessions_root, str_param(&params, "slug")?)
        }
        "session_delete_project" => {
            delete_project_sessions(state, str_param(&params, "slug")?).await
        }
        "session_fork" => {
            let forked = crate::sessions::fork(
                &state.sessions_root,
                str_param(&params, "id")?,
                params.get("newId").and_then(|v| v.as_str()),
            )?;
            let id = forked["id"].as_str().context("fork has no id")?;
            let slug = forked["projectSlug"]
                .as_str()
                .context("fork has no project binding")?;
            let workspace = match store::create_session_workspace(&state.projects_root, slug, id) {
                Ok(workspace) => workspace,
                Err(error) => {
                    let _ = crate::sessions::delete(&state.sessions_root, id);
                    return Err(error);
                }
            };
            if let Err(error) = crate::sessions::save(
                &state.sessions_root,
                &json!({
                    "id": id,
                    "workspaceRoot": workspace["path"],
                    "worktreeId": workspace["worktreeId"],
                    "branch": workspace["branch"],
                }),
            ) {
                let _ = store::cleanup_session_workspace(
                    &state.projects_root,
                    slug,
                    workspace["path"].as_str(),
                    workspace["worktreeId"].as_str(),
                    workspace["branch"].as_str(),
                );
                let _ = crate::sessions::delete(&state.sessions_root, id);
                return Err(error);
            }
            match crate::sessions::load(&state.sessions_root, id) {
                Ok(record) => Ok(record),
                Err(error) => {
                    let _ = store::cleanup_session_workspace(
                        &state.projects_root,
                        slug,
                        workspace["path"].as_str(),
                        workspace["worktreeId"].as_str(),
                        workspace["branch"].as_str(),
                    );
                    let _ = crate::sessions::delete(&state.sessions_root, id);
                    Err(error)
                }
            }
        }
        "session_resolve_workspace" => crate::sessions::resolve_workspace(
            &state.sessions_root,
            std::path::Path::new(str_param(&params, "path")?),
        ),
        _ => anyhow::bail!("unknown method {}", method),
    }
}

/// Convert config-level permission rules (typed enum actions) into the
/// agent's rule shape (string actions, unrecognized ones fail closed to
/// `ask` inside `agent::rule_decision`).
fn agent_permission_rules(
    rules: &[crate::config::PermissionRule],
) -> Vec<crate::agent::PermissionRule> {
    rules
        .iter()
        .map(|rule| crate::agent::PermissionRule {
            pattern: rule.pattern.clone(),
            action: match rule.action {
                crate::config::PermissionAction::Allow => "allow",
                crate::config::PermissionAction::Ask => "ask",
                crate::config::PermissionAction::Deny => "deny",
            }
            .to_string(),
        })
        .collect()
}

/// Merge `<base>/.cali/config.yaml` MCP servers over the global list and
/// reconcile the running manager against the result. Missing or malformed
/// project config degrades to the plain global scope, so this can never make
/// opening a project fail.
/// Apply a project's MCP overrides, gated on consent.
///
/// The project's own servers stay blocked until the user has approved their
/// current fingerprint, so opening a folder never spawns a binary the
/// repository chose. The approval is stored per project path in
/// `approved_project_mcp` and keyed on the fingerprint, so editing the repo's
/// config re-blocks it.
async fn apply_mcp_project_scope(state: &AppState, base: &std::path::Path) {
    let (global, approved) = {
        let config = state.config.read().await;
        (
            config.mcp_servers.clone(),
            config
                .approved_project_mcp
                .get(&base.display().to_string())
                .cloned(),
        )
    };
    let project = crate::config::load_project_config(base);
    let merged = crate::config::merge_mcp_servers(&global, &project.mcp_servers);
    let (gated, pending) = crate::config::gate_project_mcp_consent(merged, approved.as_deref());
    state.mcp.set_project_scope_base(base).await;
    let reports = state.mcp.apply_project_scope(&gated).await;
    if pending {
        tracing::warn!(
            base = %base.display(),
            "this project declares its own MCP servers; they stay blocked until approved"
        );
    }
    tracing::info!(
        base = %base.display(),
        servers = reports.len(),
        "applied project MCP scope"
    );
}

fn reveal_in_file_manager(path: &std::path::Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg("-R").arg(path);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        command.arg(format!("/select,{}", path.display()));
        command
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(path.parent().unwrap_or(path));
        command
    };

    command
        .spawn()
        .context("failed to open the system file manager")?;
    Ok(())
}

/// Compact project digest (counts + names + workspace flag), <= ~2 KB.
///
/// Replaces the old raw project-JSON dump, which inlined base64 assets and
/// blew the context. Shared with `tools::spawn_subagent` so directly spawned
/// subagents get the same project context as graph-spawned nodes.
pub(crate) fn project_digest(projects_root: &std::path::Path, slug: &str) -> String {
    let project = match store::read_project(projects_root, slug) {
        Ok(project) => project,
        Err(_) => return format!("slug \"{slug}\" — project not readable yet."),
    };
    let names = |key: &str, cap: usize| -> (usize, String) {
        let items = project[key].as_array().cloned().unwrap_or_default();
        let mut listed: Vec<String> = items
            .iter()
            .take(cap)
            .map(|item| item["name"].as_str().unwrap_or("unnamed").to_string())
            .collect();
        if items.len() > cap {
            listed.push("...".into());
        }
        (items.len(), listed.join(", "))
    };
    let (entity_count, entity_names) = names("entities", 20);
    let (asset_count, asset_names) = names("assets", 12);
    let test_count = project["tests"].as_array().map(Vec::len).unwrap_or(0);
    let workspace = project["workspaceRoot"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("none");
    format!(
        "slug \"{slug}\" — {entity_count} entities ({entity_names}), {asset_count} assets ({asset_names}), {test_count} tests, workspace: {workspace}."
    )
}

/// CALICODE.md inline (truncated 4 KB) + `skills/*.md` file listing from the
/// game folder, resolved like the file tools so workspace-attached games read
/// the user's folder.
fn skills_block(projects_root: &std::path::Path, slug: &str) -> String {
    const CALICODE_LIMIT: usize = 4 * 1024;
    let calicode = crate::tools::resolve_game_file(projects_root, slug, "CALICODE.md")
        .ok()
        .and_then(|(_, path)| std::fs::read_to_string(path).ok());
    let skill_files: Vec<String> = crate::tools::resolve_game_file(projects_root, slug, "skills")
        .ok()
        .and_then(|(_, dir)| std::fs::read_dir(dir).ok())
        .map(|entries| {
            let mut files: Vec<String> = entries
                .flatten()
                .filter_map(|entry| {
                    let name = entry.file_name().to_string_lossy().to_string();
                    name.ends_with(".md").then(|| format!("skills/{name}"))
                })
                .collect();
            files.sort();
            files
        })
        .unwrap_or_default();
    match (calicode, skill_files.is_empty()) {
        (None, true) => "No CALICODE.md or skills/ found — conventions are unset.".to_string(),
        (calicode, _) => {
            let mut block = String::new();
            if let Some(content) = calicode {
                let mut content = content;
                if content.len() > CALICODE_LIMIT {
                    let mut end = CALICODE_LIMIT;
                    while !content.is_char_boundary(end) {
                        end -= 1;
                    }
                    content.truncate(end);
                    content.push_str("\n[truncated]");
                }
                block.push_str("CALICODE.md:\n");
                block.push_str(&content);
            }
            if !skill_files.is_empty() {
                if !block.is_empty() {
                    block.push('\n');
                }
                block.push_str("Skill files: ");
                block.push_str(&skill_files.join(", "));
            }
            block
        }
    }
}

/// Live browser-registered tool names, or an explicit "none" so the agent
/// never waits on scene tools that cannot answer.
fn browser_tools_block(registered: &std::collections::HashMap<String, ToolDef>) -> String {
    let mut names: Vec<&str> = registered
        .values()
        .filter(|tool| tool.kind == crate::tools::ToolKind::Browser)
        .map(|tool| tool.name.as_str())
        .collect();
    if names.is_empty() {
        return "none registered — no editor is connected; scene tools unavailable this session"
            .to_string();
    }
    names.sort_unstable();
    names.join(", ")
}

/// MCP-server tool names (namespaced), or "" when no server contributes any.
fn mcp_tools_block(registered: &std::collections::HashMap<String, ToolDef>) -> String {
    let mut names: Vec<&str> = registered
        .values()
        .filter(|tool| tool.kind == crate::tools::ToolKind::Mcp)
        .map(|tool| tool.name.as_str())
        .collect();
    if names.is_empty() {
        return String::new();
    }
    names.sort_unstable();
    format!("\nMCP (external servers): {}", names.join(", "))
}

/// The production default system prompt: reference bar, tiered escalation,
/// decompose -> fan out -> judge blind -> iterate, grounded in this project's
/// digest, live tool set, templates, and skills.
/// What the session's permission mode means, in the model's own terms.
///
/// Only the two modes where the model has something to *do* about the setting
/// say anything. Manual and Full access are facts about the user's console,
/// not instructions — telling a model "everything you call will be approved"
/// is an invitation, and telling it "everything will be asked" invites it to
/// batch or apologise. Both get nothing, which also keeps them on the same
/// prompt-cache prefix as each other.
fn permission_mode_prompt(mode: &str) -> &'static str {
    match mode {
        "auto" => AUTO_MODE_PROMPT,
        "plan" => PLAN_MODE_PROMPT,
        _ => "",
    }
}

const AUTO_MODE_PROMPT: &str = "\n\n## Permissions: Auto\n\
The user is not approving each call. Ordinary work runs; an automatic reviewer reads the rest against what they asked for, and only what it stops reaches them.\n\
\n\
Guarded tools take an optional `ask_user` argument. Set it when *you* judge that a specific call is one they would want to see first — it goes beyond what they asked for, it is hard to undo, it spends their money, it acts outside this machine, or they said they wanted to be asked. The value is the question they see, short and in their terms.\n\
\n\
Do not set it on ordinary work. Every unnecessary prompt makes the next one less likely to be read. Do not narrate the permission system either: act, and let the card do the asking.\n\
\n\
If a call is refused by the reviewer, do not retry a variant of it. Say what you were trying to do and let the user decide.";

const PLAN_MODE_PROMPT: &str = "\n\n## Permissions: Plan\n\
You are planning, not building. Every tool that changes anything is unavailable, and will stay unavailable until the user approves a plan.\n\
\n\
Read whatever you need — files, the scene, the web. Then write the plan with `plan_write`, which is the one thing you may write, and present it with `exit_plan_mode`.\n\
\n\
Write the plan you would want to be handed: what you understand the goal to be, what you found while reading, what you will change and in what order, and what you are unsure about. Name real files and real functions. A plan the user cannot check against the code is not a plan they can approve.\n\
\n\
If they ask for changes, revise and present again. Do not describe the change as though you made it.";

fn default_system_prompt(
    state: &AppState,
    slug: &str,
    skills_cfg: &crate::config::SkillsConfig,
    registered: &std::collections::HashMap<String, ToolDef>,
) -> String {
    let template_ids = crate::graph::list_templates(&state.sessions_root)
        .iter()
        .filter_map(|template| template["id"].as_str().map(str::to_string))
        .collect::<Vec<_>>()
        .join(", ");
    let mut prompt = String::from(STATIC_SYSTEM_PROMPT);
    // Only describe the editor workflow when there is an editor. Appended here,
    // after the invariant base, so both renderings share that base as a prompt-
    // cache prefix rather than diverging from the first byte.
    if registered
        .values()
        .any(|def| def.kind == crate::tools::ToolKind::Browser)
    {
        prompt.push_str(EDITOR_TOOLING_PROMPT);
    }
    // Everything the model needs that varies by project, session, or connected
    // editor lands here, after the static body. See STATIC_SYSTEM_PROMPT.
    prompt.push_str(&format!(
        "\n\n## This session\n\
Project: {project_digest}\n\
Templates: {template_ids}\n\
Editor tools: {browser_tools}{mcp_tools}\n\
Conventions: {skills_block}\n",
        project_digest = project_digest(&state.projects_root, slug),
        template_ids = template_ids,
        browser_tools = browser_tools_block(registered),
        mcp_tools = mcp_tools_block(registered),
        skills_block = skills_block(&state.projects_root, slug),
    ));
    // Installed skills (global ~/.cali/skills + <project>/skills SKILL.md
    // format) load on demand via skill_load; the index is appended so the
    // agent knows what exists without paying for the bodies.
    prompt.push_str(&crate::skills::prompt_index(
        &state.projects_root,
        Some(slug),
        skills_cfg,
    ));
    // Durable memory, same progressive disclosure as skills: descriptions in
    // the prompt, bodies through memory_read. This is a session-start snapshot
    // — the system message is only inserted into an empty transcript
    // (`agent::chat`) — which is the right lifetime: a memory written mid-
    // session is already in context because this agent just wrote it, and the
    // index it belongs in is the next session's.
    prompt.push_str(&crate::memory::prompt_index(
        &state.projects_root,
        Some(slug),
    ));
    prompt
}

/// The invariant half of the default system prompt.
///
/// This is a `const` rather than a `format!` deliberately: it is byte-identical
/// for every project and every session on a given build, so a provider prefix
/// cache serves the whole block as one shared read. Interpolating anything
/// project- or session-specific into it re-bills roughly 2K tokens of static
/// instruction on every turn of every session — the single most expensive
/// mistake available in this file. Volatile state belongs in the `## This
/// session` block that `default_system_prompt` appends after it.
/// The half of the prompt that only makes sense with an editor attached.
///
/// Every tool it names — `editor_run_pie`, `editor_scene_inspect`,
/// `editor_test_add` and the rest — is registered at runtime by a connected
/// client. A subagent, a graph node, or a headless caller has none of them, and
/// was still being told to run PIE and capture frames: instructions it cannot
/// follow, which cost it turns discovering that.
///
/// grok-build's answer is a template that never names a tool and gates whole
/// sections on availability. This is the same idea at the granularity that
/// matters here, and it is a separate `const` for the same reason the base is:
/// each rendering has to be byte-identical for the prompt cache. Appended
/// *after* the invariant base, so a session without an editor still shares that
/// base as a cache prefix with one that has it.
const EDITOR_TOOLING_PROMPT: &str = "Verify everything you claim: before visual evidence, call editor_scene_inspect and\n\
editor_camera_frame with gameplay foreground entity ids so decorative sky/backdrop\n\
geometry cannot control or occlude the persisted evidence camera. After scene or script changes run editor_run_pie,\n\
persist individual frames directly with editor_persist_capture(path), and read\n\
editor_console_history for runtime errors. Never copy screenshot data URLs\n\
through the model or use UTF-8 file_write for PNG bytes. For animation or\n\
movement call editor_analyze_motion and attach every returned project-relative\n\
evidence path to loop_report_iteration; after gameplay\n\
changes add or run tests\n\
(editor_test_add, editor_run_tests). Tests may read scene, entityFor(name), and\n\
read-only state.world; `await step(frames)` refreshes snapshots. Always\n\
`await assert(condition, positiveMessage)`.\n\
Never use `|| true`; messages state expected positive behavior, not inverted failure.\n\n";

const STATIC_SYSTEM_PROMPT: &str =
    "You are CaliCode — an AI game engineer for a three.js game workbench. You build\n\
real, playable scenes, scripts, assets, and tests, and for any goal with a\n\
quality bar you do not stop at \"works\": you iterate until a harsh, independent\n\
judge scores the result at or above a named world-class reference. That\n\
substrate is fixed: everything ships inside this three.js editor and its tools —\n\
never propose switching engines as a path to quality.\n\
\n\
Project, templates, editor tools and conventions: '## This session', at the end.\n\
\n\
## Match the ask to the machinery\n\
- SMALL (one obvious edit, a question, a tweak — you can name the exact tool\n\
  calls before starting): just use tools directly. No subagents, no graph.\n\
- SINGLE TASK (self-contained, verifiable, no real decomposition): spawn one\n\
  subagent with subagent_spawn and check its result yourself.\n\
- GOAL (a feature, a system, a game, or any request with quality language —\n\
  \"polished\", \"beautiful\", \"AAA\", \"like <game>\"): run the full loop below.\n\
When unsure, ask one question if the answer changes the tier; otherwise start\n\
at the lower tier and escalate the moment the work reveals hidden scope. A\n\
one-line fix must never spawn a graph.\n\
\n\
## The loop\n\
- GOAL work runs a quality loop: name a world-class reference, decompose with\n\
  graph_plan, fan out, judge blind against that reference, iterate per item.\n\
  Load the `goal-loop` skill for the full procedure BEFORE calling graph_plan\n\
  or loop_report_start. Do not run it from memory — the thresholds, the plan\n\
  shape, and the blocked-graph rule are in the skill.\n\
\n\
## Tools\n\
Project/state: project_list, project_open, project_checkpoint, project_revert,\n\
  file_read, file_write, file_list\n\
Assets: asset_import_file, asset_search, asset_pick, asset_hash_dedupe,\n\
  asset_usage, asset_export_gltf, image3d_ingest, image3d_validate,\n\
  image3d_mesh, image3d_review\n\
Testing: test_baseline_save, test_baseline_compare\n\
Models: model_list (the user controls model switching from the model picker)\n\
Skills: skill_list, skill_load\n\
Orchestration: graph_plan, graph_run, graph_status, graph_list, graph_cancel,\n\
  template_list, subagent_spawn, loop_report_start, loop_report_iteration,\n\
  loop_report_update, loop_report_open\n\
Editor (browser-registered, live scene access): see below.\n\
\n\
Scripts: only owner `entity` is writable. `state.find(nameOrId)`/`state.scene`\n\
are frozen snapshots. For cross-entity transforms call\n\
`state.patch(nameOrId,{position?,rotation?,scale?})` merges finite partial\n\
`{x?,y?,z?}`. Direct owner assignments require full\n\
finite `{x,y,z}`; materials are static editor edits, never runtime writes.\n\
\n\
Checkpoint (project_checkpoint) before\n\
risky multi-step changes so project_revert can rescue you.\n\
\n\
## Skills\n\
Project-specific knowledge lives in the game folder; see below.\n\
Read the relevant skill file with file_read BEFORE working in its area, and\n\
follow it over your defaults. When you learn something durable about this\n\
project, offer to record it in CALICODE.md.\n\
\n\
## Quality bar\n\
\"Done\" means: it runs in PIE without errors, tests pass, the scene reads\n\
clearly in a captured frame, and the judge scored it at or above threshold\n\
against its named reference. Never present unverified work as finished; say\n\
exactly what was verified and how, and what the judge scored. Be concise in\n\
chat — put the effort into the work, not the narration.";

/// How long to wait for a folder to prove it is readable.
///
/// Generous enough for a sleeping external drive to spin up, short enough that
/// a permission-gated volume reports back instead of hanging the UI.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);

/// Confirm a folder can actually be listed, without blocking forever.
///
/// On macOS, reading a volume the app has not been granted access to blocks
/// rather than returning a permission error, so a plain `read_dir` in the
/// handler never returns. The probe runs on a blocking thread and is abandoned
/// on timeout — one stranded thread is a far better outcome than an RPC that
/// never answers.
async fn probe_readable(path: &str) -> Result<()> {
    let owned = std::path::PathBuf::from(path);
    let probe = tokio::task::spawn_blocking(move || std::fs::read_dir(&owned).map(|_| ()));
    match tokio::time::timeout(PROBE_TIMEOUT, probe).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => Err(anyhow::anyhow!("cannot read {path}: {error}")),
        Ok(Err(error)) => Err(anyhow::anyhow!("cannot read {path}: {error}")),
        Err(_) => Err(anyhow::anyhow!(
            "timed out reading {path}. If it is on an external drive, grant CaliCode \
             access in System Settings > Privacy & Security > Files and Folders."
        )),
    }
}

/// Release resources owned by one durable session while preserving any
/// shared/permanent workspace and any dirty generated worktree.
async fn cleanup_session_record(
    state: &AppState,
    session_id: &str,
    record: Option<&Value>,
) -> Value {
    let cleanup = match (
        record
            .and_then(|record| record.get("projectSlug"))
            .and_then(Value::as_str),
        record
            .and_then(|record| record.get("workspaceRoot"))
            .and_then(Value::as_str),
        record
            .and_then(|record| record.get("worktreeId"))
            .and_then(Value::as_str),
        record
            .and_then(|record| record.get("branch"))
            .and_then(Value::as_str),
    ) {
        (Some(slug), workspace_root, worktree_id, branch) => {
            match store::cleanup_session_workspace(
                &state.projects_root,
                slug,
                workspace_root,
                worktree_id,
                branch,
            ) {
                Ok(result) => result,
                Err(error) => {
                    tracing::warn!(session_id, %error, "session worktree cleanup failed");
                    json!({
                        "deleted": false,
                        "isolated": true,
                        "preserved": true,
                        "reason": error.to_string(),
                    })
                }
            }
        }
        _ => json!({
            "deleted": false,
            "isolated": false,
            "preserved": false,
            "reason": "session has no project/workspace metadata",
        }),
    };
    let cancelled = state.editor_bridge.cancel_session(session_id).await;
    let (agent_removed, agent_pending_cancelled) = state.agents.remove_session(session_id).await;
    state.editor_attachment.write().await.remove(session_id);
    json!({
        "worktree": cleanup,
        "editorRequestsCancelled": cancelled,
        "agentSessionRemoved": agent_removed,
        "agentRequestsCancelled": agent_pending_cancelled,
    })
}

/// Clean and delete every persisted chat for a project, archived ones
/// included. Durable session records are user data, so only explicit
/// archive/delete operations remove them; generated worktrees are removed only
/// when their metadata is an exact, clean session worktree.
async fn delete_project_sessions(state: &AppState, slug: &str) -> Result<Value> {
    let mut listed = crate::sessions::list(&state.sessions_root, false)?;
    if let (Some(items), Some(archived)) = (
        listed.as_array_mut(),
        crate::sessions::list(&state.sessions_root, true)?.as_array(),
    ) {
        items.extend(archived.iter().cloned());
    }
    let records: Vec<Value> = listed
        .as_array()
        .into_iter()
        .flatten()
        .filter(|record| {
            record
                .get("projectSlug")
                .and_then(Value::as_str)
                .is_some_and(|project| project == slug)
        })
        .cloned()
        .collect();
    let mut cleanup = Vec::with_capacity(records.len());
    for record in &records {
        if let Some(session_id) = record.get("id").and_then(Value::as_str) {
            cleanup.push(cleanup_session_record(state, session_id, Some(record)).await);
        }
    }
    let removed = crate::sessions::delete_project(&state.sessions_root, slug)?;
    Ok(json!({
        "deleted": removed["deleted"],
        "cleanup": cleanup,
    }))
}

/// Translate one input event from the BROWSER tab into a devtools input
/// command.
///
/// Narrow on purpose. Forwarding the client's JSON to `Input.dispatch*`
/// verbatim would be less code, but the tab would then be an arbitrary-CDP
/// hole: the same channel that carries a click could carry
/// `Input.dispatchKeyEvent` for a file-download shortcut, or any other domain
/// entirely. Each field is read and re-emitted instead.
async fn browser_input(browser: &crate::browser::Browser, params: &Value) -> Result<Value> {
    let x = params["x"].as_f64().unwrap_or(0.0);
    let y = params["y"].as_f64().unwrap_or(0.0);
    match params["kind"].as_str().unwrap_or_default() {
        "move" | "down" | "up" => {
            let kind = match params["kind"].as_str().unwrap_or_default() {
                "down" => "mousePressed",
                "up" => "mouseReleased",
                _ => "mouseMoved",
            };
            browser
                .call(
                    "Input.dispatchMouseEvent",
                    json!({
                        "type": kind,
                        "x": x, "y": y,
                        "button": if kind == "mouseMoved" { "none" } else { "left" },
                        "buttons": if kind == "mousePressed" { 1 } else { 0 },
                        "clickCount": params["clickCount"].as_u64().unwrap_or(1).clamp(1, 3),
                    }),
                )
                .await?;
            // A move also answers "what would the cursor look like here".
            //
            // The panel is an image, so its cursor never changed shape — it
            // stayed an arrow over links, over buttons, over everything. That
            // is a small thing that reads constantly as "this is a picture of
            // a page, not a page". The move is already a round trip and the
            // probe rides along inside it (measured: 8.4ms against 8.3ms for
            // the move alone), so the shape can follow the pointer for free.
            if kind == "mouseMoved" {
                return Ok(json!({ "ok": true, "cursor": browser.cursor_at(x, y).await }));
            }
            Ok(json!({ "ok": true }))
        }
        "wheel" => {
            browser
                .call(
                    "Input.dispatchMouseEvent",
                    json!({
                        "type": "mouseWheel",
                        "x": x, "y": y,
                        "deltaX": params["deltaX"].as_f64().unwrap_or(0.0),
                        "deltaY": params["deltaY"].as_f64().unwrap_or(0.0),
                    }),
                )
                .await
        }
        "text" => {
            browser
                .call(
                    "Input.insertText",
                    json!({ "text": str_param(params, "text")? }),
                )
                .await
        }
        "key" => browser.key(str_param(params, "key")?, 0, 1).await,
        other => anyhow::bail!("unknown browser input kind '{other}'"),
    }
    .map(|_| json!({ "ok": true }))
}

fn str_param<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing required string {}", key))
}

/// A pty dimension in cells. Missing, zero or absurd values fall back rather
/// than failing the call: a client that mis-measures its canvas should still
/// get a usable terminal, not an error dialog.
fn size_param(params: &Value, key: &str, fallback: u16) -> u16 {
    params
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .map(|value| value.min(u16::MAX as u64) as u16)
        .unwrap_or(fallback)
}

/// The folder a terminal starts in.
///
/// Resolved exactly the way the file tools resolve a game's root, so a command
/// sees the same tree `file_read` does: the project's attached `workspaceRoot`
/// when it has one, otherwise CaliCode's own project directory. A bare
/// `workspaceId` is accepted too, for a folder opened without a project.
///
/// One of the two is required. For `terminal_run` there is otherwise nothing
/// to confine an explicit `cwd` against; for `terminal_open` there is nowhere
/// sensible to drop the user — a session that started in `/` would be a
/// terminal attached to nothing.
async fn terminal_root(state: &AppState, params: &Value) -> Result<std::path::PathBuf> {
    if let Some(slug) = params.get("projectSlug").and_then(Value::as_str) {
        return Ok(crate::tools::game_file_base(&state.projects_root, slug, None)?.base);
    }
    if let Some(id) = params.get("workspaceId").and_then(Value::as_str) {
        let registry = state.workspaces.read().await;
        return Ok(workspace::get(&registry, id)?.root.clone());
    }
    anyhow::bail!("a terminal needs a projectSlug or workspaceId to resolve its directory")
}

/// Mirrors the open-workspace set into the config file.
///
/// A failure here must not fail the RPC: losing the convenience of a restored
/// workspace is not worth failing the open that just succeeded.
async fn persist_workspaces(state: &AppState, roots: Vec<crate::config::WorkspaceEntry>) {
    let mut config = state.config.write().await;
    if config.workspaces == roots {
        return;
    }
    config.workspaces = roots;
    if let Err(error) = crate::config::save(&config) {
        tracing::warn!(%error, "could not persist workspaces");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tower::util::ServiceExt;

    fn test_router(state: AppState) -> axum::Router {
        use axum::extract::DefaultBodyLimit;
        use axum::routing::post;
        axum::Router::new()
            .route(
                "/rpc",
                post(rpc_handler).layer(DefaultBodyLimit::max(RPC_BODY_LIMIT_BYTES)),
            )
            .with_state(state)
    }

    fn test_state(
        projects_root: std::path::PathBuf,
        sessions_root: std::path::PathBuf,
    ) -> AppState {
        let (bus, _) = tokio::sync::broadcast::channel(8);
        AppState {
            config: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::config::AppConfig::default(),
            )),
            projects_root,
            sessions_root,
            agents: crate::agent::AgentManager::new(bus.clone()),
            graphs: crate::graph::GraphManager::new(),
            loops: Default::default(),
            bus: bus.clone(),
            tools: std::sync::Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            editor_bridge: crate::editor_bridge::EditorBridge::new(bus.clone()),
            editor_attachment: std::sync::Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            mcp: std::sync::Arc::new(crate::mcp::McpManager::default()),
            asset_catalog: std::sync::Arc::new(tokio::sync::RwLock::new(Vec::new())),
            workspaces: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::workspace::Registry::new(),
            )),
            dev_servers: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::devserver::Servers::new(),
            )),
            terminals: crate::terminal::Terminals::default(),
            browsers: crate::browser::Browsers::new(),
            shutdown: std::sync::Arc::new(tokio::sync::watch::channel(false).0),
        }
    }

    /// An "always allow" has to answer the cards it already covers.
    ///
    /// The grant is folded into a turn's permission rules when the turn
    /// *starts*, so the siblings of a parallel tool batch keep their cards up
    /// after the user grants the tool — which reads as the grant having failed
    /// and costs a click per sibling.
    #[tokio::test]
    async fn an_always_allow_clears_the_pending_cards_it_covers() {
        let home = tempfile::tempdir().unwrap();
        let state = test_state(home.path().join("projects"), home.path().join("sessions"));
        let mut events = state.bus.subscribe();

        let mut waiters = Vec::new();
        for _ in 0..3 {
            let approvals = state.agents.approvals().clone();
            waiters.push(tokio::spawn(async move {
                approvals
                    .request(crate::approvals::ApprovalRequest {
                        answer_session: "session-1",
                        target_client_id: Some("window-a".into()),
                        owner_session: Some("session-1".into()),
                        owner_graph: None,
                        asking_session: "session-1",
                        tool: "file_write",
                        arguments: json!({ "path": "a.txt" }),
                        reason: None,
                        reason_source: None,
                    })
                    .await
            }));
        }
        let mut ids = Vec::new();
        while ids.len() < 3 {
            let event = events.recv().await.unwrap();
            if event["type"] == "agent.approval_request" {
                ids.push(event["requestId"].as_str().unwrap().to_string());
            }
        }

        let answer = dispatch(
            &state,
            "agent_approval_response",
            json!({
                "requestId": ids[0],
                "clientId": "window-a",
                "approved": true,
                "always": true,
            }),
        )
        .await
        .unwrap();
        assert_eq!(answer["alsoApproved"], 2);
        for waiter in waiters {
            assert_eq!(
                waiter.await.unwrap(),
                crate::approvals::ApprovalOutcome::Approved
            );
        }
        assert_eq!(state.agents.approvals().pending_count().await, 0);
    }

    /// The reason the user typed reaches the tool error, and only on a denial.
    #[tokio::test]
    async fn a_denial_forwards_the_users_words_to_the_waiting_call() {
        let home = tempfile::tempdir().unwrap();
        let state = test_state(home.path().join("projects"), home.path().join("sessions"));
        let mut events = state.bus.subscribe();

        let waiter = {
            let approvals = state.agents.approvals().clone();
            tokio::spawn(async move {
                approvals
                    .request(crate::approvals::ApprovalRequest {
                        answer_session: "session-1",
                        target_client_id: Some("window-a".into()),
                        owner_session: Some("session-1".into()),
                        owner_graph: None,
                        asking_session: "session-1",
                        tool: "file_write",
                        arguments: json!({ "path": "a.txt" }),
                        reason: None,
                        reason_source: None,
                    })
                    .await
            })
        };
        let request_id = loop {
            let event = events.recv().await.unwrap();
            if event["type"] == "agent.approval_request" {
                break event["requestId"].as_str().unwrap().to_string();
            }
        };

        dispatch(
            &state,
            "agent_approval_response",
            json!({
                "requestId": request_id,
                "clientId": "window-a",
                "approved": false,
                "reason": "not that file, edit the config",
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            waiter.await.unwrap(),
            crate::approvals::ApprovalOutcome::Denied(Some(
                "not that file, edit the config".into()
            ))
        );
    }

    fn git_fixture(home: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let projects = home.join("projects");
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.email", "tests@example.com"],
            vec!["config", "user.name", "CaliCode Tests"],
        ] {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success(), "git failed: {:?}", output);
        }
        std::fs::write(repo.join("README.md"), "demo").unwrap();
        for args in [vec!["add", "README.md"], vec!["commit", "-m", "initial"]] {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success(), "git failed: {:?}", output);
        }
        store::create_project(&projects, "demo", "Demo").unwrap();
        store::set_workspace_root(&projects, "demo", repo.to_str()).unwrap();
        (projects, repo)
    }

    #[tokio::test]
    async fn ping_reports_the_built_core_version() {
        let projects = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let state = test_state(projects.path().to_path_buf(), sessions.path().to_path_buf());

        let result = dispatch(&state, "ping", json!({})).await.unwrap();

        assert_eq!(result["pong"], true);
        assert_eq!(result["version"], env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn starter_list_offers_the_builtin_with_its_install_command() {
        let projects = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let state = test_state(projects.path().to_path_buf(), sessions.path().to_path_buf());

        let result = dispatch(&state, "starter_list", json!({})).await.unwrap();
        let starters = result["starters"].as_array().unwrap();
        let iso = starters
            .iter()
            .find(|s| s["id"] == json!("iso-city"))
            .expect("the builtin starter is missing from starter_list");

        assert_eq!(iso["scope"], json!("builtin"));
        assert_eq!(iso["devScript"], json!("dev"));
        // The client offers this command; core never runs it.
        assert_eq!(iso["install"], json!("npm install"));
    }

    /// A scaffold that does not end up attached is a folder the user has to go
    /// and find, so the create arm opens what it wrote.
    #[tokio::test]
    async fn workspace_create_from_template_scaffolds_and_attaches_it() {
        let projects = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        // Without this the arm's persist_workspaces would rewrite the
        // developer's own ~/.cali/config.yaml.
        std::env::set_var("CALI_CONFIG", config.path().join("config.yaml"));
        let state = test_state(projects.path().to_path_buf(), sessions.path().to_path_buf());

        let target = tempfile::tempdir().unwrap();
        let dest = target.path().join("my-city");
        let created = dispatch(
            &state,
            "workspace_create_from_template",
            json!({ "templateId": "iso-city", "path": dest.to_str().unwrap(), "name": "My City" }),
        )
        .await
        .unwrap();

        assert_eq!(created["workspace"]["name"], json!("My City"));
        assert_eq!(created["starter"]["id"], json!("iso-city"));
        assert_eq!(created["install"], json!("npm install"));
        // `describe` reads the scaffolded package.json, so this proves the dev
        // script the manifest names actually reached disk.
        assert!(created["workspace"]["scripts"]["dev"].is_string());
        assert!(dest.join("src/engine/city.ts").exists());

        let id = created["workspace"]["id"].as_str().unwrap().to_string();
        let listed = dispatch(&state, "workspace_list", json!({})).await.unwrap();
        assert!(
            listed
                .as_array()
                .unwrap()
                .iter()
                .any(|w| w["id"] == json!(id)),
            "the scaffolded workspace was not attached"
        );

        // Scaffolding over the top of it would silently overwrite work.
        let again = dispatch(
            &state,
            "workspace_create_from_template",
            json!({ "templateId": "iso-city", "path": dest.to_str().unwrap() }),
        )
        .await;
        assert!(again.is_err());
    }

    /// The terminal runs against the same tree `file_read` sees: a game with a
    /// folder attached runs there, not in CaliCode's project directory.
    #[tokio::test]
    async fn terminal_run_streams_from_the_attached_workspace_and_kills_idempotently() {
        let home = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let (projects, repo) = git_fixture(home.path());
        let state = test_state(projects.clone(), sessions.path().to_path_buf());
        let mut events = state.bus.subscribe();

        let started = dispatch(
            &state,
            "terminal_run",
            json!({ "command": "pwd", "projectSlug": "demo" }),
        )
        .await
        .unwrap();
        let run_id = started["runId"].as_str().unwrap().to_string();
        assert!(run_id.starts_with("term-"));
        assert_eq!(
            started["cwd"].as_str().unwrap(),
            repo.canonicalize().unwrap().to_string_lossy()
        );

        let mut stdout = String::new();
        loop {
            let event = tokio::time::timeout(std::time::Duration::from_secs(20), events.recv())
                .await
                .unwrap()
                .unwrap();
            if event["runId"] != json!(run_id) {
                continue;
            }
            if event["type"] == json!("terminal.exit") {
                assert_eq!(event["code"], json!(0));
                break;
            }
            stdout.push_str(event["chunk"].as_str().unwrap());
        }
        assert_eq!(
            stdout.trim(),
            repo.canonicalize().unwrap().to_string_lossy()
        );

        assert_eq!(
            dispatch(&state, "terminal_kill", json!({ "runId": run_id }))
                .await
                .unwrap()["killed"],
            json!(false)
        );
        assert!(
            dispatch(&state, "terminal_runs", json!({})).await.unwrap()["runs"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    /// Without a root there is nothing to confine `cwd` against, and an
    /// explicit `cwd` outside that root is refused rather than silently obeyed.
    #[tokio::test]
    async fn terminal_run_requires_a_root_and_confines_the_cwd_to_it() {
        let home = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let (projects, _repo) = git_fixture(home.path());
        let state = test_state(projects, sessions.path().to_path_buf());

        let rootless = dispatch(&state, "terminal_run", json!({ "command": "pwd" }))
            .await
            .unwrap_err();
        assert!(rootless.to_string().contains("projectSlug"));

        let escaped = dispatch(
            &state,
            "terminal_run",
            json!({ "command": "pwd", "projectSlug": "demo", "cwd": "/etc" }),
        )
        .await
        .unwrap_err();
        assert!(
            escaped.to_string().contains("outside the workspace root"),
            "{escaped}"
        );
    }

    /// A pty session opens in the attached workspace, is listed at the size the
    /// client asked for, and closes idempotently. Nothing here waits on shell
    /// output: this covers the RPC wiring, `terminal.rs` covers the shell.
    #[tokio::test]
    async fn terminal_open_lists_resizes_and_closes_a_session() {
        let home = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let (projects, repo) = git_fixture(home.path());
        let state = test_state(projects, sessions.path().to_path_buf());

        let opened = dispatch(
            &state,
            "terminal_open",
            json!({ "projectSlug": "demo", "cols": 132, "rows": 43 }),
        )
        .await
        .unwrap();
        let session_id = opened["sessionId"].as_str().unwrap().to_string();
        assert!(session_id.starts_with("pty-"));
        assert_eq!(
            opened["cwd"].as_str().unwrap(),
            repo.canonicalize().unwrap().to_string_lossy()
        );
        assert!(std::path::Path::new(opened["shell"].as_str().unwrap()).exists());

        let listed = dispatch(&state, "terminal_sessions", json!({}))
            .await
            .unwrap();
        assert_eq!(listed["sessions"][0]["sessionId"], json!(session_id));
        assert_eq!(listed["sessions"][0]["cols"], json!(132));
        assert_eq!(listed["sessions"][0]["rows"], json!(43));

        assert_eq!(
            dispatch(
                &state,
                "terminal_resize",
                json!({ "sessionId": session_id, "cols": 90, "rows": 30 }),
            )
            .await
            .unwrap(),
            json!({ "ok": true })
        );
        assert_eq!(
            dispatch(&state, "terminal_sessions", json!({}))
                .await
                .unwrap()["sessions"][0]["cols"],
            json!(90)
        );

        let closed = dispatch(&state, "terminal_close", json!({ "sessionId": session_id }))
            .await
            .unwrap();
        assert_eq!(closed["closed"], json!(true));
        assert_eq!(
            dispatch(&state, "terminal_close", json!({ "sessionId": session_id }),)
                .await
                .unwrap()["closed"],
            json!(false)
        );
    }

    /// A session needs somewhere to start, and keystrokes must not be
    /// swallowed by a session that is no longer there.
    #[tokio::test]
    async fn terminal_open_requires_a_root_and_input_requires_a_live_session() {
        let projects = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let state = test_state(projects.path().to_path_buf(), sessions.path().to_path_buf());

        let rootless = dispatch(&state, "terminal_open", json!({}))
            .await
            .unwrap_err();
        assert!(rootless.to_string().contains("projectSlug"));

        let orphan = dispatch(
            &state,
            "terminal_input",
            json!({ "sessionId": "pty-gone", "data": "ls\r" }),
        )
        .await
        .unwrap_err();
        assert!(orphan.to_string().contains("pty-gone"), "{orphan}");
        // A resize, unlike input, races the close button and reports the loss.
        assert_eq!(
            dispatch(
                &state,
                "terminal_resize",
                json!({ "sessionId": "pty-gone", "cols": 80, "rows": 24 }),
            )
            .await
            .unwrap(),
            json!({ "ok": false })
        );
    }

    #[test]
    fn a_missing_or_nonsensical_pty_size_falls_back() {
        for params in [
            json!({}),
            json!({ "cols": 0 }),
            json!({ "cols": "wide" }),
            json!({ "cols": -5 }),
        ] {
            assert_eq!(size_param(&params, "cols", 80), 80);
        }
        assert_eq!(size_param(&json!({ "cols": 120 }), "cols", 80), 120);
        // Clamped to something a winsize ioctl can survive by `terminal.rs`.
        assert_eq!(
            size_param(&json!({ "cols": 999_999 }), "cols", 80),
            u16::MAX
        );
    }

    /// Both strings are required. Reaching the provider without a goal would
    /// spend a model call to verify nothing.
    #[tokio::test]
    async fn goal_evaluate_requires_a_goal_and_a_transcript() {
        let projects = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let state = test_state(projects.path().to_path_buf(), sessions.path().to_path_buf());

        let missing_goal = dispatch(&state, "goal_evaluate", json!({ "transcript": "ran it" }))
            .await
            .unwrap_err();
        assert!(missing_goal.to_string().contains("goal"));

        let missing_transcript = dispatch(&state, "goal_evaluate", json!({ "goal": "tests pass" }))
            .await
            .unwrap_err();
        assert!(missing_transcript.to_string().contains("transcript"));
    }

    /// `transcript` is optional — an advisor asked before anything happened is
    /// legal — but a turn with nothing to answer would spend a model call on
    /// silence.
    #[tokio::test]
    async fn advisor_chat_requires_a_history_and_nothing_else() {
        let projects = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let state = test_state(projects.path().to_path_buf(), sessions.path().to_path_buf());

        for params in [json!({}), json!({ "transcript": "ran it", "messages": [] })] {
            let error = dispatch(&state, "advisor_chat", params).await.unwrap_err();
            assert!(error
                .to_string()
                .contains("needs at least one user or assistant message"));
        }
    }

    #[tokio::test]
    async fn loop_report_list_rpc_discovers_the_latest_project_report() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let sessions = home.path().join("sessions");
        store::create_project(&projects, "demo", "Demo").unwrap();
        crate::loop_report::create(
            &projects,
            "demo",
            "loop-one",
            crate::loop_report::NewLoopReport {
                objective: "Polish the game loop".into(),
                reference: None,
                started_at_ms: 1_000,
            },
        )
        .unwrap();
        let state = test_state(projects, sessions);

        let result = dispatch(&state, "loop_report_list", json!({ "slug": "demo" }))
            .await
            .unwrap();

        assert_eq!(result["reports"][0]["loopId"], "loop-one");
        assert_eq!(result["reports"][0]["objective"], "Polish the game loop");
        assert_eq!(result["reports"][0]["status"], "running");
    }

    #[tokio::test]
    async fn video_contact_sheet_rpc_uses_the_core_tool_contract() {
        use base64::Engine;
        use image::{Rgb, RgbImage};

        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let sessions = home.path().join("sessions");
        store::create_project(&projects, "demo", "Demo").unwrap();
        let state = test_state(projects.clone(), sessions);
        let encode = |red: u8| {
            let image = RgbImage::from_pixel(12, 12, Rgb([red, 0, 0]));
            let mut cursor = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgb8(image)
                .write_to(&mut cursor, image::ImageFormat::Png)
                .unwrap();
            base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
        };

        let result = dispatch(
            &state,
            "video_contact_sheet",
            json!({
                "slug": "demo",
                "label": "rpc-motion",
                "frames": [
                    {"image": encode(10), "timestampSeconds": 0.0, "frameNumber": 1},
                    {"image": encode(220), "timestampSeconds": 0.1, "frameNumber": 2}
                ]
            }),
        )
        .await
        .unwrap();

        assert_eq!(result["frames"], 2);
        assert!(store::project_dir(&projects, "demo")
            .unwrap()
            .join(result["pngPath"].as_str().unwrap())
            .exists());
    }

    #[tokio::test]
    async fn capture_persist_rpc_writes_a_valid_project_relative_png() {
        use base64::Engine;
        use image::{Rgb, RgbImage};

        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let sessions = home.path().join("sessions");
        store::create_project(&projects, "demo", "Demo").unwrap();
        let state = test_state(projects.clone(), sessions);
        let image = RgbImage::from_pixel(2, 2, Rgb([25, 200, 240]));
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
        );

        let result = dispatch(
            &state,
            "capture_persist",
            json!({
                "slug": "demo",
                "path": "reports/loops/loop-one/iter1/frame-001.png",
                "dataUrl": data_url
            }),
        )
        .await
        .unwrap();

        assert_eq!(result["path"], "reports/loops/loop-one/iter1/frame-001.png");
        assert_eq!(result["mime"], "image/png");
        assert!(store::project_dir(&projects, "demo")
            .unwrap()
            .join(result["path"].as_str().unwrap())
            .exists());
    }

    #[tokio::test]
    async fn capture_persist_rpc_keeps_browser_evidence_out_of_an_attached_workspace() {
        use base64::Engine;
        use image::{Rgb, RgbImage};

        let home = tempfile::tempdir().unwrap();
        let attached = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let sessions = home.path().join("sessions");
        store::create_project(&projects, "demo", "Demo").unwrap();
        store::set_workspace_root(&projects, "demo", Some(attached.path().to_str().unwrap()))
            .unwrap();
        let state = test_state(projects.clone(), sessions);
        let image = RgbImage::from_pixel(2, 2, Rgb([200, 40, 180]));
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
        );

        let result = dispatch(
            &state,
            "capture_persist",
            json!({
                "slug": "demo",
                "path": "reports/loops/loop-one/iter1/frame-002.png",
                "dataUrl": data_url
            }),
        )
        .await
        .unwrap();

        let rel = result["path"].as_str().unwrap();
        assert!(store::project_dir(&projects, "demo")
            .unwrap()
            .join(rel)
            .is_file());
        assert!(!attached.path().join(rel).exists());
    }

    #[tokio::test]
    async fn agent_cancel_reaches_a_live_session_and_forgives_a_finished_one() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let sessions = home.path().join("sessions");
        let state = test_state(projects, sessions);

        // A stop aimed at a turn that already returned is answered, not
        // raised — the press races the loop by nature.
        let missing = dispatch(
            &state,
            "agent_cancel",
            json!({ "sessionId": "not-running" }),
        )
        .await
        .unwrap();
        assert_eq!(missing["found"], json!(false));
        assert_eq!(missing["cancelled"], json!(false));

        state.agents.ensure_session("live").await.unwrap();
        let stopped = dispatch(&state, "agent_cancel", json!({ "sessionId": "live" }))
            .await
            .unwrap();
        assert_eq!(stopped["found"], json!(true));
        assert_eq!(stopped["cancelled"], json!(true));

        let again = dispatch(&state, "agent_cancel", json!({ "sessionId": "live" }))
            .await
            .unwrap();
        assert_eq!(again["found"], json!(true));
        assert_eq!(again["cancelled"], json!(false));

        // The session survives its own stop: cancelling ends the turn, not
        // the conversation. (That the token itself flipped is asserted in
        // `agent`, which can see inside the session.)
        assert!(state
            .agents
            .sessions()
            .await
            .iter()
            .any(|session| session["id"] == json!("live")));
    }

    #[tokio::test]
    async fn deleting_a_session_removes_its_clean_generated_worktree() {
        let home = tempfile::tempdir().unwrap();
        let (projects, _repo) = git_fixture(home.path());
        let sessions = home.path().join("sessions");
        let state = test_state(projects, sessions.clone());

        let created = dispatch(&state, "session_create", json!({ "projectSlug": "demo" }))
            .await
            .unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        let path = created["workspaceRoot"].as_str().unwrap().to_string();
        assert!(std::path::Path::new(&path).is_dir());

        let deleted = dispatch(&state, "session_delete", json!({ "id": id }))
            .await
            .unwrap();
        assert_eq!(deleted["deleted"], true);
        assert_eq!(deleted["cleanup"]["worktree"]["deleted"], true);
        assert!(!std::path::Path::new(&path).exists());
        assert!(crate::sessions::load(&sessions, &id).is_err());
    }

    /// Archiving is the sidebar's reversible alternative to deleting, so it
    /// must leave the worktree the chat is bound to alone — a restore that
    /// came back to a missing workspace would not be a restore.
    #[tokio::test]
    async fn archiving_a_session_hides_it_but_keeps_its_worktree() {
        let home = tempfile::tempdir().unwrap();
        let (projects, _repo) = git_fixture(home.path());
        let sessions = home.path().join("sessions");
        let state = test_state(projects, sessions.clone());

        let created = dispatch(&state, "session_create", json!({ "projectSlug": "demo" }))
            .await
            .unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        let path = created["workspaceRoot"].as_str().unwrap().to_string();

        let archived = dispatch(&state, "session_archive", json!({ "id": id }))
            .await
            .unwrap();
        assert!(archived["archivedAt"].as_u64().is_some());
        assert!(std::path::Path::new(&path).is_dir());
        assert!(dispatch(&state, "session_list", json!({}))
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        let listed = dispatch(&state, "session_list", json!({ "archived": true }))
            .await
            .unwrap();
        assert_eq!(listed[0]["id"], json!(id));

        dispatch(&state, "session_restore", json!({ "id": id }))
            .await
            .unwrap();
        let live = dispatch(&state, "session_list", json!({})).await.unwrap();
        assert_eq!(live[0]["id"], json!(id));
        assert_eq!(live[0]["workspaceRoot"], json!(path));
    }

    /// Removing the project takes its archive with it: an archived chat whose
    /// game is gone has nothing to be restored into.
    #[tokio::test]
    async fn deleting_project_sessions_also_clears_the_archive() {
        let home = tempfile::tempdir().unwrap();
        let (projects, _repo) = git_fixture(home.path());
        let sessions = home.path().join("sessions");
        let state = test_state(projects, sessions.clone());

        let created = dispatch(&state, "session_create", json!({ "projectSlug": "demo" }))
            .await
            .unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        dispatch(&state, "session_archive", json!({ "id": id }))
            .await
            .unwrap();

        let removed = dispatch(&state, "session_delete_project", json!({ "slug": "demo" }))
            .await
            .unwrap();
        assert_eq!(removed["deleted"], json!(1));
        assert!(crate::sessions::load(&sessions, &id).is_err());
    }

    #[tokio::test]
    async fn failed_session_create_rolls_back_the_preallocated_record() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let sessions = home.path().join("sessions");
        store::create_project(&projects, "demo", "Demo").unwrap();
        let missing = home.path().join("does-not-exist");
        store::set_workspace_root(&projects, "demo", missing.to_str()).unwrap();
        let state = test_state(projects, sessions.clone());

        let error = dispatch(&state, "session_create", json!({ "projectSlug": "demo" }))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("unavailable"));
        assert_eq!(
            crate::sessions::list(&sessions, false)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn failed_session_fork_rolls_back_the_fork_record() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let sessions = home.path().join("sessions");
        store::create_project(&projects, "demo", "Demo").unwrap();
        let missing = home.path().join("does-not-exist");
        store::set_workspace_root(&projects, "demo", missing.to_str()).unwrap();
        crate::sessions::save(
            &sessions,
            &json!({
                "id": "source",
                "projectSlug": "demo",
                "messages": [{ "role": "user", "content": "build" }]
            }),
        )
        .unwrap();
        let state = test_state(projects, sessions.clone());

        let error = dispatch(&state, "session_fork", json!({ "id": "source" }))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("unavailable"));
        let listed = crate::sessions::list(&sessions, false).unwrap();
        let ids: Vec<&str> = listed
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|record| record["id"].as_str())
            .collect();
        assert_eq!(ids, vec!["source"]);
    }

    /// Build-order step 7 / system-prompt §3.1: the rendered prompt must stay
    /// small even for a large project, because the digest summarizes instead
    /// of dumping raw project JSON (which used to inline base64 assets and
    /// blow the context).
    ///
    /// Budgeted in two halves rather than one total. The static body is the
    /// shared prompt-cache prefix and moves only when someone edits the
    /// instructions; the per-session tail is the half a runaway digest would
    /// blow up. A single blended number could not say which half had grown,
    /// and left the tail with whatever slack the instructions happened not to
    /// use — which was, at one point, 2 bytes.
    /// A registered editor tool, so capability-gated prompt sections render.
    /// Editor tools reach core over `tool_register` at runtime, which is
    /// exactly why the sections that name them cannot be unconditional.
    /// A skills config with no external roots: these assertions are about the
    /// prompt's own shape, and must not vary with what the person running the
    /// suite happens to have installed under ~/.claude or ~/.codex.
    fn isolated_skills() -> crate::config::SkillsConfig {
        crate::config::SkillsConfig {
            disabled: Vec::new(),
            extra_dirs: Vec::new(),
        }
    }

    fn with_editor() -> HashMap<String, crate::tools::ToolDef> {
        HashMap::from([(
            "editor_scene_inspect".to_string(),
            crate::tools::ToolDef {
                name: "editor_scene_inspect".into(),
                description: "inspect".into(),
                parameters: json!({"type":"object"}),
                kind: crate::tools::ToolKind::Browser,
                access: crate::tools::Access::Guarded,
            },
        )])
    }

    #[test]
    fn only_the_two_actionable_modes_add_prompt_text() {
        // Manual and Full access are facts about the user's console, not
        // instructions. Sharing the empty tail also keeps them on one
        // prompt-cache prefix.
        assert_eq!(permission_mode_prompt("supervised"), "");
        assert_eq!(permission_mode_prompt("full-access"), "");
        assert_eq!(permission_mode_prompt("auto-accept-edits"), "");
        assert_eq!(permission_mode_prompt("not-a-mode"), "");
        assert!(permission_mode_prompt("auto").contains("ask_user"));
        assert!(permission_mode_prompt("plan").contains("plan_write"));
        assert!(permission_mode_prompt("plan").contains("exit_plan_mode"));
    }

    #[test]
    fn the_mode_section_never_promises_a_gate_the_mode_does_not_have() {
        // Auto's text must not tell the model its calls are approved, and
        // plan's must not suggest a way out other than the exit tool.
        let auto = permission_mode_prompt("auto");
        assert!(!auto.to_lowercase().contains("without review"));
        assert!(auto.contains("automatic reviewer"));
        let plan = permission_mode_prompt("plan");
        assert!(plan.contains("until the user approves"));
    }

    #[test]
    fn default_system_prompt_stays_small_and_never_dumps_project_json() {
        let projects = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        store::create_project(projects.path(), "big", "Big").unwrap();
        let mut project = store::read_project(projects.path(), "big").unwrap();
        // A distinctive base64-ish payload: if any of it appears in the
        // prompt, the raw project JSON leaked.
        let payload = "RAWBASE64PAYLOAD".repeat(256);
        project["entities"] = (0..500)
            .map(|i| json!({ "id": format!("entity-{i}"), "name": format!("entity-{i}-with-a-rather-long-descriptive-name") }))
            .collect();
        project["assets"] = (0..200)
            .map(|i| json!({ "id": format!("asset-{i}"), "name": format!("asset-{i}"), "data": payload }))
            .collect();
        project["tests"] = (0..50)
            .map(|i| json!({ "id": format!("test-{i}"), "name": format!("test-{i}") }))
            .collect();
        store::write_project(projects.path(), "big", &project).unwrap();

        let state = test_state(projects.path().to_path_buf(), sessions.path().to_path_buf());
        // With an editor attached, the editor workflow is described.
        let prompt = default_system_prompt(&state, "big", &isolated_skills(), &with_editor());
        assert!(prompt.contains("editor_persist_capture(path)"));
        assert!(prompt.contains("editor_camera_frame"));
        // Without one it is not, because none of those tools exist. A subagent
        // or graph node told to "run editor_run_pie" spends turns discovering
        // it cannot.
        let headless = default_system_prompt(&state, "big", &isolated_skills(), &HashMap::new());
        assert!(!headless.contains("editor_persist_capture"), "{headless}");
        assert!(!headless.contains("editor_run_pie"), "{headless}");
        assert!(prompt.contains("gameplay foreground entity ids"));
        assert!(prompt.contains("editor_console_history"));
        assert!(prompt.contains("Never copy screenshot data URLs"));

        assert!(
            STATIC_SYSTEM_PROMPT.len() <= 8 * 1024,
            "static body is {} bytes, budget is 8192",
            STATIC_SYSTEM_PROMPT.len()
        );
        // The gated editor section is instructions too, so it gets its own
        // budget rather than being charged to the per-session tail below —
        // otherwise attaching an editor would look like a runaway digest.
        assert!(
            EDITOR_TOOLING_PROMPT.len() <= 2 * 1024,
            "editor section is {} bytes, budget is 2048",
            EDITOR_TOOLING_PROMPT.len()
        );
        let instructions = STATIC_SYSTEM_PROMPT.len() + EDITOR_TOOLING_PROMPT.len();
        let session_tail = prompt.len() - instructions;
        assert!(
            session_tail <= 2 * 1024,
            "per-session block is {session_tail} bytes, budget is 2048"
        );
        assert!(
            !prompt.contains("RAWBASE64PAYLOAD"),
            "asset payload leaked into the prompt"
        );
        assert!(
            !prompt.contains("\"entities\""),
            "raw project JSON leaked into the prompt"
        );
        // The digest still names the project's contents.
        assert!(prompt.contains("500 entities"), "digest missing: {prompt}");
        assert!(prompt.contains("200 assets"));
        assert!(prompt.contains("50 tests"));
        assert!(prompt.contains("entity-0-with-a-rather-long-descriptive-name"));
        // The fan-out procedure moved into the `goal-loop` built-in skill, so
        // the prompt now carries the pointer and the skill carries the rule.
        // Asserted on both sides rather than dropped: the guidance still has
        // to reach a model that needs it, just not on turns that cannot use it.
        assert!(
            !prompt.contains("dependency-free Build roots"),
            "the loop procedure belongs in the goal-loop skill, not every turn"
        );
        assert!(
            prompt.contains("goal-loop"),
            "prompt must point at the skill"
        );
        let (_, loop_body) = crate::skills::load_skill(
            projects.path(),
            None,
            "goal-loop",
            &crate::config::SkillsConfig::default(),
        )
        .expect("goal-loop is a built-in and always loadable");
        assert!(loop_body.contains("dependency-free Build roots"));
        assert!(loop_body.contains("Integration Build depending on every root"));
    }

    #[test]
    fn memory_reaches_the_prompt_as_descriptions_only_and_never_the_static_body() {
        let projects = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        store::create_project(projects.path(), "demo", "Demo").unwrap();
        // Project scope keeps this hermetic: it resolves under the temp
        // projects root, so the test never reads the developer's own
        // ~/.cali/memory the way a global-scope write would.
        crate::memory::write_memory(
            projects.path(),
            Some("demo"),
            crate::memory::MemoryScope::Project,
            "port-rule",
            "core binds a fixed 8765 and the e2e suite refuses to reuse a running one",
            Some("reference"),
            "THE-BODY-SENTINEL — everything under the frontmatter.",
        )
        .unwrap();

        let state = test_state(projects.path().to_path_buf(), sessions.path().to_path_buf());
        let prompt = default_system_prompt(&state, "demo", &isolated_skills(), &with_editor());

        assert!(
            prompt.contains("port-rule (reference): core binds a fixed 8765"),
            "{prompt}"
        );
        // Progressive disclosure is the whole point: the body costs nothing
        // until the agent decides the description is worth following.
        assert!(
            !prompt.contains("THE-BODY-SENTINEL"),
            "memory body leaked into the prompt"
        );
        assert!(prompt.contains("memory_read"), "{prompt}");

        // The static body is the shared prompt-cache prefix across every
        // project and session (see STATIC_SYSTEM_PROMPT). A per-project memory
        // index interpolated into it would re-bill the whole static block on
        // every turn — the single most expensive mistake available here.
        assert!(!STATIC_SYSTEM_PROMPT.contains("port-rule"));
        assert!(
            prompt.find("port-rule").unwrap() > STATIC_SYSTEM_PROMPT.len(),
            "memory index must sit in the volatile tail, after the cached prefix"
        );

        // A project with no memories pays nothing at all.
        store::create_project(projects.path(), "bare", "Bare").unwrap();
        let bare = default_system_prompt(&state, "bare", &isolated_skills(), &with_editor());
        assert!(!bare.contains("Memory from earlier sessions"), "{bare}");
    }

    #[test]
    fn default_system_prompt_pins_script_and_test_runtime_contracts() {
        let projects = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        store::create_project(projects.path(), "demo", "Demo").unwrap();
        let state = test_state(projects.path().to_path_buf(), sessions.path().to_path_buf());

        // These contracts govern the editor's script/test runtime, so they
        // ride with the editor section rather than the invariant base.
        let prompt = default_system_prompt(&state, "demo", &isolated_skills(), &with_editor());
        for contract in [
            "only owner `entity` is writable",
            "`state.find(nameOrId)`",
            "`state.scene`",
            "are frozen snapshots",
            "`state.patch(nameOrId,{position?,rotation?,scale?})`",
            "merges finite partial",
            "Direct owner assignments require full",
            "`{x,y,z}`",
            "materials are static editor edits, never runtime writes",
            "`await assert(condition, positiveMessage)`",
            "Never use `|| true`",
            "expected positive behavior, not inverted failure",
        ] {
            assert!(
                prompt.contains(contract),
                "missing runtime contract {contract:?}: {prompt}"
            );
        }
    }

    #[tokio::test]
    async fn session_binding_rejects_a_spoofed_agent_workspace() {
        let projects = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        store::create_project(projects.path(), "demo", "Demo").unwrap();
        let state = test_state(projects.path().to_path_buf(), sessions.path().to_path_buf());
        let created = dispatch(&state, "session_create", json!({ "projectSlug": "demo" }))
            .await
            .unwrap();

        let error = dispatch(
            &state,
            "agent_chat",
            json!({
                "sessionId": created["id"],
                "projectSlug": "demo",
                "workspaceRoot": "/tmp/not-the-session-workspace",
                "messages": []
            }),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("different workspace"));
    }

    #[tokio::test]
    async fn external_editor_rpc_roundtrips_only_through_the_attached_session() {
        let projects = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        store::create_project(projects.path(), "demo", "Demo").unwrap();
        let state = test_state(projects.path().to_path_buf(), sessions.path().to_path_buf());
        dispatch(
            &state,
            "tool_register",
            json!({ "tools": [{
                "name": "editor_echo",
                "description": "Echo",
                "parameters": { "type": "object" }
            }] }),
        )
        .await
        .unwrap();
        let created = dispatch(&state, "session_create", json!({ "projectSlug": "demo" }))
            .await
            .unwrap();
        let session_id = created["id"].as_str().unwrap();
        let workspace_root = created["workspaceRoot"].as_str().unwrap();

        let inactive = dispatch(
            &state,
            "editor_tool_call",
            json!({ "sessionId": session_id, "tool": "editor_echo", "arguments": {} }),
        )
        .await
        .unwrap_err();
        assert!(inactive.to_string().contains("no CaliCode editor"));

        dispatch(
            &state,
            "editor_attach",
            json!({
                "sessionId": session_id,
                "clientId": "client-a",
                "projectSlug": "demo",
                "workspaceRoot": workspace_root
            }),
        )
        .await
        .unwrap();
        let mut events = state.bus.subscribe();
        let call = {
            let state = state.clone();
            let session_id = session_id.to_string();
            tokio::spawn(async move {
                dispatch(
                    &state,
                    "editor_tool_call",
                    json!({
                        "sessionId": session_id,
                        "tool": "editor_echo",
                        "arguments": { "message": "hello" }
                    }),
                )
                .await
            })
        };
        let event = events.recv().await.unwrap();
        assert_eq!(event["targetSessionId"], session_id);
        dispatch(
            &state,
            "editor_tool_result",
            json!({
                "requestId": event["requestId"],
                "clientId": "client-a",
                "result": { "echo": "hello" }
            }),
        )
        .await
        .unwrap();
        assert_eq!(call.await.unwrap().unwrap()["echo"], "hello");

        // Attach a second chat after the first one. Session-scoped ownership
        // keeps both frontends routable instead of making the later attach
        // invalidate the first session.
        let second = dispatch(&state, "session_create", json!({ "projectSlug": "demo" }))
            .await
            .unwrap();
        let second_id = second["id"].as_str().unwrap().to_string();
        let second_root = second["workspaceRoot"].as_str().unwrap().to_string();
        dispatch(
            &state,
            "editor_attach",
            json!({
                "sessionId": second_id,
                "clientId": "client-b",
                "projectSlug": "demo",
                "workspaceRoot": second_root
            }),
        )
        .await
        .unwrap();

        let mut events = state.bus.subscribe();
        let first_call = {
            let state = state.clone();
            let session_id = session_id.to_string();
            tokio::spawn(async move {
                dispatch(
                    &state,
                    "editor_tool_call",
                    json!({
                        "sessionId": session_id,
                        "tool": "editor_echo",
                        "arguments": { "message": "first-still-works" }
                    }),
                )
                .await
            })
        };
        let event = events.recv().await.unwrap();
        assert_eq!(event["targetClientId"], "client-a");
        dispatch(
            &state,
            "editor_tool_result",
            json!({
                "requestId": event["requestId"],
                "clientId": "client-a",
                "result": { "echo": "first-still-works" }
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            first_call.await.unwrap().unwrap()["echo"],
            "first-still-works"
        );

        let second_call = {
            let state = state.clone();
            let second_id = second_id.clone();
            tokio::spawn(async move {
                dispatch(
                    &state,
                    "editor_tool_call",
                    json!({
                        "sessionId": second_id,
                        "tool": "editor_echo",
                        "arguments": { "message": "second" }
                    }),
                )
                .await
            })
        };
        let event = events.recv().await.unwrap();
        assert_eq!(event["targetClientId"], "client-b");
        dispatch(
            &state,
            "editor_tool_result",
            json!({
                "requestId": event["requestId"],
                "clientId": "client-b",
                "result": { "echo": "second" }
            }),
        )
        .await
        .unwrap();
        assert_eq!(second_call.await.unwrap().unwrap()["echo"], "second");

        // Reattaching the same session replaces only that session's owner.
        // A late reply from the replaced frontend cannot consume a request
        // now targeted at the new owner.
        dispatch(
            &state,
            "editor_attach",
            json!({
                "sessionId": session_id,
                "clientId": "client-a2",
                "projectSlug": "demo",
                "workspaceRoot": workspace_root
            }),
        )
        .await
        .unwrap();
        let reattached_call = {
            let state = state.clone();
            let session_id = session_id.to_string();
            tokio::spawn(async move {
                dispatch(
                    &state,
                    "editor_tool_call",
                    json!({
                        "sessionId": session_id,
                        "tool": "editor_echo",
                        "arguments": { "message": "reattached" }
                    }),
                )
                .await
            })
        };
        let event = events.recv().await.unwrap();
        assert_eq!(event["targetClientId"], "client-a2");
        let stale = dispatch(
            &state,
            "editor_tool_result",
            json!({
                "requestId": event["requestId"],
                "clientId": "client-a",
                "result": { "echo": "stale" }
            }),
        )
        .await
        .unwrap_err();
        assert!(stale.to_string().contains("another client"));
        dispatch(
            &state,
            "editor_tool_result",
            json!({
                "requestId": event["requestId"],
                "clientId": "client-a2",
                "result": { "echo": "reattached" }
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            reattached_call.await.unwrap().unwrap()["echo"],
            "reattached"
        );
    }

    /// System-prompt §3.1: every dynamic block degrades to an explicit
    /// fallback line — no skills, no browser tools, even an unreadable
    /// project must still yield a usable prompt.
    #[test]
    fn default_system_prompt_degrades_when_skills_and_browser_tools_are_absent() {
        let projects = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        store::create_project(projects.path(), "bare", "Bare").unwrap();
        let state = test_state(projects.path().to_path_buf(), sessions.path().to_path_buf());

        // No editor connected: the browser-tools slot says so explicitly
        // instead of rendering empty.
        let prompt = default_system_prompt(&state, "bare", &isolated_skills(), &HashMap::new());
        assert!(prompt.contains("none registered — no editor is connected"));
        // No CALICODE.md or skills/ folder: the skills slot falls back.
        assert!(prompt.contains("No CALICODE.md or skills/ found"));

        // A slug with no readable project still renders a full prompt.
        let prompt = default_system_prompt(&state, "missing", &isolated_skills(), &HashMap::new());
        assert!(prompt.contains("project not readable yet"));
        assert!(prompt.contains("Match the ask to the machinery"));
    }

    #[test]
    fn peek_id_recovers_from_a_valid_envelope() {
        let bytes = br#"{"jsonrpc":"2.0","id":"abc","method":"ping"}"#;
        assert_eq!(peek_id_from_bytes(bytes), Some(Value::String("abc".into())));
    }

    #[test]
    fn peek_id_returns_none_when_body_is_not_json() {
        assert_eq!(peek_id_from_bytes(b"not-json"), None);
    }

    #[tokio::test]
    async fn jsonrpc_error_response_keeps_the_envelope_shape_and_id() {
        let response = jsonrpc_error_response(
            Value::String("req-7".into()),
            -32001,
            "request body exceeds the 96 MB RPC limit",
        );
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["jsonrpc"], "2.0");
        assert_eq!(parsed["id"], "req-7");
        assert_eq!(parsed["error"]["code"], -32001);
        assert_eq!(
            parsed["error"]["message"],
            "request body exceeds the 96 MB RPC limit"
        );
    }

    /// Regression: a body larger than the cap used to trip axum's default
    /// 2 MB limit, return a plain-text 413, and confuse the client into
    /// marking core offline. The `RpcEnvelope` extractor + the
    /// `DefaultBodyLimit` layer now convert that into a JSON-RPC error
    /// envelope the client can parse.
    #[tokio::test]
    async fn rpc_envelope_rejects_oversized_body_with_structured_error() {
        let oversize = vec![b'A'; RPC_BODY_LIMIT_BYTES + 1024];
        let state = test_state(
            tempfile::tempdir().unwrap().path().to_path_buf(),
            tempfile::tempdir().unwrap().path().to_path_buf(),
        );
        let router = test_router(state);

        let request = axum::extract::Request::builder()
            .method("POST")
            .uri("/rpc")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(oversize))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["jsonrpc"], "2.0");
        assert_eq!(parsed["error"]["code"], -32001);
        let message = parsed["error"]["message"].as_str().expect("error message");
        assert!(
            message.contains("RPC limit"),
            "expected limit message, got: {message}"
        );
    }

    /// A body that fits under the cap but is not valid JSON must still
    /// return a JSON-RPC error envelope (JSON-RPC parse-error code -32700)
    /// rather than axum's plain-text "Failed to deserialize" body.
    #[tokio::test]
    async fn rpc_envelope_rejects_malformed_json_with_structured_error() {
        let state = test_state(
            tempfile::tempdir().unwrap().path().to_path_buf(),
            tempfile::tempdir().unwrap().path().to_path_buf(),
        );
        let router = test_router(state);

        let request = axum::extract::Request::builder()
            .method("POST")
            .uri("/rpc")
            .header("content-type", "application/json")
            .body(axum::body::Body::from("not-json"))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["jsonrpc"], "2.0");
        assert_eq!(parsed["error"]["code"], -32700);
        assert!(parsed["error"]["message"]
            .as_str()
            .expect("error message")
            .starts_with("invalid JSON"));
    }

    /// A body under the cap that parses as valid JSON should reach the
    /// handler. This confirms the extractor doesn't swallow well-formed
    /// requests once the layer is in place.
    #[tokio::test]
    async fn rpc_envelope_passes_valid_small_requests_through() {
        let state = test_state(
            tempfile::tempdir().unwrap().path().to_path_buf(),
            tempfile::tempdir().unwrap().path().to_path_buf(),
        );
        let router = test_router(state);

        let request = axum::extract::Request::builder()
            .method("POST")
            .uri("/rpc")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(
                r#"{"jsonrpc":"2.0","id":"ok-1","method":"ping"}"#,
            ))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let parsed: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["id"], "ok-1");
        assert_eq!(parsed["result"]["pong"], true);
    }

    // ----------------------------------------------------------------------
    // Restore points
    //
    // Against a real repository throughout. The whole feature is a claim about
    // what `git stash create` and `git restore` do to a working tree, and a
    // mock of git would only assert that the claim was restated.
    // ----------------------------------------------------------------------

    fn git_ok(repo: &std::path::Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?} failed: {output:?}");
    }

    fn git_out(repo: &std::path::Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?} failed: {output:?}");
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    /// Ids are minted from the wall clock, so two taken in the same
    /// millisecond only differ by a collision suffix. Ordering assertions are
    /// about time, not about the suffix rule.
    async fn tick() {
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }

    /// The point of a git-backed restore point: taking one during a run is
    /// invisible. Nothing the user or the next tool call can see may move —
    /// not the working tree, not the index, not HEAD.
    #[tokio::test]
    async fn checkpoint_create_leaves_the_working_tree_index_and_head_untouched() {
        let home = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let (projects, repo) = git_fixture(home.path());
        let state = test_state(projects, sessions.path().to_path_buf());

        std::fs::write(repo.join("README.md"), "edited mid-run").unwrap();
        std::fs::write(repo.join("staged.txt"), "staged").unwrap();
        git_ok(&repo, &["add", "staged.txt"]);
        std::fs::write(repo.join("loose.txt"), "untracked").unwrap();

        let status_before = git_out(&repo, &["status", "--porcelain"]);
        let head_before = git_out(&repo, &["rev-parse", "HEAD"]);
        let branch_before = git_out(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]);

        let created = dispatch(&state, "checkpoint_create", json!({ "slug": "demo" }))
            .await
            .unwrap();

        assert_eq!(created["kind"], "git");
        assert!(created["id"].as_str().unwrap().starts_with("git-"));
        assert_eq!(created["sha"].as_str().unwrap().len(), 40);
        assert!(created["createdAtMs"].as_i64().unwrap() > 0);

        assert_eq!(git_out(&repo, &["status", "--porcelain"]), status_before);
        assert_eq!(git_out(&repo, &["rev-parse", "HEAD"]), head_before);
        assert_eq!(
            git_out(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]),
            branch_before
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("README.md")).unwrap(),
            "edited mid-run"
        );

        // The commit has to survive a gc, or a three-day run loses the only
        // object that could undo it.
        let sha = created["sha"].as_str().unwrap();
        let id = created["id"].as_str().unwrap();
        assert_eq!(
            git_out(
                &repo,
                &["rev-parse", &format!("refs/calicode/checkpoints/{id}")]
            ),
            sha
        );
    }

    /// The case the whole feature exists for: the agent rewrote a source file
    /// and then deleted it.
    #[tokio::test]
    async fn checkpoint_restore_brings_back_a_modified_then_deleted_file() {
        let home = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let (projects, repo) = git_fixture(home.path());
        let state = test_state(projects, sessions.path().to_path_buf());

        std::fs::write(repo.join("README.md"), "the version worth keeping").unwrap();
        let created = dispatch(&state, "checkpoint_create", json!({ "slug": "demo" }))
            .await
            .unwrap();

        std::fs::write(repo.join("README.md"), "ruined").unwrap();
        std::fs::remove_file(repo.join("README.md")).unwrap();

        let restored = dispatch(
            &state,
            "checkpoint_restore",
            json!({ "slug": "demo", "id": created["id"] }),
        )
        .await
        .unwrap();

        assert_eq!(restored["restored"], true);
        assert_eq!(restored["kind"], "git");
        assert_eq!(restored["sha"], created["sha"]);
        assert_eq!(
            std::fs::read_to_string(repo.join("README.md")).unwrap(),
            "the version worth keeping"
        );
        assert!(!restored["replaced"].as_array().unwrap().is_empty());
    }

    /// A restore rewinds the working tree and nothing else. The user's branch
    /// and every commit made during the run stay exactly where they were —
    /// otherwise the rescue costs more than the accident.
    #[tokio::test]
    async fn checkpoint_restore_does_not_move_head_or_change_the_branch() {
        let home = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let (projects, repo) = git_fixture(home.path());
        let state = test_state(projects, sessions.path().to_path_buf());

        git_ok(&repo, &["checkout", "-b", "loop-work"]);
        std::fs::write(repo.join("README.md"), "before the loop").unwrap();
        let created = dispatch(&state, "checkpoint_create", json!({ "slug": "demo" }))
            .await
            .unwrap();

        std::fs::write(repo.join("later.txt"), "added during the run").unwrap();
        git_ok(&repo, &["add", "later.txt"]);
        git_ok(&repo, &["commit", "-m", "work done during the loop"]);
        let head_before = git_out(&repo, &["rev-parse", "HEAD"]);

        dispatch(
            &state,
            "checkpoint_restore",
            json!({ "slug": "demo", "id": created["id"] }),
        )
        .await
        .unwrap();

        assert_eq!(git_out(&repo, &["rev-parse", "HEAD"]), head_before);
        assert_eq!(
            git_out(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]),
            "loop-work"
        );
        // The commit is still reachable, so nothing was actually lost.
        assert!(git_out(&repo, &["log", "-1", "--format=%s"]).contains("during the loop"));
        // …and the file it added is out of the way in the working tree.
        assert!(!repo.join("later.txt").exists());
    }

    /// `git stash create` prints nothing for a clean tree. The restore point
    /// still has to exist and still has to work — the first iteration of a
    /// loop almost always starts clean.
    #[tokio::test]
    async fn a_clean_tree_still_produces_a_usable_restore_point() {
        let home = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let (projects, repo) = git_fixture(home.path());
        let state = test_state(projects, sessions.path().to_path_buf());

        assert_eq!(git_out(&repo, &["status", "--porcelain"]), "");
        let created = dispatch(&state, "checkpoint_create", json!({ "slug": "demo" }))
            .await
            .unwrap();
        assert_eq!(created["kind"], "git");
        assert_eq!(created["sha"], git_out(&repo, &["rev-parse", "HEAD"]));

        std::fs::write(repo.join("README.md"), "trashed").unwrap();
        dispatch(
            &state,
            "checkpoint_restore",
            json!({ "slug": "demo", "id": created["id"] }),
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(repo.join("README.md")).unwrap(),
            "demo"
        );
    }

    /// Nothing enumerated restore points before this method, which is why the
    /// client had to keep its own registry of the ids it had seen.
    #[tokio::test]
    async fn checkpoint_list_returns_git_and_project_entries_newest_first() {
        let home = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let (projects, repo) = git_fixture(home.path());
        let state = test_state(projects, sessions.path().to_path_buf());

        std::fs::write(repo.join("README.md"), "first").unwrap();
        let first = dispatch(&state, "checkpoint_create", json!({ "slug": "demo" }))
            .await
            .unwrap();
        tick().await;
        let copy = dispatch(&state, "project_checkpoint", json!({ "slug": "demo" }))
            .await
            .unwrap();
        tick().await;
        std::fs::write(repo.join("README.md"), "second").unwrap();
        let second = dispatch(&state, "checkpoint_create", json!({ "slug": "demo" }))
            .await
            .unwrap();

        let listed = dispatch(&state, "checkpoint_list", json!({ "slug": "demo" }))
            .await
            .unwrap();
        let entries = listed["checkpoints"].as_array().unwrap();
        assert_eq!(entries.len(), 3);

        let ids: Vec<&str> = entries
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            [
                second["id"].as_str().unwrap(),
                copy["id"].as_str().unwrap(),
                first["id"].as_str().unwrap(),
            ]
        );
        let kinds: Vec<&str> = entries
            .iter()
            .map(|entry| entry["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["git", "project", "git"]);
        assert_eq!(entries[0]["sha"], second["sha"]);
        assert!(entries[0]["subject"].as_str().unwrap().contains("WIP on"));
        assert!(entries[1].get("sha").is_none());
    }

    /// Unbounded, a three-day run at one restore point every fifteen minutes
    /// leaves ~288 copies of the project directory behind.
    #[tokio::test]
    async fn checkpoint_prune_keeps_exactly_the_newest_requested() {
        let home = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let (projects, repo) = git_fixture(home.path());
        let state = test_state(projects.clone(), sessions.path().to_path_buf());

        let mut ids = Vec::new();
        for round in 0..3 {
            std::fs::write(repo.join("README.md"), format!("round {round}")).unwrap();
            let created = dispatch(&state, "checkpoint_create", json!({ "slug": "demo" }))
                .await
                .unwrap();
            ids.push(created["id"].as_str().unwrap().to_string());
            tick().await;
        }
        let copy = dispatch(&state, "project_checkpoint", json!({ "slug": "demo" }))
            .await
            .unwrap();
        let newest = copy["id"].as_str().unwrap().to_string();

        let pruned = dispatch(
            &state,
            "checkpoint_prune",
            json!({ "slug": "demo", "keep": 2 }),
        )
        .await
        .unwrap();
        assert_eq!(pruned["removed"], json!(2));
        assert_eq!(pruned["kept"], json!(2));

        let listed = dispatch(&state, "checkpoint_list", json!({ "slug": "demo" }))
            .await
            .unwrap();
        let remaining: Vec<&str> = listed["checkpoints"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect();
        assert_eq!(remaining, [newest.as_str(), ids[2].as_str()]);

        // Pruned entries are gone from disk, not merely hidden from the list.
        assert!(!projects
            .join("demo")
            .join("checkpoints")
            .join(&ids[0])
            .exists());
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["show-ref", "--verify", "--quiet"])
            .arg(format!("refs/calicode/checkpoints/{}", ids[0]))
            .status()
            .unwrap()
            .success()
            .eq(&false));

        assert!(dispatch(
            &state,
            "checkpoint_prune",
            json!({ "slug": "demo", "keep": 0 })
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("at least 1"));
    }

    /// A game with no folder attached keeps the old mechanism, and the single
    /// entry point picks it without the client having to ask.
    #[tokio::test]
    async fn a_game_without_a_workspace_falls_back_to_the_project_copy() {
        let projects = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        store::create_project(projects.path(), "solo", "Solo").unwrap();
        let state = test_state(projects.path().to_path_buf(), sessions.path().to_path_buf());

        let created = dispatch(&state, "checkpoint_create", json!({ "slug": "solo" }))
            .await
            .unwrap();
        assert_eq!(created["kind"], "project");
        assert!(created["id"].as_str().unwrap().starts_with("cp-"));
        assert!(created["createdAtMs"].as_i64().unwrap() > 0);
        assert!(created["notCovered"].as_array().unwrap().is_empty());

        store::rename_project(projects.path(), "solo", "Renamed mid-run").unwrap();
        let restored = dispatch(
            &state,
            "checkpoint_restore",
            json!({ "slug": "solo", "id": created["id"] }),
        )
        .await
        .unwrap();

        assert_eq!(restored["kind"], "project");
        assert_eq!(restored["project"]["title"], "Solo");
        assert_eq!(
            store::read_project(projects.path(), "solo").unwrap()["title"],
            "Solo"
        );
    }

    /// `git stash create` never captured untracked files, and a restore that
    /// silently half-covers the tree is worse than one that says so.
    #[tokio::test]
    async fn untracked_files_and_the_project_document_are_reported_as_not_covered() {
        let home = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        let (projects, repo) = git_fixture(home.path());
        let state = test_state(projects, sessions.path().to_path_buf());

        std::fs::write(repo.join("generated.png"), "not committed").unwrap();
        let created = dispatch(&state, "checkpoint_create", json!({ "slug": "demo" }))
            .await
            .unwrap();
        let notes = created["notCovered"].as_array().unwrap();
        assert!(
            notes
                .iter()
                .any(|note| note.as_str().unwrap().contains("1 untracked file(s)")),
            "{notes:?}"
        );
        assert!(
            notes
                .iter()
                .any(|note| note.as_str().unwrap().contains("project document for demo")),
            "{notes:?}"
        );

        let restored = dispatch(
            &state,
            "checkpoint_restore",
            json!({ "slug": "demo", "id": created["id"] }),
        )
        .await
        .unwrap();
        let notes = restored["notCovered"].as_array().unwrap();
        assert!(
            notes
                .iter()
                .any(|note| note.as_str().unwrap().contains("1 untracked file(s)")),
            "{notes:?}"
        );
        // Reported as not covered because it genuinely is: still there.
        assert!(repo.join("generated.png").exists());
    }
}
