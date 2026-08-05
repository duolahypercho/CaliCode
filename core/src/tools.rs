use crate::baselines;
use crate::image3d;
use crate::store;
use crate::AppState;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

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
            name: "project.list".into(),
            description: "List saved Cali projects.".into(),
            parameters: json!({"type":"object","properties":{}}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "project.open".into(),
            description: "Open a project by slug and return its full JSON state.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "project.checkpoint".into(),
            description: "Snapshot a project before a risky edit so it can be reverted.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "project.revert".into(),
            description: "Revert a project to a previous checkpoint.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"checkpointId":{"type":"string"}},"required":["slug","checkpointId"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "file.read".into(),
            description: "Read a UTF-8 text file inside the active project.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"path":{"type":"string"}},"required":["slug","path"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "file.write".into(),
            description: "Write UTF-8 text inside the active project (scripts, tests, docs).".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"path":{"type":"string"},"content":{"type":"string"}},"required":["slug","path","content"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "asset.import_file".into(),
            description: "Import a file into the asset library as base64 data.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"name":{"type":"string"},"data":{"type":"string"},"mime":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}}},"required":["slug","name","data","mime"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "asset.hash_dedupe".into(),
            description: "Find duplicate asset files by SHA-256.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "asset.usage".into(),
            description: "Count entity references per asset.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "asset.export_gltf".into(),
            description: "Export an asset entry to a minimal glTF 2.0 file.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"assetId":{"type":"string"}},"required":["slug","assetId"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "test.baseline.save".into(),
            description: "Save a screenshot baseline for a named test.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"name":{"type":"string"},"image":{"type":"string"}},"required":["slug","name","image"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "test.baseline.compare".into(),
            description: "Compare a screenshot to a saved baseline with perceptual hashing.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"name":{"type":"string"},"image":{"type":"string"},"threshold":{"type":"number"}},"required":["slug","name","image"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "image3d.ingest".into(),
            description: "Admit a reference image into the Rust image-to-3D pipeline.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"name":{"type":"string"},"image":{"type":"string"}},"required":["slug","name","image"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "image3d.validate".into(),
            description: "Strictly validate an image3d spec before generation.".into(),
            parameters: json!({"type":"object","properties":{"spec":{"type":"object"}},"required":["spec"]}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "model.list".into(),
            description: "List configured model providers and the active model.".into(),
            parameters: json!({"type":"object","properties":{}}),
            kind: ToolKind::Core,
        },
        ToolDef {
            name: "model.switch".into(),
            description: "Switch the active provider and model.".into(),
            parameters: json!({"type":"object","properties":{"provider":{"type":"string"},"model":{"type":"string"}},"required":["provider","model"]}),
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
    let config = state.config.read().await;
    match tool.name.as_str() {
        "project.list" => Ok(store::list_projects(root)?),
        "project.open" => Ok(store::read_project(root, required_str(args, "slug")?)?),
        "project.checkpoint" => Ok(store::checkpoint_project(root, required_str(args, "slug")?)?),
        "project.revert" => Ok(store::revert_checkpoint(
            root,
            required_str(args, "slug")?,
            required_str(args, "checkpointId")?,
        )?),
        "file.read" => {
            let path = store::safe_join(&store::project_dir(root, required_str(args, "slug")?)?, required_str(args, "path")?)?;
            let text = std::fs::read_to_string(&path)?;
            Ok(json!({ "path": args["path"], "content": text }))
        }
        "file.write" => {
            let dir = store::project_dir(root, required_str(args, "slug")?)?;
            let path = store::safe_join(&dir, required_str(args, "path")?)?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, required_str(args, "content")?)?;
            Ok(json!({ "path": args["path"], "written": true }))
        }
        "asset.import_file" => {
            let tags = args["tags"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>()).unwrap_or_default();
            Ok(crate::assets::import_file(
                root,
                required_str(args, "slug")?,
                required_str(args, "name")?,
                required_str(args, "data")?,
                required_str(args, "mime")?,
                tags,
            )?)
        }
        "asset.hash_dedupe" => Ok(crate::assets::dedupe(root, required_str(args, "slug")?)?),
        "asset.usage" => Ok(crate::assets::usage(root, required_str(args, "slug")?)?),
        "asset.export_gltf" => Ok(crate::assets::export_gltf(
            root,
            required_str(args, "slug")?,
            required_str(args, "assetId")?,
        )?),
        "test.baseline.save" => Ok(baselines::save_baseline(
            root,
            required_str(args, "slug")?,
            required_str(args, "name")?,
            required_str(args, "image")?,
        )?),
        "test.baseline.compare" => Ok(baselines::compare_baseline(
            root,
            required_str(args, "slug")?,
            required_str(args, "name")?,
            required_str(args, "image")?,
            args["threshold"].as_u64().unwrap_or(8) as u32,
        )?),
        "image3d.ingest" => Ok(image3d::ingest(
            root,
            required_str(args, "slug")?,
            required_str(args, "name")?,
            required_str(args, "image")?,
        )?),
        "image3d.validate" => Ok(image3d::validate_spec(&args["spec"])?),
        "model.list" => Ok(model_list(&*config)?),
        "model.switch" => {
            drop(config);
            let mut config = state.config.write().await;
            model_switch(&mut config, required_str(args, "provider")?, required_str(args, "model")?)
                .map_err(anyhow::Error::msg)
        }
        _ => anyhow::bail!("unknown core tool {}", tool.name),
    }
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
