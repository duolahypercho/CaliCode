use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const SAMPLE_PROJECT: &str = r##"{
  "schemaVersion": 1,
  "slug": "starter",
  "title": "Caliber Starter",
  "entities": [
    {
      "id": "floor",
      "name": "Floor",
      "kind": "plane",
      "transform": { "position": [0, 0, 0], "rotation": [-1.5707963, 0, 0], "scale": [8, 8, 1] },
      "material": { "color": "#e7e0d6", "metalness": 0.05, "roughness": 0.9 },
      "light": {},
      "scriptIds": [],
      "assetId": null
    },
    {
      "id": "hero",
      "name": "Hero Cube",
      "kind": "box",
      "transform": { "position": [0, 0.6, 0], "rotation": [0, 0.7, 0], "scale": [1, 1, 1] },
      "material": { "color": "#f97316", "metalness": 0.2, "roughness": 0.45 },
      "light": {},
      "scriptIds": ["spin"],
      "assetId": "asset-cube"
    },
    {
      "id": "key",
      "name": "Key Light",
      "kind": "light",
      "transform": { "position": [4, 6, 4], "rotation": [0, 0, 0], "scale": [1, 1, 1] },
      "material": {},
      "light": { "type": "directional", "intensity": 2.2, "color": "#ffffff" },
      "scriptIds": [],
      "assetId": null
    }
  ],
  "scripts": [
    {
      "id": "spin",
      "name": "spin",
      "code": "function update(entity, state, delta) {\n  entity.rotation.y += delta * 0.8;\n  return state;\n}"
    }
  ],
  "assets": [
    {
      "id": "asset-cube",
      "name": "Caliber Cube",
      "type": "procedural",
      "source": "procedural:box",
      "tags": ["prop", "starter"],
      "usage": ["hero"],
      "thumbnail": null,
      "metadata": { "generator": "box" }
    }
  ],
  "tests": [
    {
      "id": "test-floor",
      "name": "Floor exists",
      "script": "assert(scene.entities.some(e => e.name === 'Floor'), 'Floor is missing');"
    },
    {
      "id": "test-hero",
      "name": "Hero moves",
      "script": "const before = entityFor('Hero Cube').rotation.y; await step(30); assert(Math.abs(entityFor('Hero Cube').rotation.y - before) > 0.1, 'Hero did not rotate');"
    }
  ],
  "settings": { "pie": { "captureEvery": 3, "fixedStepHz": 60 } }
}"##;

pub fn sanitize_slug(slug: &str) -> Result<String> {
    let clean: String = slug
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if clean.is_empty() {
        anyhow::bail!("invalid project slug")
    }
    Ok(clean)
}

pub fn project_dir(root: &Path, slug: &str) -> Result<PathBuf> {
    let clean = sanitize_slug(slug)?;
    Ok(root.join(clean))
}

pub fn project_file(root: &Path, slug: &str) -> Result<PathBuf> {
    Ok(project_dir(root, slug)?.join("project.json"))
}

pub fn read_project(root: &Path, slug: &str) -> Result<Value> {
    let path = project_file(root, slug)?;
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("project {} not found", slug))?;
    let value: Value = serde_json::from_str(&text)?;
    Ok(value)
}

pub fn write_project(root: &Path, slug: &str, project: &Value) -> Result<()> {
    let dir = project_dir(root, slug)?;
    std::fs::create_dir_all(dir.join("scripts"))?;
    std::fs::create_dir_all(dir.join("assets"))?;
    std::fs::create_dir_all(dir.join("tests"))?;
    std::fs::create_dir_all(dir.join("baselines"))?;
    std::fs::create_dir_all(dir.join("thumbnails"))?;
    std::fs::create_dir_all(dir.join("checkpoints"))?;
    let text = serde_json::to_string_pretty(project)?;
    std::fs::write(project_file(root, slug)?, text)?;
    Ok(())
}

pub fn create_project(root: &Path, slug: &str, title: &str) -> Result<Value> {
    let clean = sanitize_slug(slug)?;
    let mut project: Value = serde_json::from_str(SAMPLE_PROJECT)?;
    project["slug"] = json!(clean);
    project["title"] = json!(title);
    write_project(root, &clean, &project)?;
    Ok(project)
}

pub fn list_projects(root: &Path) -> Result<Value> {
    let mut projects = Vec::new();
    if root.exists() {
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                if let Ok(project) = read_project(root, &entry.file_name().to_string_lossy()) {
                    projects.push(project);
                }
            }
        }
    }
    Ok(json!(projects))
}

pub fn checkpoint_project(root: &Path, slug: &str) -> Result<Value> {
    let src = project_dir(root, slug)?;
    let stamp = chrono_stamp();
    let dest = src.join("checkpoints").join(&stamp);
    copy_dir(&src, &dest)?;
    Ok(json!({ "id": stamp, "path": dest.display().to_string() }))
}

pub fn revert_checkpoint(root: &Path, slug: &str, checkpoint_id: &str) -> Result<Value> {
    let clean = sanitize_slug(slug)?;
    if !checkpoint_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        anyhow::bail!("invalid checkpoint id");
    }
    let src = root.join(&clean).join("checkpoints").join(checkpoint_id);
    if !src.exists() {
        anyhow::bail!("checkpoint {} not found", checkpoint_id);
    }
    let dest = project_dir(root, &clean)?;
    for name in ["project.json", "scripts", "assets", "tests", "baselines", "thumbnails"] {
        let from = src.join(name);
        let to = dest.join(name);
        if from.is_dir() && to.exists() {
            std::fs::remove_dir_all(&to)?;
        }
        if from.exists() {
            copy_path(&from, &to)?;
        }
    }
    Ok(read_project(root, &clean)?)
}

pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel = rel.trim_start_matches('/');
    for component in Path::new(rel).components() {
        if matches!(component, std::path::Component::ParentDir) {
            anyhow::bail!("path escapes project root");
        }
    }
    let path = root.join(rel);
    if !path.starts_with(root) {
        anyhow::bail!("path escapes project root");
    }
    Ok(path)
}

fn copy_dir(src: &Path, dest: &Path) -> Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() && entry.file_name() != std::ffi::OsStr::new("checkpoints") {
            copy_dir(&from, &to)?;
        } else if from.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn copy_path(src: &Path, dest: &Path) -> Result<()> {
    if src.is_dir() {
        copy_dir(src, dest)
    } else {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(std::fs::copy(src, dest).map(|_| ())?)
    }
}

fn chrono_stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("cp-{}", now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_read_roundtrip() {
        let root = tempfile::tempdir().unwrap();
        let project = create_project(root.path(), "demo", "Demo").unwrap();
        assert_eq!(project["title"], "Demo");
        let loaded = read_project(root.path(), "demo").unwrap();
        assert_eq!(loaded["slug"], "demo");
    }

    #[test]
    fn checkpoint_and_revert() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let cp = checkpoint_project(root.path(), "demo").unwrap();
        let mut project = read_project(root.path(), "demo").unwrap();
        project["title"] = json!("Changed");
        write_project(root.path(), "demo", &project).unwrap();
        let reverted = revert_checkpoint(root.path(), "demo", cp["id"].as_str().unwrap()).unwrap();
        assert_eq!(reverted["title"], "Demo");
    }

    #[test]
    fn path_traversal_blocked() {
        let root = tempfile::tempdir().unwrap();
        assert!(safe_join(root.path(), "../outside").is_err());
    }
}
