use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const SAMPLE_PROJECT: &str = r##"{
  "schemaVersion": 1,
  "slug": "starter",
  "title": "CaliCode Starter",
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
      "name": "CaliCode Cube",
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

const MAX_SLUG_LEN: usize = 64;

/// Validates a project slug. This rejects rather than filters on purpose:
/// silently stripping characters made distinct inputs collapse onto the same
/// project (`q@a#-p!r$o%b^e&-*1` and `QA-PROBE-1` both resolved to
/// `qa-probe-1`, so either could overwrite the other), and turned
/// `../../etc/passwd` into a real directory named `etcpasswd`.
pub fn sanitize_slug(slug: &str) -> Result<String> {
    if slug.is_empty() {
        anyhow::bail!("invalid project slug: empty");
    }
    if slug.len() > MAX_SLUG_LEN {
        anyhow::bail!("invalid project slug: longer than {MAX_SLUG_LEN} characters");
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        anyhow::bail!("invalid project slug: use lowercase letters, digits, '-' and '_' only");
    }
    Ok(slug.to_string())
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

/// Structural validation for an incoming project document.
///
/// `project_save` previously persisted whatever JSON it was handed, so a
/// payload with `entities: "not-an-array"` and `title: 42` was accepted and
/// written to disk — the three.js client then threw on load. `schemaVersion`
/// existed in the sample project but nothing ever read it.
pub fn validate_project(project: &Value) -> Result<()> {
    let object = project
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("project must be an object"))?;

    match object.get("schemaVersion").and_then(Value::as_u64) {
        Some(1) => {}
        Some(other) => anyhow::bail!("unsupported project schemaVersion {other}"),
        None => anyhow::bail!("project missing schemaVersion"),
    }

    let slug = object
        .get("slug")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("project missing slug"))?;
    sanitize_slug(slug)?;

    if !object.get("title").is_some_and(Value::is_string) {
        anyhow::bail!("project title must be a string");
    }
    if !object.get("settings").is_none_or(Value::is_object) {
        anyhow::bail!("project settings must be an object");
    }

    for collection in ["entities", "scripts", "assets", "tests"] {
        let items = object
            .get(collection)
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("project {collection} must be an array"))?;
        for (index, item) in items.iter().enumerate() {
            if !item.is_object() {
                anyhow::bail!("{collection}[{index}] must be an object");
            }
            if !item.get("id").is_some_and(Value::is_string) {
                anyhow::bail!("{collection}[{index}] missing string id");
            }
        }
    }
    Ok(())
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
    // Write via a temp file + rename. A plain write that is interrupted leaves
    // a truncated project.json, and list_projects silently drops projects it
    // cannot parse — so a crash mid-save made the project vanish from the UI
    // with no error anywhere.
    let final_path = project_file(root, slug)?;
    let temp_path = final_path.with_extension("json.tmp");
    std::fs::write(&temp_path, text)?;
    std::fs::rename(&temp_path, &final_path)?;
    Ok(())
}

pub fn create_project(root: &Path, slug: &str, title: &str) -> Result<Value> {
    let clean = sanitize_slug(slug)?;
    // Without this guard, re-creating an existing slug silently replaced the
    // user's work with the sample template.
    if project_file(root, &clean)?.exists() {
        anyhow::bail!("project {} already exists", clean);
    }
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
                let name = entry.file_name().to_string_lossy().to_string();
                match read_project(root, &name) {
                    Ok(project) => projects.push(project),
                    // A project whose file is missing simply isn't one. A
                    // project whose file exists but won't parse used to vanish
                    // from the list with no diagnostic at all — log it.
                    Err(error) if !path.join("project.json").exists() => {
                        tracing::debug!(project = %name, %error, "skipping non-project directory");
                    }
                    Err(error) => {
                        tracing::warn!(project = %name, %error, "project.json is unreadable");
                    }
                }
            }
        }
    }
    Ok(json!(projects))
}

pub fn checkpoint_project(root: &Path, slug: &str) -> Result<Value> {
    let src = project_dir(root, slug)?;
    // copy_dir's create_dir_all used to materialise the whole tree, so
    // checkpointing a project that did not exist returned success and left a
    // phantom directory behind.
    if !project_file(root, slug)?.exists() {
        anyhow::bail!("project {} not found", slug);
    }
    let checkpoints = src.join("checkpoints");
    // Millisecond stamps collided under concurrency and silently merged into
    // an existing snapshot directory, so a returned id could point at another
    // checkpoint's data. Suffix on collision instead.
    let stamp = chrono_stamp();
    let mut id = stamp.clone();
    for attempt in 1..1000 {
        if !checkpoints.join(&id).exists() {
            break;
        }
        id = format!("{stamp}-{attempt}");
    }
    let dest = checkpoints.join(&id);
    if dest.exists() {
        anyhow::bail!("unable to allocate a checkpoint id");
    }
    copy_dir(&src, &dest)?;
    // The absolute host path is deliberately not returned; it leaked the
    // filesystem layout to any caller.
    Ok(json!({ "id": id }))
}

/// Validates a checkpoint id.
///
/// `.` used to be an allowed character, which let `checkpointId: ".."` resolve
/// to the project directory itself. `revert_checkpoint` then ran
/// `remove_dir_all(&to)` followed by a copy where source == destination, so a
/// single unauthenticated request deleted `scripts/`, `assets/`, `tests/`,
/// `baselines/` and `thumbnails/` and truncated `project.json` to zero bytes.
fn validate_checkpoint_id(checkpoint_id: &str) -> Result<()> {
    if checkpoint_id.is_empty() || checkpoint_id.len() > MAX_SLUG_LEN {
        anyhow::bail!("invalid checkpoint id");
    }
    if !checkpoint_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        anyhow::bail!("invalid checkpoint id");
    }
    Ok(())
}

pub fn revert_checkpoint(root: &Path, slug: &str, checkpoint_id: &str) -> Result<Value> {
    let clean = sanitize_slug(slug)?;
    validate_checkpoint_id(checkpoint_id)?;
    let src = root.join(&clean).join("checkpoints").join(checkpoint_id);
    if !src.exists() {
        anyhow::bail!("checkpoint {} not found", checkpoint_id);
    }
    let dest = project_dir(root, &clean)?;
    // Belt and braces: even with a validated id, never let a restore delete
    // its own source.
    if src == dest {
        anyhow::bail!("invalid checkpoint id");
    }
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
    if rel.is_empty() || rel.contains('\0') {
        anyhow::bail!("invalid path");
    }
    for component in Path::new(rel).components() {
        match component {
            std::path::Component::ParentDir => anyhow::bail!("path escapes project root"),
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                anyhow::bail!("path escapes project root")
            }
            _ => {}
        }
    }
    let path = root.join(rel);
    if !path.starts_with(root) {
        anyhow::bail!("path escapes project root");
    }
    // The lexical check above cannot see symlinks. Agent tools and asset
    // imports both write into the project directory, so a link planted there
    // would otherwise be followed straight out of the root. Canonicalize the
    // deepest existing ancestor (the leaf may legitimately not exist yet on a
    // write) and re-check containment against the real path.
    let root_real = root
        .canonicalize()
        .with_context(|| format!("project root {} is unavailable", root.display()))?;
    let mut probe = path.as_path();
    let resolved = loop {
        match probe.canonicalize() {
            Ok(real) => break real,
            Err(_) => match probe.parent() {
                Some(parent) => probe = parent,
                None => anyhow::bail!("path escapes project root"),
            },
        }
    };
    if !resolved.starts_with(&root_real) {
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

    #[test]
    fn revert_rejects_a_parent_dir_checkpoint_id() {
        // `checkpointId: ".."` resolved to the project directory itself, and
        // the restore then remove_dir_all'd its own source: scripts/, assets/,
        // tests/, baselines/ and thumbnails/ were deleted and project.json was
        // truncated to zero bytes by a copy onto itself.
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let dir = project_dir(root.path(), "demo").unwrap();

        for id in ["..", ".", "../..", "a/../.."] {
            assert!(
                revert_checkpoint(root.path(), "demo", id).is_err(),
                "checkpoint id {id:?} must be rejected"
            );
        }

        for name in ["scripts", "assets", "tests", "baselines", "thumbnails"] {
            assert!(dir.join(name).is_dir(), "{name} must survive a rejected revert");
        }
        assert!(std::fs::metadata(dir.join("project.json")).unwrap().len() > 0);
    }

    #[test]
    fn slugs_are_rejected_not_filtered() {
        // Filtering made distinct inputs collapse onto one project, so any of
        // these could silently overwrite `qa-probe-1`.
        assert!(sanitize_slug("qa-probe-1").is_ok());
        assert!(sanitize_slug("QA-PROBE-1").is_err());
        assert!(sanitize_slug("q@a#-p!r$o%b^e&-*1").is_err());
        assert!(sanitize_slug("../../etc/passwd").is_err());
        assert!(sanitize_slug("").is_err());
        assert!(sanitize_slug(&"a".repeat(65)).is_err());
    }

    #[test]
    fn create_project_refuses_to_clobber() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let mut saved: Value = read_project(root.path(), "demo").unwrap();
        saved["title"] = json!("User Work");
        write_project(root.path(), "demo", &saved).unwrap();

        assert!(create_project(root.path(), "demo", "Recreated").is_err());
        assert_eq!(read_project(root.path(), "demo").unwrap()["title"], "User Work");
    }

    #[test]
    fn checkpoint_requires_an_existing_project() {
        let root = tempfile::tempdir().unwrap();
        assert!(checkpoint_project(root.path(), "totally-absent").is_err());
        assert!(
            !root.path().join("totally-absent").exists(),
            "a failed checkpoint must not leave a phantom project directory"
        );
    }

    #[test]
    fn checkpoint_ids_do_not_collide() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let mut ids = std::collections::HashSet::new();
        for _ in 0..12 {
            let result = checkpoint_project(root.path(), "demo").unwrap();
            let id = result["id"].as_str().unwrap().to_string();
            assert!(ids.insert(id.clone()), "duplicate checkpoint id {id}");
        }
        let dir = project_dir(root.path(), "demo").unwrap().join("checkpoints");
        let on_disk = std::fs::read_dir(dir).unwrap().count();
        assert_eq!(on_disk, 12, "every returned id must exist on disk");
    }

    #[test]
    fn checkpoint_response_hides_the_host_path() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let result = checkpoint_project(root.path(), "demo").unwrap();
        assert!(result.get("path").is_none(), "absolute host path must not be returned");
    }

    #[test]
    fn validate_project_rejects_malformed_documents() {
        let good: Value = serde_json::from_str(SAMPLE_PROJECT).unwrap();
        assert!(validate_project(&good).is_ok());

        // Previously persisted verbatim, then threw in the three.js client.
        let mut bad = good.clone();
        bad["entities"] = json!("not-an-array");
        assert!(validate_project(&bad).is_err());

        let mut bad = good.clone();
        bad["title"] = json!(42);
        assert!(validate_project(&bad).is_err());

        let mut bad = good.clone();
        bad.as_object_mut().unwrap().remove("schemaVersion");
        assert!(validate_project(&bad).is_err());

        let mut bad = good.clone();
        bad["schemaVersion"] = json!(99);
        assert!(validate_project(&bad).is_err());

        let mut bad = good.clone();
        bad["entities"] = json!([{ "name": "no id" }]);
        assert!(validate_project(&bad).is_err());

        assert!(validate_project(&json!("a string")).is_err());
    }

    #[test]
    fn safe_join_does_not_follow_symlinks_out_of_the_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
        #[cfg(not(unix))]
        return;

        assert!(
            safe_join(root.path(), "escape/secret.txt").is_err(),
            "a symlink planted inside the project must not escape it"
        );
    }

    #[test]
    fn write_project_is_atomic() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let project: Value = read_project(root.path(), "demo").unwrap();
        write_project(root.path(), "demo", &project).unwrap();

        let dir = project_dir(root.path(), "demo").unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files must be renamed, not left behind");
    }
}
