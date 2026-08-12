use crate::store::{project_dir, safe_join};
use anyhow::{Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

const BRIDGE_SOURCE: &str = include_str!("../blender/calicode_bridge.py");

pub fn import_asset(root: &Path, slug: &str, name: &str, data_base64: &str) -> Result<Value> {
    if !name.to_ascii_lowercase().ends_with(".blend") {
        anyhow::bail!("Blender source must be a .blend file");
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .context("invalid Blender file base64")?;
    if data.is_empty() {
        anyhow::bail!("Blender source is empty");
    }

    let id = format!("asset-{}", uuid::Uuid::new_v4().simple());
    let source = format!("blender/{id}/source.blend");
    let output = format!("blender/{id}/model.glb");
    let bridge = format!("blender/{id}/calicode_bridge.py");
    let display_name = Path::new(name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Blender asset");
    let project_root = project_dir(root, slug)?;
    let source_path = safe_join(&project_root, &format!("assets/{source}"))?;
    let bridge_path = safe_join(&project_root, &format!("assets/{bridge}"))?;
    std::fs::create_dir_all(
        source_path
            .parent()
            .context("Blender asset source has no parent directory")?,
    )?;
    std::fs::write(&source_path, data)?;
    std::fs::write(&bridge_path, BRIDGE_SOURCE)?;

    let asset = json!({
        "id": id,
        "name": display_name,
        "type": "gltf",
        "source": output,
        "tags": ["blender", "animated"],
        "usage": [],
        "thumbnail": null,
        "metadata": {
            "blender": {
                "source": source,
                "output": output,
                "bridge": bridge
            }
        }
    });
    let mut project = crate::store::read_project(root, slug)?;
    project["assets"]
        .as_array_mut()
        .context("project assets is not an array")?
        .push(asset.clone());
    crate::store::write_project(root, slug, &project)?;
    Ok(asset)
}

pub fn status(root: &Path, slug: &str, asset_id: &str) -> Result<Value> {
    let paths = asset_paths(root, slug, asset_id)?;
    let metadata = match std::fs::metadata(&paths.output) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({ "ready": false, "version": null, "bytes": 0 }));
        }
        Err(error) => return Err(error.into()),
    };
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(json!({
        "ready": true,
        "version": format!("{modified}-{}", metadata.len()),
        "bytes": metadata.len()
    }))
}

pub fn open(root: &Path, slug: &str, asset_id: &str) -> Result<Value> {
    let paths = asset_paths(root, slug, asset_id)?;
    std::fs::write(&paths.bridge, BRIDGE_SOURCE)?;
    let mut command = launch_command(&paths);
    command.stdout(Stdio::null()).stderr(Stdio::null());
    command.spawn().context(
        "failed to launch Blender; install Blender or set CALI_BLENDER_BIN to its executable",
    )?;
    Ok(json!({
        "opened": true,
        "assetId": asset_id,
        "source": paths.source,
        "output": paths.output
    }))
}

struct AssetPaths {
    source: PathBuf,
    output: PathBuf,
    bridge: PathBuf,
}

fn asset_paths(root: &Path, slug: &str, asset_id: &str) -> Result<AssetPaths> {
    let project = crate::store::read_project(root, slug)?;
    let asset = project["assets"]
        .as_array()
        .and_then(|assets| assets.iter().find(|asset| asset["id"] == asset_id))
        .with_context(|| format!("asset {asset_id} not found"))?;
    let blender = asset["metadata"]["blender"]
        .as_object()
        .context("asset is not backed by Blender")?;
    let rel = |key: &str| -> Result<&str> {
        blender
            .get(key)
            .and_then(Value::as_str)
            .with_context(|| format!("Blender asset is missing {key}"))
    };
    let project_root = project_dir(root, slug)?;
    let resolve = |path: &str| safe_join(&project_root, &format!("assets/{path}"));
    let source = resolve(rel("source")?)?;
    let output = resolve(rel("output")?)?;
    let bridge = resolve(rel("bridge")?)?;
    if source.extension().and_then(|value| value.to_str()) != Some("blend")
        || output.extension().and_then(|value| value.to_str()) != Some("glb")
        || bridge.extension().and_then(|value| value.to_str()) != Some("py")
    {
        anyhow::bail!("Blender asset paths have invalid extensions");
    }
    if !source.is_file() {
        anyhow::bail!("Blender source file is missing");
    }
    Ok(AssetPaths {
        source,
        output,
        bridge,
    })
}

fn launch_command(paths: &AssetPaths) -> Command {
    if let Some(binary) = std::env::var_os("CALI_BLENDER_BIN") {
        let mut command = Command::new(binary);
        add_blender_args(&mut command, paths);
        return command;
    }

    #[cfg(target_os = "macos")]
    {
        let bundled = Path::new("/Applications/Blender.app/Contents/MacOS/Blender");
        if bundled.is_file() {
            let mut command = Command::new(bundled);
            add_blender_args(&mut command, paths);
            return command;
        }
        let mut command = Command::new("open");
        command.args(["-na", "Blender", "--args"]);
        add_blender_args(&mut command, paths);
        command
    }

    #[cfg(not(target_os = "macos"))]
    {
        let mut command = Command::new("blender");
        add_blender_args(&mut command, paths);
        command
    }
}

fn add_blender_args(command: &mut Command, paths: &AssetPaths) {
    command
        .arg(&paths.source)
        .arg("--python")
        .arg(&paths.bridge)
        .arg("--")
        .arg(&paths.output);
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    #[test]
    fn import_registers_a_watched_gltf_asset() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();
        let asset = import_asset(
            root.path(),
            "demo",
            "runner.BLEND",
            &STANDARD.encode(b"BLENDER"),
        )
        .unwrap();
        assert_eq!(asset["type"], "gltf");
        assert_eq!(asset["name"], "runner");
        assert!(asset["source"].as_str().unwrap().ends_with("model.glb"));
        assert_eq!(
            asset["metadata"]["blender"]["source"]
                .as_str()
                .unwrap()
                .split('/')
                .next(),
            Some("blender")
        );
        let paths = asset_paths(root.path(), "demo", asset["id"].as_str().unwrap()).unwrap();
        assert_eq!(std::fs::read(paths.source).unwrap(), b"BLENDER");
        assert!(std::fs::read_to_string(paths.bridge)
            .unwrap()
            .contains("save_post"));
    }

    #[test]
    fn status_changes_when_blender_exports() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();
        let asset = import_asset(
            root.path(),
            "demo",
            "runner.blend",
            &STANDARD.encode(b"BLENDER"),
        )
        .unwrap();
        let id = asset["id"].as_str().unwrap();
        assert_eq!(status(root.path(), "demo", id).unwrap()["ready"], false);
        let paths = asset_paths(root.path(), "demo", id).unwrap();
        std::fs::write(paths.output, b"glTF").unwrap();
        let exported = status(root.path(), "demo", id).unwrap();
        assert_eq!(exported["ready"], true);
        assert_eq!(exported["bytes"], 4);
        assert!(exported["version"].as_str().unwrap().ends_with("-4"));
    }

    #[test]
    fn non_blend_imports_are_refused() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();
        assert!(import_asset(root.path(), "demo", "runner.glb", &STANDARD.encode(b"x")).is_err());
    }
}
