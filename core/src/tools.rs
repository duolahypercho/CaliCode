use crate::baselines;
use crate::image3d;
use crate::store;
use crate::AppState;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Where a game's file tools operate.
///
/// A game with a folder attached (`workspaceRoot`) reads and writes THAT
/// folder — that is the whole point of a game owning a workspace. Without one
/// the tools stay inside the CaliCode-owned project directory. Before this
/// split, `file_read` always resolved under `~/.cali/projects/<slug>`, so an
/// agent working on a real repo could not see a single one of its files.
struct GameFileBase {
    base: PathBuf,
    /// True when `base` is a user folder, which needs the workspace module's
    /// stricter resolution (symlink escapes, secret-file refusal).
    is_workspace: bool,
}

fn game_file_base(root: &Path, slug: &str) -> Result<GameFileBase> {
    let project = store::read_project(root, slug)?;
    let attached = project
        .get("workspaceRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir());
    match attached {
        Some(base) => Ok(GameFileBase {
            base,
            is_workspace: true,
        }),
        None => Ok(GameFileBase {
            base: store::project_dir(root, slug)?,
            is_workspace: false,
        }),
    }
}

fn resolve_in_base(base: &GameFileBase, rel: &str) -> Result<PathBuf> {
    if base.is_workspace {
        crate::workspace::safe_resolve(&base.base, rel)
    } else {
        store::safe_join(&base.base, rel)
    }
}

/// Resolve `rel` for a game, returning the base it resolved against so errors
/// can say which folder was searched.
///
/// Shared with the JSON-RPC handlers so the client and the agent always see the
/// same files — they had diverged, with each resolving its own way.
pub(crate) fn resolve_game_file(root: &Path, slug: &str, rel: &str) -> Result<(PathBuf, PathBuf)> {
    let base = game_file_base(root, slug)?;
    let path = resolve_in_base(&base, rel)?;
    Ok((base.base, path))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    #[serde(skip)]
    pub kind: ToolKind,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub enum ToolKind {
    #[default]
    Core,
    Browser,
}

pub fn core_tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "project_list".into(),
            description: "List saved CaliCode projects.".into(),
            parameters: json!({"type":"object","properties":{}}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "project_open".into(),
            description: "Open a project by slug and return its full JSON state.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "project_checkpoint".into(),
            description: "Snapshot a project before a risky edit so it can be reverted.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "project_revert".into(),
            description: "Revert a project to a previous checkpoint.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"checkpointId":{"type":"string"}},"required":["slug","checkpointId"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "file_read".into(),
            description: "Read a UTF-8 text file from the active game's folder (its attached workspace when it has one, otherwise the project).".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"path":{"type":"string"}},"required":["slug","path"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "file_write".into(),
            description: "Write UTF-8 text into the active game's folder (scripts, tests, docs).".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"path":{"type":"string"},"content":{"type":"string"}},"required":["slug","path","content"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "file_list".into(),
            description: "List files and folders in the active game's folder. Omit path for the root. Use this to explore before reading.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"path":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "asset_import_file".into(),
            description: "Import a file into the asset library as base64 data.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"name":{"type":"string"},"data":{"type":"string"},"mime":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}}},"required":["slug","name","data","mime"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "asset_hash_dedupe".into(),
            description: "Find duplicate asset files by SHA-256.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "asset_usage".into(),
            description: "Count entity references per asset.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "asset_export_gltf".into(),
            description: "Export an asset entry to a minimal glTF 2.0 file.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"assetId":{"type":"string"}},"required":["slug","assetId"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "test_baseline_save".into(),
            description: "Save a screenshot baseline for a named test.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"name":{"type":"string"},"image":{"type":"string"}},"required":["slug","name","image"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "test_baseline_compare".into(),
            description: "Compare a screenshot to a saved baseline with perceptual hashing.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"name":{"type":"string"},"image":{"type":"string"},"threshold":{"type":"number"}},"required":["slug","name","image"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "image3d_ingest".into(),
            description: "Admit a reference image into the Rust image-to-3D pipeline.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"name":{"type":"string"},"image":{"type":"string"}},"required":["slug","name","image"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "image3d_validate".into(),
            description: "Strictly validate an image3d spec before generation.".into(),
            parameters: json!({"type":"object","properties":{"spec":{"type":"object"}},"required":["spec"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "model_list".into(),
            description: "List configured model providers and the active model.".into(),
            parameters: json!({"type":"object","properties":{}}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "model_switch".into(),
            description: "Switch the active provider and model.".into(),
            parameters: json!({"type":"object","properties":{"provider":{"type":"string"},"model":{"type":"string"}},"required":["provider","model"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "subagent_spawn".into(),
            description: "Spawn a CaliCode subagent to complete a focused task; it can use the same scene, asset, PIE, and test tools.".to_string(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "role":{"type":"string","description":"Subagent role, e.g. planner, coder, tester, visual-critic"},
                    "instructions":{"type":"string"},
                    "maxTurns":{"type":"number"},
                    "projectSlug":{"type":"string"}
                },
                "required":["role","instructions"]
            }),
            kind: ToolKind::Core,
        },
    ]
}

pub fn to_openai_schema(def: &ToolDef) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": def.name,
            "description": def.description,
            "parameters": def.parameters
        }
    })
}

pub async fn execute_core_tool(
    tool: &ToolDef,
    args: &Value,
    state: &AppState,
    projects_root: &Path,
) -> Result<Value> {
    let root = projects_root;
    // Cloned, not held: this guard used to span the whole match including
    // spawn_subagent().await, which deadlocked against a concurrent
    // model_switch writer.
    let config = { state.config.read().await.clone() };
    match tool.name.as_str() {
        "project_list" => Ok(store::list_projects(root)?),
        "project_open" => Ok(store::read_project(root, required_str(args, "slug")?)?),
        "project_checkpoint" => Ok(store::checkpoint_project(
            root,
            required_str(args, "slug")?,
        )?),
        "project_revert" => Ok(store::revert_checkpoint(
            root,
            required_str(args, "slug")?,
            required_str(args, "checkpointId")?,
        )?),
        "file_read" => {
            let (base, path) =
                resolve_game_file(root, required_str(args, "slug")?, required_str(args, "path")?)?;
            let text = std::fs::read_to_string(&path).with_context(|| {
                format!(
                    "{} not found under {}",
                    required_str(args, "path").unwrap_or_default(),
                    base.display()
                )
            })?;
            Ok(json!({ "path": args["path"], "content": text }))
        }
        "file_write" => {
            let (_, path) =
                resolve_game_file(root, required_str(args, "slug")?, required_str(args, "path")?)?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, required_str(args, "content")?)?;
            Ok(json!({ "path": args["path"], "written": true }))
        }
        "file_list" => {
            let slug = required_str(args, "slug")?;
            let rel = args.get("path").and_then(Value::as_str).unwrap_or("");
            let base = game_file_base(root, slug)?;
            let dir = if rel.is_empty() {
                base.base.clone()
            } else {
                resolve_in_base(&base, rel)?
            };
            let mut entries: Vec<Value> = Vec::new();
            for entry in std::fs::read_dir(&dir)
                .with_context(|| format!("cannot list {}", dir.display()))?
                .flatten()
            {
                let name = entry.file_name().to_string_lossy().to_string();
                // Dotfiles are noise for an agent browsing a repo, and hiding
                // them also keeps .env-style secrets out of the listing.
                if name.starts_with('.') {
                    continue;
                }
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                entries.push(json!({
                    "name": name,
                    "kind": if is_dir { "dir" } else { "file" },
                }));
            }
            entries.sort_by(|a, b| {
                let key = |v: &Value| {
                    (
                        v["kind"].as_str() != Some("dir"),
                        v["name"].as_str().unwrap_or("").to_string(),
                    )
                };
                key(a).cmp(&key(b))
            });
            Ok(json!({ "path": rel, "root": base.base.display().to_string(), "entries": entries }))
        }
        "asset_import_file" => {
            let tags = args["tags"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Ok(crate::assets::import_file(
                root,
                required_str(args, "slug")?,
                required_str(args, "name")?,
                required_str(args, "data")?,
                required_str(args, "mime")?,
                tags,
            )?)
        }
        "asset_hash_dedupe" => Ok(crate::assets::dedupe(root, required_str(args, "slug")?)?),
        "asset_usage" => Ok(crate::assets::usage(root, required_str(args, "slug")?)?),
        "asset_export_gltf" => Ok(crate::assets::export_gltf(
            root,
            required_str(args, "slug")?,
            required_str(args, "assetId")?,
        )?),
        "test_baseline_save" => Ok(baselines::save_baseline(
            root,
            required_str(args, "slug")?,
            required_str(args, "name")?,
            required_str(args, "image")?,
        )?),
        "test_baseline_compare" => Ok(baselines::compare_baseline(
            root,
            required_str(args, "slug")?,
            required_str(args, "name")?,
            required_str(args, "image")?,
            args["threshold"].as_u64().unwrap_or(8) as u32,
        )?),
        "image3d_ingest" => Ok(image3d::ingest(
            root,
            required_str(args, "slug")?,
            required_str(args, "name")?,
            required_str(args, "image")?,
        )?),
        "image3d_validate" => Ok(image3d::validate_spec(&args["spec"])?),
        "model_list" => Ok(model_list(&config)?),
        "model_switch" => {
            drop(config);
            let mut config = state.config.write().await;
            model_switch(
                &mut config,
                required_str(args, "provider")?,
                required_str(args, "model")?,
            )
            .map_err(anyhow::Error::msg)
        }
        "subagent_spawn" => spawn_subagent(state, args).await,
        _ => anyhow::bail!("unknown core tool {}", tool.name),
    }
}

pub async fn spawn_subagent(state: &AppState, args: &Value) -> Result<Value> {
    let registered = state.tools.read().await.clone();
    let role = required_str(args, "role")?;
    let instructions = required_str(args, "instructions")?;
    let max_turns = args["maxTurns"].as_u64().unwrap_or(6) as usize;
    let slug = args
        .get("projectSlug")
        .and_then(|v| v.as_str())
        .map(String::from);
    let system = format!(
        "You are a {} subagent inside CaliCode, an AI game engine harness. \
         You have full access to the scene, asset workbench, PIE runtime, and test tools. \
         Work independently, call tools when they help, and finish with a concise report.",
        role
    );
    let options = crate::agent::AgentOptions {
        permission_mode: "full-access".into(),
        max_turns,
        system: Some(system),
        project_slug: slug,
    };
    let result = Box::pin(state.agents.chat(
        state,
        &registered,
        None,
        &[json!({ "role": "user", "content": instructions })],
        options,
    ))
    .await?;
    Ok(json!({
        "role": role,
        "sessionId": result["sessionId"],
        "reply": result["reply"],
        "toolCalls": result["toolCalls"],
        "turns": result["turns"]
    }))
}

pub fn model_list(config: &crate::config::AppConfig) -> Result<Value> {
    Ok(json!({
        "active": { "provider": config.model.provider, "model": config.model.default, "baseUrl": config.model.base_url },
        "providers": config.providers
    }))
}

pub fn model_switch(
    config: &mut crate::config::AppConfig,
    provider: &str,
    model: &str,
) -> Result<Value> {
    let preset = config
        .providers
        .iter()
        .find(|p| p.id == provider)
        .ok_or_else(|| anyhow::anyhow!("unknown provider {}", provider))?;
    config.model.provider = preset.id.clone();
    config.model.default = model.to_string();
    config.model.base_url = preset.base_url.clone();
    config.model.api_key_env = preset.api_key_env.clone();
    crate::config::save(config)?;
    model_list(config)
}

pub fn required_str<'a>(value: &'a Value, key: &'a str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing required string {}", key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::AgentManager;
    use crate::config::{AppConfig, ModelConfig};
    use axum::response::sse::{Event, Sse};
    use axum::routing::post;
    use axum::Router;
    use std::collections::HashMap;
    use std::convert::Infallible;

    async fn final_provider() -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        Sse::new(futures::stream::iter(vec![
            Ok(Event::default()
                .data(r#"{"choices":[{"delta":{"role":"assistant","content":"subagent done"}}]}"#)),
            Ok(Event::default().data("[DONE]")),
        ]))
    }

    #[tokio::test]
    async fn subagent_spawn_runs_focused_agent() {
        let app = Router::new().route("/v1/chat/completions", post(final_provider));
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
                max_tokens: Some(64),
            },
            providers: vec![],
            projects_dir: None,
            workspaces: Vec::new(),
        };
        let (bus, _) = tokio::sync::broadcast::channel(32);
        let agents = AgentManager::new(bus.clone());
        let state = crate::AppState {
            config: std::sync::Arc::new(tokio::sync::RwLock::new(config)),
            projects_root: tempfile::tempdir().unwrap().path().to_path_buf(),
            sessions_root: tempfile::tempdir().unwrap().path().to_path_buf(),
            agents: agents.clone(),
            bus: bus.clone(),
            workspaces: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::workspace::Registry::new(),
            )),
            dev_servers: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::devserver::Servers::new(),
            )),
            shutdown: std::sync::Arc::new(tokio::sync::watch::channel(false).0),
            tools: std::sync::Arc::new(tokio::sync::RwLock::new(HashMap::new())),
        };
        let def = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "subagent_spawn")
            .unwrap();
        let result = execute_core_tool(
            &def,
            &json!({ "role": "tester", "instructions": "Run the scene tests.", "maxTurns": 3, "projectSlug": "starter" }),
            &state,
            &state.projects_root,
        )
        .await
        .unwrap();
        assert_eq!(result["role"], "tester");
        assert!(result["reply"].as_str().unwrap().contains("subagent done"));
        assert!(result["sessionId"]
            .as_str()
            .unwrap()
            .starts_with("session-"));
    }

    #[test]
    fn file_tools_target_the_projects_dir_when_no_folder_is_attached() {
        let root = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();

        let base = game_file_base(root.path(), "demo").unwrap();
        assert!(!base.is_workspace);
        assert_eq!(base.base, store::project_dir(root.path(), "demo").unwrap());
    }

    #[test]
    fn file_tools_follow_the_game_to_its_attached_folder() {
        // The bug this covers: an agent working on a real repo read from
        // ~/.cali/projects/<slug> and got "No such file or directory" for
        // every file in the game's actual folder.
        let root = tempfile::tempdir().unwrap();
        let game_folder = tempfile::tempdir().unwrap();
        std::fs::write(game_folder.path().join("README.md"), "# real game").unwrap();

        store::create_project(root.path(), "demo", "Demo").unwrap();
        store::set_workspace_root(
            root.path(),
            "demo",
            Some(game_folder.path().to_str().unwrap()),
        )
        .unwrap();

        let base = game_file_base(root.path(), "demo").unwrap();
        assert!(base.is_workspace);

        let (_, resolved) = resolve_game_file(root.path(), "demo", "README.md").unwrap();
        assert_eq!(
            std::fs::read_to_string(resolved).unwrap(),
            "# real game"
        );
    }

    #[test]
    fn attached_folder_still_refuses_traversal_and_secrets() {
        let root = tempfile::tempdir().unwrap();
        let game_folder = tempfile::tempdir().unwrap();
        std::fs::write(game_folder.path().join(".env"), "SECRET=1").unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        store::set_workspace_root(
            root.path(),
            "demo",
            Some(game_folder.path().to_str().unwrap()),
        )
        .unwrap();

        assert!(resolve_game_file(root.path(), "demo", "../escape.txt").is_err());
        assert!(resolve_game_file(root.path(), "demo", "/etc/passwd").is_err());
        assert!(resolve_game_file(root.path(), "demo", ".env").is_err());
    }

    #[test]
    fn core_tool_names_are_reserved_and_unique() {
        // A browser tool registered under a core name emitted two functions
        // with the same name in the provider's tools array, which 400s every
        // agent_chat in every session until the core process restarts.
        let names: Vec<String> = core_tool_defs().into_iter().map(|t| t.name).collect();
        let unique: std::collections::HashSet<&String> = names.iter().collect();
        assert_eq!(
            names.len(),
            unique.len(),
            "core tool names must be unique: {names:?}"
        );
        for reserved in [
            "file_write",
            "model_switch",
            "subagent_spawn",
            "project_revert",
        ] {
            assert!(
                names.iter().any(|n| n == reserved),
                "{reserved} must be a core tool"
            );
        }
    }
}
