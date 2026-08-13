use crate::store::{project_dir, safe_join};
use anyhow::{Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, UNIX_EPOCH};
use tokio::process::Command as AsyncCommand;

const BRIDGE_SOURCE: &str = include_str!("../blender/calicode_bridge.py");
/// Blender pulls in a full Python runtime and can spend minutes on a heavy
/// rig, but an agent loop must not hang on it forever.
pub const DEFAULT_EXPORT_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_DIAGNOSTIC_LEN: usize = 600;

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

/// Headless, awaited GLB export.
///
/// `open` hands the .blend to a windowed Blender and returns immediately —
/// correct for a human, useless to an agent, which would report an asset that
/// does not exist yet. `--background` runs the bridge's immediate export and
/// exits, so the GLB is on disk before this returns. A clean exit that wrote no
/// GLB is still a failure: Blender reports script errors on stderr and exits 0.
pub async fn export(root: &Path, slug: &str, asset_id: &str, timeout: Duration) -> Result<Value> {
    let paths = asset_paths(root, slug, asset_id)?;
    std::fs::write(&paths.bridge, BRIDGE_SOURCE)?;
    let previous = modified_unix_seconds(&paths.output);

    let mut command = AsyncCommand::new(headless_binary());
    command
        .arg("--background")
        .arg(&paths.source)
        .arg("--python")
        .arg(&paths.bridge)
        .arg("--")
        .arg(&paths.output)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A timed-out export must not leave Blender running against the project.
        .kill_on_drop(true);

    let child = command.spawn().context(
        "failed to launch Blender; install Blender or set CALI_BLENDER_BIN to its executable",
    )?;
    let finished = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "Blender export timed out after {}s and was terminated",
                timeout.as_secs()
            )
        })?
        .context("failed to wait for Blender")?;

    if !finished.status.success() {
        anyhow::bail!(
            "Blender exited with {}: {}",
            finished.status,
            diagnostic_tail(&finished.stderr)
        );
    }
    if !paths.output.is_file() {
        anyhow::bail!(
            "Blender exited cleanly but wrote no GLB: {}",
            diagnostic_tail(&finished.stderr)
        );
    }

    let bytes = std::fs::metadata(&paths.output)
        .context("failed to stat the exported GLB")?
        .len();
    Ok(json!({
        "exported": true,
        "assetId": asset_id,
        "output": paths.output,
        "bytes": bytes,
        "refreshed": modified_unix_seconds(&paths.output) != previous,
    }))
}

/// Last few lines of Blender's stderr, bounded so a stack trace cannot flood
/// the model's context.
fn diagnostic_tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let tail = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" | ");
    if tail.is_empty() {
        return "no stderr output".into();
    }
    match tail.char_indices().nth(MAX_DIAGNOSTIC_LEN) {
        // Truncate on a char boundary; Blender stderr is lossy UTF-8 and a byte
        // slice through a multibyte sequence would panic.
        Some((boundary, _)) => format!("{}…", &tail[..boundary]),
        None => tail,
    }
}

fn modified_unix_seconds(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|delta| delta.as_secs())
}

/// Headless never resolves through macOS `open`: that detaches the process, so
/// there would be nothing to await or read an exit status from.
fn headless_binary() -> PathBuf {
    if let Some(binary) = std::env::var_os("CALI_BLENDER_BIN") {
        return PathBuf::from(binary);
    }
    #[cfg(target_os = "macos")]
    {
        let bundled = Path::new("/Applications/Blender.app/Contents/MacOS/Blender");
        if bundled.is_file() {
            return bundled.to_path_buf();
        }
    }
    PathBuf::from("blender")
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
    fn diagnostic_tail_keeps_the_last_lines_and_never_splits_a_char() {
        assert_eq!(diagnostic_tail(b""), "no stderr output");
        assert_eq!(diagnostic_tail(b"one\n\ntwo\nthree\n"), "one | two | three");
        // A multibyte tail longer than the cap must truncate on a char boundary
        // rather than panicking on a byte slice through a UTF-8 sequence.
        let wide = "\u{4e16}".repeat(MAX_DIAGNOSTIC_LEN + 40);
        let tail = diagnostic_tail(wide.as_bytes());
        assert!(tail.ends_with('…'));
        assert_eq!(tail.chars().count(), MAX_DIAGNOSTIC_LEN + 1);
    }

    #[tokio::test]
    async fn export_rejects_an_asset_that_is_not_blender_backed() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();
        // `asset-cube` is the procedural starter asset: no blender metadata, so
        // this must fail before Blender is ever launched.
        let error = export(
            root.path(),
            "demo",
            "asset-cube",
            std::time::Duration::from_secs(1),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("not backed by Blender"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn export_fails_when_the_blender_binary_is_missing() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();
        let asset = import_asset(
            root.path(),
            "demo",
            "runner.blend",
            &STANDARD.encode(b"BLENDER"),
        )
        .unwrap();
        let missing = root.path().join("no-such-blender");
        std::env::set_var("CALI_BLENDER_BIN", &missing);
        let result = export(
            root.path(),
            "demo",
            asset["id"].as_str().unwrap(),
            std::time::Duration::from_secs(5),
        )
        .await;
        std::env::remove_var("CALI_BLENDER_BIN");
        let error = result.unwrap_err().to_string();
        assert!(error.contains("failed to launch Blender"), "got: {error}");
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
