use crate::agent::AgentOptions;
use crate::assets;
use crate::baselines;
use crate::devserver;
use crate::image3d;
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
            Ok(serde_json::to_value(&*config)?)
        }
        "model_list" => {
            let config = state.config.read().await;
            Ok(model_list(&config)?)
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
        "subagent_spawn" => crate::tools::spawn_subagent(state, &params).await,
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
            let sessions = archive_project_sessions(state, slug).await?;
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
            let (_, path) = crate::tools::resolve_game_file(
                &state.projects_root,
                slug,
                str_param(&params, "path")?,
            )?;
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
            let disabled = { state.config.read().await.skills.disabled.clone() };
            let slug = params.get("projectSlug").and_then(Value::as_str);
            Ok(json!({
                "skills": crate::skills::list_skills(&state.projects_root, slug, &disabled)
            }))
        }
        "skill_read" => {
            // UI preview: a disabled skill is still readable, so the empty
            // disabled slice is deliberate.
            let slug = params.get("projectSlug").and_then(Value::as_str);
            let (info, body) = crate::skills::load_skill(
                &state.projects_root,
                slug,
                str_param(&params, "name")?,
                &[],
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
        "graph_run" => crate::graph::run(state, str_param(&params, "graphId")?).await,
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
            let (skills_disabled, permission_rules) = {
                let config = state.config.read().await;
                (
                    config.skills.disabled.clone(),
                    agent_permission_rules(&config.permissions),
                )
            };
            let system = params
                .get("system")
                .and_then(|v| v.as_str())
                .map(String::from)
                .or_else(|| {
                    project_slug.as_deref().map(|slug| {
                        default_system_prompt(state, slug, &skills_disabled, &registered)
                    })
                });
            let options = AgentOptions {
                permission_mode: params
                    .get("permissionMode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("full-access")
                    .to_string(),
                max_turns: params.get("maxTurns").and_then(|v| v.as_u64()).unwrap_or(8) as usize,
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
                project_slug,
                workspace_root,
                // Top-level chat: approvals stay on its own session, depth 0.
                approval_session: None,
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
        "agent_approval_response" => Ok(state
            .agents
            .submit_approval(
                str_param(&params, "sessionId")?,
                str_param(&params, "requestId")?,
                params
                    .get("approved")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            )
            .await?),
        "agent_sessions" => Ok(json!(state.agents.sessions().await)),
        // Compact a live agent session: prune old tool results, summarize the
        // middle via one model call, soft-archive the replaced turns in the
        // session file, and rewrite the in-memory transcript.
        "session_compact" => Ok(state
            .agents
            .compact_session(state, str_param(&params, "sessionId")?)
            .await?),
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
        "session_list" => crate::sessions::list(&state.sessions_root),
        "session_load" => crate::sessions::load(&state.sessions_root, str_param(&params, "id")?),
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
            archive_project_sessions(state, str_param(&params, "slug")?).await
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
fn default_system_prompt(
    state: &AppState,
    slug: &str,
    skills_disabled: &[String],
    registered: &std::collections::HashMap<String, ToolDef>,
) -> String {
    let template_ids = crate::graph::list_templates(&state.sessions_root)
        .iter()
        .filter_map(|template| template["id"].as_str().map(str::to_string))
        .collect::<Vec<_>>()
        .join(", ");
    let mut prompt = format!(
        "You are CaliCode — an AI game engineer for a three.js game workbench. You build\n\
real, playable scenes, scripts, assets, and tests, and for any goal with a\n\
quality bar you do not stop at \"works\": you iterate until a harsh, independent\n\
judge scores the result at or above a named world-class reference. That\n\
substrate is fixed: everything ships inside this three.js editor and its tools —\n\
never propose switching engines as a path to quality.\n\
\n\
## Project\n\
{project_digest}\n\
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
## The loop: name the bar -> decompose -> fan out -> judge blind -> iterate\n\
1. NAME THE BAR. Restate the user's goal against a specific, named reference —\n\
   the best-in-class published game (or asset/scene) in the same genre. Prefer\n\
   a matching template's reference (template_list shows: {template_ids}); else\n\
   pick the obvious genre flagship and tell the user which you chose; if the\n\
   genre is genuinely ambiguous, ask. If you cannot name the reference you are\n\
   matching, you do not yet understand the goal.\n\
2. DECOMPOSE. Call graph_plan: small tasks, one owner each, explicit\n\
   acceptance criteria, dependency edges. Criteria must demand primary\n\
   evidence — files written, entities present, tests green, frames captured —\n\
   because unevidenced claims count as unmet. For a multi-domain game, use at\n\
   least three dependency-free Build roots (gameplay/entities, assets/visuals,\n\
   scripts/tests), then a separate Integration Build depending on every root,\n\
   and a terminal Judge depending on Integration. Never serialize independent\n\
   roots. Every plan ends in a judge node\n\
   carrying the named reference and a threshold (90 = would pass review at a\n\
   top studio; 100 = utterly perfect).\n\
   For a /loop run, call loop_report_start before graph_plan and append one\n\
   loop_report_iteration after every build/play/judge pass. Carry its\n\
   nextIterationMemory into the next pass; finish with loop_report_update.\n\
3. FAN OUT. Call graph_run. Each node runs as a fresh subagent (planner,\n\
   coder, artist, tester, critic) owning only its own item — focused context\n\
   beats one overloaded transcript, and per-item quality beats averaged\n\
   quality: nothing weak may hide behind something strong.\n\
4. JUDGE BLIND. The judge is a fresh critic that never sees how anything was\n\
   built and has no stake in it passing. It inspects the live artifact itself —\n\
   frames, scene state, test runs — and judges as a blind side-by-side against\n\
   the reference: \"if these two screenshots were unlabeled, which would a\n\
   player pick, and why?\" The 'why not ours' becomes the punch list. Harshness\n\
   is its job: finding flaws is success, approval without evidence is failure.\n\
5. ITERATE PER ITEM. Below threshold, only the failed item's builders re-run,\n\
   armed with the judge's punch list; passed items are left alone. Rejection\n\
   is the system working. The judge — never a builder — decides when an item\n\
   is done, and \"done\" means the score crossed the threshold, not \"good\n\
   progress was made\". If attempts are exhausted, report the graph as BLOCKED\n\
   with the last punch list — never present it as finished. If a graph ends\n\
   blocked, read graph_status, repair the stuck node's plan, and re-run.\n\
\n\
The acceptance criteria are the floor; the reference is the bar. Pursue every\n\
quality dimension the reference exhibits — lighting, materials, silhouette,\n\
motion feel, feedback, readability, audio hooks — whether or not anyone listed\n\
it. That surplus beyond the criteria is the difference between \"meets spec\"\n\
and a result the judge is genuinely wowed by, and the loop runs until it is.\n\
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
Editor (browser-registered, live scene access; set depends on the open\n\
editor): {browser_tools}{mcp_tools}\n\
\n\
Scripts: only owner `entity` is writable. `state.find(nameOrId)`/`state.scene`\n\
are frozen snapshots. For cross-entity transforms call\n\
`state.patch(nameOrId,{{position?,rotation?,scale?}})` merges finite partial\n\
`{{x?,y?,z?}}`. Direct owner assignments require full\n\
finite `{{x,y,z}}`; materials are static editor edits, never runtime writes.\n\
\n\
Verify everything you claim: before visual evidence, call editor_scene_inspect and\n\
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
Never use `|| true`; messages state expected positive behavior, not inverted failure.\n\
Checkpoint (project_checkpoint) before\n\
risky multi-step changes so project_revert can rescue you.\n\
\n\
## Skills\n\
Project-specific knowledge lives in the game folder. {skills_block}\n\
Read the relevant skill file with file_read BEFORE working in its area, and\n\
follow it over your defaults. When you learn something durable about this\n\
project, offer to record it in CALICODE.md.\n\
\n\
## Quality bar\n\
\"Done\" means: it runs in PIE without errors, tests pass, the scene reads\n\
clearly in a captured frame, and the judge scored it at or above threshold\n\
against its named reference. Never present unverified work as finished; say\n\
exactly what was verified and how, and what the judge scored. Be concise in\n\
chat — put the effort into the work, not the narration.",
        project_digest = project_digest(&state.projects_root, slug),
        template_ids = template_ids,
        browser_tools = browser_tools_block(registered),
        mcp_tools = mcp_tools_block(registered),
        skills_block = skills_block(&state.projects_root, slug),
    );
    // Installed skills (global ~/.cali/skills + <project>/skills SKILL.md
    // format) load on demand via skill_load; the index is appended so the
    // agent knows what exists without paying for the bodies.
    prompt.push_str(&crate::skills::prompt_index(
        &state.projects_root,
        Some(slug),
        skills_disabled,
    ));
    prompt
}

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

/// Clean and archive every persisted chat for a project. Durable session
/// records are user data, so only explicit archive/delete operations remove
/// them; generated worktrees are removed only when their metadata is an exact,
/// clean session worktree.
async fn archive_project_sessions(state: &AppState, slug: &str) -> Result<Value> {
    let listed = crate::sessions::list(&state.sessions_root)?;
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
    let archived = crate::sessions::archive_project(&state.sessions_root, slug)?;
    Ok(json!({
        "archived": archived,
        "cleanup": cleanup,
    }))
}

fn str_param<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing required string {}", key))
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
            shutdown: std::sync::Arc::new(tokio::sync::watch::channel(false).0),
        }
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
            crate::sessions::list(&sessions)
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
        let listed = crate::sessions::list(&sessions).unwrap();
        let ids: Vec<&str> = listed
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|record| record["id"].as_str())
            .collect();
        assert_eq!(ids, vec!["source"]);
    }

    /// Build-order step 7 / system-prompt §3.1: the rendered prompt must stay
    /// under 8 KB even for a large project, because the digest summarizes
    /// instead of dumping raw project JSON (which used to inline base64 assets
    /// and blow the context).
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
        let prompt = default_system_prompt(&state, "big", &[], &HashMap::new());
        assert!(prompt.contains("editor_persist_capture(path)"));
        assert!(prompt.contains("editor_camera_frame"));
        assert!(prompt.contains("gameplay foreground entity ids"));
        assert!(prompt.contains("editor_console_history"));
        assert!(prompt.contains("Never copy screenshot data URLs"));

        assert!(
            prompt.len() <= 8 * 1024,
            "prompt is {} bytes, budget is 8192",
            prompt.len()
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
        assert!(prompt.contains("dependency-free Build roots"));
        assert!(prompt.contains("Integration Build depending on every root"));
    }

    #[test]
    fn default_system_prompt_pins_script_and_test_runtime_contracts() {
        let projects = tempfile::tempdir().unwrap();
        let sessions = tempfile::tempdir().unwrap();
        store::create_project(projects.path(), "demo", "Demo").unwrap();
        let state = test_state(projects.path().to_path_buf(), sessions.path().to_path_buf());

        let prompt = default_system_prompt(&state, "demo", &[], &HashMap::new());
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
        let prompt = default_system_prompt(&state, "bare", &[], &HashMap::new());
        assert!(prompt.contains("none registered — no editor is connected"));
        // No CALICODE.md or skills/ folder: the skills slot falls back.
        assert!(prompt.contains("No CALICODE.md or skills/ found"));

        // A slug with no readable project still renders a full prompt.
        let prompt = default_system_prompt(&state, "missing", &[], &HashMap::new());
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
}
