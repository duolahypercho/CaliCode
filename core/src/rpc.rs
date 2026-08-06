use crate::agent::AgentOptions;
use crate::assets;
use crate::baselines;
use crate::image3d;
use crate::store;
use crate::tools::{model_list, model_switch, ToolDef};
use crate::AppState;
use anyhow::{Context, Result};
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

pub async fn rpc_handler(
    State(state): State<AppState>,
    Json(envelope): Json<Value>,
) -> Json<Value> {
    let id = envelope.get("id").cloned().unwrap_or(Value::Null);
    let method = envelope
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let params = envelope.get("params").cloned().unwrap_or_else(|| json!({}));
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
        "ping" => Ok(json!({ "pong": true, "version": "0.1.0" })),
        "config.read" => {
            let config = state.config.read().await;
            Ok(serde_json::to_value(&*config)?)
        }
        "model_list" => {
            let config = state.config.read().await;
            Ok(model_list(&*config)?)
        }
        "model_switch" => {
            let mut config = state.config.write().await;
            Ok(model_switch(
                &mut config,
                str_param(&params, "provider")?,
                str_param(&params, "model")?,
            )?)
        }
        "subagent_spawn" => crate::tools::spawn_subagent(state, &params).await,
        "project_create" => {
            let slug = str_param(&params, "slug")?;
            let title = params.get("title").and_then(|v| v.as_str()).unwrap_or(slug);
            Ok(store::create_project(&state.projects_root, slug, title)?)
        }
        "project_list" => Ok(store::list_projects(&state.projects_root)?),
        "project_open" => Ok(store::read_project(&state.projects_root, str_param(&params, "slug")?)?),
        "project_save" => {
            let project = params.get("project").context("project missing")?;
            store::validate_project(project)?;
            let slug = str_param(project, "slug")?;
            store::write_project(&state.projects_root, slug, project)?;
            Ok(json!({ "saved": true, "slug": slug }))
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
        "file_read" => {
            let slug = str_param(&params, "slug")?;
            let path = store::safe_join(&store::project_dir(&state.projects_root, slug)?, str_param(&params, "path")?)?;
            let content = std::fs::read_to_string(&path)?;
            Ok(json!({ "path": params["path"], "content": content }))
        }
        "file_write" => {
            let slug = str_param(&params, "slug")?;
            let path = store::safe_join(&store::project_dir(&state.projects_root, slug)?, str_param(&params, "path")?)?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, str_param(&params, "content")?)?;
            Ok(json!({ "path": params["path"], "written": true }))
        }
        "asset_import_file" => {
            let tags = params["tags"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>())
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
        "asset_list" => {
            let project = store::read_project(&state.projects_root, str_param(&params, "slug")?)?;
            Ok(project["assets"].clone())
        }
        "asset_files" => Ok(assets::list_files(&state.projects_root, str_param(&params, "slug")?)?),
        "asset_hash_dedupe" => Ok(assets::dedupe(&state.projects_root, str_param(&params, "slug")?)?),
        "asset_usage" => Ok(assets::usage(&state.projects_root, str_param(&params, "slug")?)?),
        "asset_export_gltf" => Ok(assets::export_gltf(
            &state.projects_root,
            str_param(&params, "slug")?,
            str_param(&params, "assetId")?,
        )?),
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
            params.get("threshold").and_then(|v| v.as_u64()).unwrap_or(8) as u32,
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
            Ok(image3d::generate(&state.projects_root, str_param(&params, "slug")?, spec)?)
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
            let mut tools = state.tools.write().await;
            if let Some(list) = params["tools"].as_array() {
                for item in list {
                    let def = ToolDef {
                        name: item["name"].as_str().unwrap_or_default().to_string(),
                        description: item["description"].as_str().unwrap_or_default().to_string(),
                        parameters: item.get("parameters").cloned().unwrap_or_else(|| json!({"type":"object"})),
                        kind: crate::tools::ToolKind::Browser,
                    };
                    if !def.name.is_empty() && def.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                        tools.insert(def.name.clone(), def);
                    }
                }
            }
            Ok(json!({ "registered": tools.len() }))
        }
        "tool_list" => {
            let tools = state.tools.read().await;
            let list: Vec<Value> = tools
                .values()
                .map(|t| json!({ "name": t.name, "description": t.description, "parameters": t.parameters, "kind": "browser" }))
                .collect();
            Ok(json!(list))
        }
        "agent_chat" => {
            let messages = params.get("messages").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let registered = state.tools.read().await.clone();
            let system = params
                .get("system")
                .and_then(|v| v.as_str())
                .map(String::from)
                .or_else(|| {
                    params.get("projectSlug").and_then(|v| v.as_str()).map(|slug| default_system_prompt(&state.projects_root, slug))
                });
            let options = AgentOptions {
                permission_mode: params.get("permissionMode").and_then(|v| v.as_str()).unwrap_or("full-access").to_string(),
                max_turns: params.get("maxTurns").and_then(|v| v.as_u64()).unwrap_or(8) as usize,
                system,
                project_slug: params.get("projectSlug").and_then(|v| v.as_str()).map(String::from),
            };
            let session_id = params.get("sessionId").and_then(|v| v.as_str());
            Ok(state.agents.chat(state, &registered, session_id, &messages, options).await?)
        }
        "agent_tool_result" => Ok(state.agents.submit_tool_result(
            str_param(&params, "sessionId")?,
            str_param(&params, "requestId")?,
            params.get("result").cloned().unwrap_or(Value::Null),
        ).await?),
        "agent_approval_response" => Ok(state.agents.submit_approval(
            str_param(&params, "sessionId")?,
            str_param(&params, "requestId")?,
            params.get("approved").and_then(|v| v.as_bool()).unwrap_or(false),
        ).await?),
        "agent_sessions" => Ok(json!(state.agents.sessions().await)),
        _ => anyhow::bail!("unknown method {}", method),
    }
}

fn default_system_prompt(projects_root: &std::path::Path, slug: &str) -> String {
    let project = store::read_project(projects_root, slug).ok();
    let context = project.unwrap_or_else(|| json!({ "entities": [], "assets": [], "tests": [] }));
    format!(
        "You are CaliCode, an AI game engine harness for a three.js editor.\n\
         You can inspect and edit the project, save and checkpoint work, import and export assets, \
         manage test baselines, run the image-to-3D pipeline, and switch models. When the project \
         needs a scene, asset, PIE, or visual change, call the browser tool and wait for its result.\n\
         Project context:\n{}",
        serde_json::to_string_pretty(&context).unwrap_or_default()
    )
}

fn str_param<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing required string {}", key))
}
