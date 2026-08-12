use crate::store::project_dir;
use anyhow::{Context, Result};
#[allow(unused_imports)]
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

pub fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "model/gltf-binary" => "glb",
        "model/gltf+json" => "gltf",
        "text/plain" => "txt",
        "application/json" => "json",
        "model/obj" => "obj",
        _ => "bin",
    }
}

pub fn sha256_bytes(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let out = hasher.finalize();
    out.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let data = std::fs::read(path)?;
    Ok(sha256_bytes(&data))
}

pub fn import_file(
    root: &Path,
    slug: &str,
    name: &str,
    data_base64: &str,
    mime: &str,
    tags: Vec<String>,
) -> Result<Value> {
    let data = crate::baselines::decode_image_base64(data_base64).context("invalid base64")?;
    let hash = sha256_bytes(&data);
    let ext = extension_for(mime);
    let id = format!("asset-{}", short_id());
    let file_name = format!("{}.{}", id, ext);
    let dir = project_dir(root, slug)?.join("assets");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(&file_name), &data)?;
    let asset = json!({
        "id": id,
        "name": name,
        "type": asset_type(mime),
        "source": file_name,
        "tags": tags,
        "usage": [],
        "thumbnail": null,
        "metadata": { "sha256": hash, "mime": mime, "bytes": data.len() }
    });
    let mut project = crate::store::read_project(root, slug)?;
    project["assets"]
        .as_array_mut()
        .unwrap()
        .push(asset.clone());
    crate::store::write_project(root, slug, &project)?;
    Ok(asset)
}

pub fn asset_type(mime: &str) -> &'static str {
    match mime {
        "image/png" | "image/jpeg" | "image/jpg" => "image",
        "model/gltf-binary" | "model/gltf+json" => "gltf",
        "model/obj" => "obj",
        "application/json" => "cali",
        _ => "procedural",
    }
}

pub fn list_files(root: &Path, slug: &str) -> Result<Value> {
    let dir = project_dir(root, slug)?.join("assets");
    let mut items = Vec::new();
    if dir.exists() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            if entry.path().is_file() {
                let hash = sha256_file(&entry.path()).unwrap_or_default();
                items.push(json!({
                    "name": entry.file_name().to_string_lossy(),
                    "size": entry.metadata().map(|m| m.len()).unwrap_or(0),
                    "sha256": hash
                }));
            }
        }
    }
    Ok(json!(items))
}

pub fn dedupe(root: &Path, slug: &str) -> Result<Value> {
    let mut by_hash: std::collections::HashMap<String, Vec<String>> = Default::default();
    for item in list_files(root, slug)?
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        let hash = item["sha256"].as_str().unwrap_or_default().to_string();
        let name = item["name"].as_str().unwrap_or_default().to_string();
        by_hash.entry(hash).or_default().push(name);
    }
    let groups: Vec<Value> = by_hash
        .into_iter()
        .filter(|(_, names)| names.len() > 1)
        .map(|(hash, names)| json!({ "sha256": hash, "files": names }))
        .collect();
    Ok(json!(groups))
}

pub fn usage(root: &Path, slug: &str) -> Result<Value> {
    let project = crate::store::read_project(root, slug)?;
    let mut counts = serde_json::Map::new();
    if let Some(entities) = project["entities"].as_array() {
        for entity in entities {
            if let Some(asset_id) = entity["assetId"].as_str() {
                let entry = counts.entry(asset_id.to_string()).or_insert(json!(0));
                let next = entry.as_i64().unwrap_or(0) + 1;
                *entry = json!(next);
            }
        }
    }
    Ok(Value::Object(counts))
}

/// Write a builder-edited `.cali.json` spec back into the project's assets/.
///
/// The target is the asset entry's `source` from project.json when it ends in
/// `.cali.json`, otherwise `assets/<assetId>.cali.json`. Always resolves under
/// the CaliCode-owned project dir (never a workspace) and refuses anything
/// outside `assets/`.
pub fn write_project_asset(
    root: &Path,
    slug: &str,
    asset_id: &str,
    content: &str,
) -> Result<Value> {
    let project = crate::store::read_project(root, slug)?;
    let source = project["assets"]
        .as_array()
        .and_then(|arr| arr.iter().find(|a| a["id"] == asset_id))
        .and_then(|asset| asset["source"].as_str())
        .filter(|source| source.ends_with(".cali.json"))
        .map(str::to_string)
        .unwrap_or_else(|| format!("{asset_id}.cali.json"));
    let dir = project_dir(root, slug)?;
    let rel = format!("assets/{source}");
    let path = crate::store::safe_join(&dir, &rel)?;
    if !path.starts_with(dir.join("assets")) {
        anyhow::bail!("asset writes must stay inside assets/");
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, content).with_context(|| format!("cannot write {}", path.display()))?;
    Ok(json!({ "written": rel, "bytes": content.len() }))
}

fn short_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::create_project;

    #[test]
    fn import_and_dedupe() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let data = base64::engine::general_purpose::STANDARD.encode(b"hello-california");
        import_file(root.path(), "demo", "a", &data, "text/plain", vec![]).unwrap();
        import_file(root.path(), "demo", "b", &data, "text/plain", vec![]).unwrap();
        let dupes = dedupe(root.path(), "demo").unwrap();
        assert!(!dupes.as_array().unwrap().is_empty());
    }

    #[test]
    fn write_project_asset_targets_assets_dir_and_refuses_escapes() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let out =
            write_project_asset(root.path(), "demo", "widget", "{\"targetName\":\"W\"}").unwrap();
        assert_eq!(out["written"], "assets/widget.cali.json");
        let dir = project_dir(root.path(), "demo").unwrap();
        assert!(dir.join("assets/widget.cali.json").is_file());
        assert!(write_project_asset(root.path(), "demo", "../evil", "{}").is_err());
    }
}
