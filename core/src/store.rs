use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

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
      "name": "Playable surface exists",
      "script": "await assert(scene.entities.some(e => e.kind === 'plane'), 'Playable surface exists');"
    },
    {
      "id": "test-hero",
      "name": "Hero moves",
      "script": "const before = entityFor('Hero Cube').rotation.y; await step(30); await assert(Math.abs(entityFor('Hero Cube').rotation.y - before) > 0.1, 'Hero moves during PIE');"
    }
  ],
  "settings": { "pie": { "captureEvery": 3, "fixedStepHz": 60 } }
}"##;

pub const DEFAULT_PROJECT_TEMPLATE: &str = "starter";

const BLANK_PROJECT: &str = r##"{
  "schemaVersion": 1,
  "slug": "blank",
  "title": "Blank Scene",
  "entities": [],
  "scripts": [],
  "assets": [],
  "tests": [],
  "settings": { "pie": { "captureEvery": 3, "fixedStepHz": 60 } }
}"##;

const SHOWCASE_PROJECT: &str = r##"{
  "schemaVersion": 1,
  "slug": "showcase",
  "title": "Showcase Scene",
  "entities": [
    {
      "id": "floor",
      "name": "Gallery Floor",
      "kind": "plane",
      "transform": { "position": [0, 0, 0], "rotation": [-1.5707963, 0, 0], "scale": [8, 8, 1] },
      "material": { "color": "#d8d4cc", "metalness": 0.05, "roughness": 0.92 },
      "light": {},
      "scriptIds": [],
      "assetId": null
    },
    {
      "id": "pedestal",
      "name": "Pedestal",
      "kind": "cylinder",
      "transform": { "position": [0, 0.3, 0], "rotation": [0, 0, 0], "scale": [2.2, 0.6, 2.2] },
      "material": { "color": "#3f3f46", "metalness": 0.35, "roughness": 0.5 },
      "light": {},
      "scriptIds": [],
      "assetId": null
    },
    {
      "id": "subject",
      "name": "Showcase Subject",
      "kind": "sphere",
      "transform": { "position": [0, 1.45, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1] },
      "material": { "color": "#fb923c", "metalness": 0.25, "roughness": 0.35 },
      "light": {},
      "scriptIds": ["turntable"],
      "assetId": "asset-subject"
    },
    {
      "id": "key",
      "name": "Gallery Light",
      "kind": "light",
      "transform": { "position": [4, 6, 5], "rotation": [0, 0, 0], "scale": [1, 1, 1] },
      "material": {},
      "light": { "type": "directional", "intensity": 2.5, "color": "#fff7ed" },
      "scriptIds": [],
      "assetId": null
    }
  ],
  "scripts": [
    {
      "id": "turntable",
      "name": "turntable",
      "code": "function update(entity, state, delta) {\n  entity.rotation.y += delta * 0.6;\n  return state;\n}"
    }
  ],
  "assets": [
    {
      "id": "asset-subject",
      "name": "Showcase Sphere",
      "type": "procedural",
      "source": "procedural:sphere",
      "tags": ["subject", "showcase"],
      "usage": ["subject"],
      "thumbnail": null,
      "metadata": { "generator": "sphere", "radius": 0.75, "segments": 32 }
    }
  ],
  "tests": [
    {
      "id": "test-pedestal",
      "name": "Pedestal exists",
      "script": "assert(scene.entities.some(e => e.name === 'Pedestal'), 'Pedestal is missing');"
    },
    {
      "id": "test-subject",
      "name": "Subject turns",
      "script": "const before = entityFor('Showcase Subject').rotation.y; await step(30); assert(Math.abs(entityFor('Showcase Subject').rotation.y - before) > 0.1, 'Showcase subject did not turn');"
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
    let text =
        std::fs::read_to_string(&path).with_context(|| format!("project {} not found", slug))?;
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
    // Each game owns its own folder on disk, so the workspace follows the
    // project instead of being a single global attachment. Absent or null
    // means "no folder attached yet".
    if !object
        .get("workspaceRoot")
        .is_none_or(|value| value.is_null() || value.is_string())
    {
        anyhow::bail!("project workspaceRoot must be a string or null");
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
    create_project_from_template(root, slug, title, DEFAULT_PROJECT_TEMPLATE)
}

pub fn create_project_from_template(
    root: &Path,
    slug: &str,
    title: &str,
    template_id: &str,
) -> Result<Value> {
    let clean = sanitize_slug(slug)?;
    // Without this guard, re-creating an existing slug silently replaced the
    // user's work with the sample template.
    if project_file(root, &clean)?.exists() {
        anyhow::bail!("project {} already exists", clean);
    }
    let template = match template_id {
        "blank" => BLANK_PROJECT,
        "starter" => SAMPLE_PROJECT,
        "showcase" => SHOWCASE_PROJECT,
        _ => anyhow::bail!("unknown project template {template_id}"),
    };
    let mut project: Value = serde_json::from_str(template)?;
    project["slug"] = json!(clean);
    project["title"] = json!(title);
    write_project(root, &clean, &project)?;
    Ok(project)
}

/// Bind a game to its own folder on disk. Passing `None` detaches it.
///
/// Done here rather than as a client read-modify-write so two rapid folder
/// changes cannot interleave and lose one — the read, mutate, and write happen
/// under one call.
pub fn set_workspace_root(root: &Path, slug: &str, workspace_root: Option<&str>) -> Result<Value> {
    let mut project = read_project(root, slug)?;
    let object = project
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("project must be an object"))?;
    match workspace_root {
        Some(path) if !path.trim().is_empty() => {
            object.insert("workspaceRoot".into(), Value::String(path.to_string()));
        }
        _ => {
            object.insert("workspaceRoot".into(), Value::Null);
        }
    }
    validate_project(&project)?;
    write_project(root, slug, &project)?;
    Ok(project)
}

/// Update the display name without replacing any other project data.
pub fn rename_project(root: &Path, slug: &str, title: &str) -> Result<Value> {
    let title = title.trim();
    if title.is_empty() {
        anyhow::bail!("project title cannot be empty");
    }
    if title.chars().count() > 120 {
        anyhow::bail!("project title cannot exceed 120 characters");
    }
    let mut project = read_project(root, slug)?;
    project["title"] = json!(title);
    validate_project(&project)?;
    write_project(root, slug, &project)?;
    Ok(project)
}

/// The folder Finder should reveal for a project: its attached workspace when
/// present, otherwise CaliCode's own project directory.
pub fn project_location(root: &Path, slug: &str) -> Result<PathBuf> {
    let project = read_project(root, slug)?;
    if let Some(path) = project.get("workspaceRoot").and_then(Value::as_str) {
        let workspace = PathBuf::from(path);
        if workspace.exists() {
            return Ok(workspace);
        }
    }
    project_dir(root, slug)
}

/// Create a durable git worktree next to the projects directory, then attach
/// the project to it. The default layout is `~/.cali/worktrees/<slug>`.
pub fn create_permanent_worktree(root: &Path, slug: &str) -> Result<Value> {
    let project = read_project(root, slug)?;
    let source = project
        .get("workspaceRoot")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .context("attach a git folder before creating a permanent worktree")?;
    let source_path = Path::new(source);
    if !source_path.is_dir() {
        anyhow::bail!("attached folder {} is unavailable", source_path.display());
    }

    let repo_text = git_stdout(source_path, &["rev-parse", "--show-toplevel"])
        .context("attached folder is not inside a git repository")?;
    let repo = PathBuf::from(repo_text.trim());
    let worktrees_root = root.parent().unwrap_or(root).join("worktrees");
    std::fs::create_dir_all(&worktrees_root)?;
    let destination = worktrees_root.join(sanitize_slug(slug)?);
    let branch = format!("calicode/{slug}");

    let created = if destination.exists() {
        let existing = git_stdout(&destination, &["rev-parse", "--show-toplevel"]).context(
            "the permanent worktree destination already exists and is not a git worktree",
        )?;
        let existing_root = PathBuf::from(existing.trim()).canonicalize()?;
        if existing_root != destination.canonicalize()? {
            anyhow::bail!("the permanent worktree destination belongs to another repository");
        }
        false
    } else {
        let branch_exists = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["show-ref", "--verify", "--quiet"])
            .arg(format!("refs/heads/{branch}"))
            .status()
            .context("failed to inspect git branches")?
            .success();

        let mut command = Command::new("git");
        command.arg("-C").arg(&repo).arg("worktree").arg("add");
        if branch_exists {
            command.arg(&destination).arg(&branch);
        } else {
            command.arg("-b").arg(&branch);
            command.arg(&destination);
        }
        let output = command.output().context("failed to run git worktree add")?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            anyhow::bail!("could not create permanent worktree: {detail}");
        }
        true
    };

    let path = destination.to_string_lossy().to_string();
    let project = set_workspace_root(root, slug, Some(&path))?;
    Ok(json!({
        "project": project,
        "path": path,
        "branch": branch,
        "created": created,
    }))
}

/// Create an isolated worktree for one session without changing the project's
/// default workspace. Non-git folders remain valid session workspaces; they
/// are shared because git has no isolation primitive to offer there.
pub fn create_session_workspace(root: &Path, slug: &str, session_id: &str) -> Result<Value> {
    let project = read_project(root, slug)?;
    let source = project
        .get("workspaceRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or(project_dir(root, slug)?);
    if !source.is_dir() {
        anyhow::bail!("workspace {} is unavailable", source.display());
    }

    let Ok(repo_text) = git_stdout(&source, &["rev-parse", "--show-toplevel"]) else {
        return Ok(json!({
            "path": source.to_string_lossy(),
            "worktreeId": Value::Null,
            "branch": Value::Null,
            "created": false,
            "isolated": false,
        }));
    };
    let repo = PathBuf::from(repo_text.trim());
    if git_stdout(&source, &["rev-parse", "--verify", "HEAD"]).is_err() {
        return Ok(json!({
            "path": source.to_string_lossy(),
            "worktreeId": Value::Null,
            "branch": Value::Null,
            "created": false,
            "isolated": false,
        }));
    }
    let suffix: String = session_id
        .trim_start_matches("session-")
        .chars()
        .take(12)
        .collect();
    if suffix.is_empty() || !suffix.chars().all(|c| c.is_ascii_alphanumeric()) {
        anyhow::bail!("invalid session id");
    }
    let worktree_id = format!("{slug}-{suffix}");
    let destination = root
        .parent()
        .unwrap_or(root)
        .join("worktrees")
        .join(sanitize_slug(slug)?)
        .join(&suffix);
    let branch = format!("calicode/{slug}/{suffix}");
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let created = if destination.exists() {
        let existing = git_stdout(&destination, &["rev-parse", "--show-toplevel"])
            .context("session worktree destination is not a git worktree")?;
        if PathBuf::from(existing.trim()).canonicalize()? != destination.canonicalize()? {
            anyhow::bail!("session worktree destination belongs to another repository");
        }
        false
    } else {
        let output = match Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["worktree", "add", "-b"])
            .arg(&branch)
            .arg(&destination)
            .output()
        {
            Ok(output) => output,
            Err(error) => {
                prune_empty_session_dirs(&destination);
                return Err(error).context("failed to run git worktree add");
            }
        };
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            // `create_dir_all` above is required for git's destination
            // parent, but a failed add must not leave a chain of empty
            // session directories behind. `remove_dir` is intentionally
            // non-recursive: any partial checkout or user file is preserved.
            prune_empty_session_dirs(&destination);
            anyhow::bail!("could not create session worktree: {detail}");
        }
        true
    };

    Ok(json!({
        "path": destination.to_string_lossy(),
        "worktreeId": worktree_id,
        "branch": branch,
        "created": created,
        "isolated": true,
    }))
}

fn prune_empty_session_dirs(destination: &Path) {
    let Some(project_root) = destination.parent() else {
        return;
    };
    let _ = std::fs::remove_dir(destination);
    let _ = std::fs::remove_dir(project_root);
    if let Some(worktrees_root) = project_root.parent() {
        let _ = std::fs::remove_dir(worktrees_root);
    }
}

/// Remove a session-owned worktree without touching a shared or permanent
/// workspace.
///
/// Session worktrees are intentionally disposable, but the path and branch
/// are persisted in a user-editable session JSON file. Treat that metadata as
/// untrusted: only the exact `worktrees/<slug>/<suffix>` layout produced by
/// [`create_session_workspace`] is eligible. A dirty worktree is preserved so
/// deleting a chat can never discard edits or untracked files the user may
/// want to recover.
pub fn cleanup_session_workspace(
    root: &Path,
    slug: &str,
    workspace_root: Option<&str>,
    worktree_id: Option<&str>,
    branch: Option<&str>,
) -> Result<Value> {
    let clean_slug = sanitize_slug(slug)?;
    let Some(workspace_root) = workspace_root
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return Ok(json!({
            "deleted": false,
            "isolated": false,
            "preserved": false,
            "reason": "session has no workspace",
        }));
    };
    let Some(worktree_id) = worktree_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(json!({
            "path": workspace_root,
            "deleted": false,
            "isolated": false,
            "preserved": false,
            "reason": "workspace is shared",
        }));
    };

    let prefix = format!("{clean_slug}-");
    let Some(suffix) = worktree_id.strip_prefix(&prefix) else {
        return Ok(json!({
            "path": workspace_root,
            "deleted": false,
            "isolated": true,
            "preserved": true,
            "reason": "worktree id does not match the project",
        }));
    };
    if suffix.is_empty() || !suffix.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Ok(json!({
            "path": workspace_root,
            "deleted": false,
            "isolated": true,
            "preserved": true,
            "reason": "invalid session worktree id",
        }));
    }
    let expected_branch = format!("calicode/{clean_slug}/{suffix}");
    if branch
        .map(str::trim)
        .is_some_and(|value| value != expected_branch)
    {
        return Ok(json!({
            "path": workspace_root,
            "deleted": false,
            "isolated": true,
            "preserved": true,
            "reason": "session branch does not match the project",
        }));
    }

    let expected = root
        .parent()
        .unwrap_or(root)
        .join("worktrees")
        .join(&clean_slug)
        .join(suffix);
    let requested = PathBuf::from(workspace_root);
    let expected_cmp = expected.canonicalize().unwrap_or_else(|_| expected.clone());
    let requested_cmp = requested
        .canonicalize()
        .unwrap_or_else(|_| requested.clone());
    if requested_cmp != expected_cmp {
        return Ok(json!({
            "path": workspace_root,
            "deleted": false,
            "isolated": true,
            "preserved": true,
            "reason": "workspace path is outside the session worktree root",
        }));
    }

    let metadata = match std::fs::symlink_metadata(&requested) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({
                "path": workspace_root,
                "deleted": false,
                "isolated": true,
                "preserved": false,
                "reason": "worktree is already absent",
            }));
        }
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Ok(json!({
            "path": workspace_root,
            "deleted": false,
            "isolated": true,
            "preserved": true,
            "reason": "worktree path is not a real directory",
        }));
    }

    // Refuse to remove user edits. This includes untracked files: a model may
    // have generated a new asset that is not committed yet, and `git
    // worktree remove --force` would destroy it with no recovery path.
    let status = git_stdout(
        &requested,
        &["status", "--porcelain", "--untracked-files=all"],
    )?;
    if !status.trim().is_empty() {
        return Ok(json!({
            "path": workspace_root,
            "deleted": false,
            "isolated": true,
            "preserved": true,
            "reason": "worktree has uncommitted changes",
        }));
    }

    let common_dir = git_stdout(&requested, &["rev-parse", "--git-common-dir"])?;
    let common_dir = PathBuf::from(common_dir.trim());
    let common_dir = if common_dir.is_absolute() {
        common_dir
    } else {
        requested.join(common_dir)
    };
    let repo = common_dir
        .parent()
        .context("session worktree git directory has no repository parent")?;
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["worktree", "remove"])
        .arg(&requested)
        .output()
        .context("failed to remove session worktree")?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Ok(json!({
            "path": workspace_root,
            "deleted": false,
            "isolated": true,
            "preserved": true,
            "reason": if detail.is_empty() {
                "git refused to remove the worktree".to_string()
            } else {
                detail
            },
        }));
    }

    Ok(json!({
        "path": workspace_root,
        "deleted": true,
        "isolated": true,
        "preserved": false,
        "branch": expected_branch,
    }))
}

fn git_stdout(directory: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(args)
        .output()
        .context("failed to run git")?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        anyhow::bail!(if detail.is_empty() {
            "git command failed".to_string()
        } else {
            detail
        });
    }
    String::from_utf8(output.stdout).context("git returned non-UTF-8 output")
}

/// Marker written when the user intentionally removes the last project. Core
/// seeds a Starter project for a brand-new install, but must not resurrect it
/// after the user has deliberately chosen an empty project hub.
pub const EMPTY_PROJECTS_MARKER: &str = ".empty-projects";

/// Permanently remove one explicitly named project, including the last one.
pub fn delete_project(root: &Path, slug: &str) -> Result<Value> {
    let clean = sanitize_slug(slug)?;
    let directory = project_dir(root, &clean)?;
    if !project_file(root, &clean)?.exists() {
        anyhow::bail!("project {clean} not found");
    }
    let count = list_projects(root)?.as_array().map(Vec::len).unwrap_or(0);

    let root_real = root.canonicalize()?;
    let directory_real = directory.canonicalize()?;
    if directory_real.parent() != Some(root_real.as_path()) {
        anyhow::bail!("refusing to remove a project outside the projects directory");
    }
    if count == 1 {
        // Write the intent before deleting the directory: a marker failure
        // must leave the project recoverable rather than allowing a later
        // core restart to recreate Starter behind the user's back.
        std::fs::write(root.join(EMPTY_PROJECTS_MARKER), b" intentionally empty\n")?;
    }
    std::fs::remove_dir_all(&directory_real)?;
    Ok(json!({ "slug": clean, "deleted": true }))
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
    for name in [
        "project.json",
        "scripts",
        "assets",
        "tests",
        "baselines",
        "thumbnails",
    ] {
        let from = src.join(name);
        let to = dest.join(name);
        if from.is_dir() && to.exists() {
            std::fs::remove_dir_all(&to)?;
        }
        if from.exists() {
            copy_path(&from, &to)?;
        }
    }
    read_project(root, &clean)
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
    // A symlink at the leaf needs resolving before the ancestor walk: when its
    // target does not exist the walk falls back to the parent and allows a
    // write that then follows the link out of the root. Shared with the
    // workspace resolver so the two cannot drift apart.
    crate::workspace::reject_symlink_escape(&root_real, &path)
        .map_err(|_| anyhow::anyhow!("path escapes project root"))?;
    let resolved =
        crate::workspace::deepest_existing(&path).context("path escapes project root")?;
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
    fn creates_each_project_template() {
        let root = tempfile::tempdir().unwrap();

        let blank = create_project_from_template(root.path(), "empty", "Empty", "blank").unwrap();
        assert_eq!(blank["entities"].as_array().unwrap().len(), 0);
        assert_eq!(blank["scripts"].as_array().unwrap().len(), 0);

        let showcase =
            create_project_from_template(root.path(), "gallery", "Gallery", "showcase").unwrap();
        assert_eq!(showcase["entities"].as_array().unwrap().len(), 4);
        assert_eq!(showcase["scripts"][0]["id"], "turntable");
        assert_eq!(showcase["slug"], "gallery");
        assert_eq!(showcase["title"], "Gallery");
    }

    #[test]
    fn starter_template_checks_survive_scene_renames_and_await_assertions() {
        let project: Value = serde_json::from_str(SAMPLE_PROJECT).unwrap();
        let tests = project["tests"].as_array().unwrap();
        assert!(tests.iter().any(|test| {
            test["id"] == "test-floor"
                && test["name"] == "Playable surface exists"
                && test["script"].as_str().is_some_and(|script| {
                    script.contains("e.kind === 'plane'") && script.contains("await assert")
                })
        }));
        assert!(tests.iter().any(|test| {
            test["id"] == "test-hero"
                && test["script"].as_str().is_some_and(|script| {
                    script.contains("await assert") && script.contains("Hero moves during PIE")
                })
        }));
    }

    #[test]
    fn rejects_unknown_project_templates_without_writing_a_project() {
        let root = tempfile::tempdir().unwrap();

        assert!(create_project_from_template(root.path(), "demo", "Demo", "missing").is_err());
        assert!(!project_dir(root.path(), "demo").unwrap().exists());
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
            assert!(
                dir.join(name).is_dir(),
                "{name} must survive a rejected revert"
            );
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
        assert_eq!(
            read_project(root.path(), "demo").unwrap()["title"],
            "User Work"
        );
    }

    #[test]
    fn rename_changes_only_the_title() {
        let root = tempfile::tempdir().unwrap();
        let before = create_project(root.path(), "demo", "Demo").unwrap();
        let renamed = rename_project(root.path(), "demo", "  Better Demo  ").unwrap();
        assert_eq!(renamed["title"], "Better Demo");
        assert_eq!(renamed["entities"], before["entities"]);
        assert!(rename_project(root.path(), "demo", "   ").is_err());
    }

    #[test]
    fn project_location_prefers_an_existing_workspace() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        set_workspace_root(root.path(), "demo", workspace.path().to_str()).unwrap();
        assert_eq!(
            project_location(root.path(), "demo").unwrap(),
            workspace.path()
        );
    }

    #[test]
    fn delete_removes_one_project_and_can_leave_an_empty_hub() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "one", "One").unwrap();
        create_project(root.path(), "two", "Two").unwrap();

        delete_project(root.path(), "one").unwrap();
        assert!(!root.path().join("one").exists());
        assert!(root.path().join("two/project.json").exists());
        delete_project(root.path(), "two").unwrap();
        assert!(!root.path().join("two").exists());
        assert!(root.path().join(EMPTY_PROJECTS_MARKER).exists());
        assert!(list_projects(root.path())
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn permanent_worktree_is_created_and_attached() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let repo = home.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]).unwrap();
        run_git(&repo, &["config", "user.email", "tests@example.com"]).unwrap();
        run_git(&repo, &["config", "user.name", "CaliCode Tests"]).unwrap();
        std::fs::write(repo.join("README.md"), "demo").unwrap();
        run_git(&repo, &["add", "README.md"]).unwrap();
        run_git(&repo, &["commit", "-m", "initial"]).unwrap();

        create_project(&projects, "demo", "Demo").unwrap();
        set_workspace_root(&projects, "demo", repo.to_str()).unwrap();
        let result = create_permanent_worktree(&projects, "demo").unwrap();
        let destination = home.path().join("worktrees/demo");

        assert_eq!(result["branch"], "calicode/demo");
        assert_eq!(result["created"], true);
        assert_eq!(result["path"], destination.to_string_lossy().as_ref());
        assert!(destination.join("README.md").exists());
        assert_eq!(
            read_project(&projects, "demo").unwrap()["workspaceRoot"],
            destination.to_string_lossy().as_ref()
        );
    }

    #[test]
    fn sessions_get_distinct_worktrees_without_rebinding_the_project() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let repo = home.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]).unwrap();
        run_git(&repo, &["config", "user.email", "tests@example.com"]).unwrap();
        run_git(&repo, &["config", "user.name", "CaliCode Tests"]).unwrap();
        std::fs::write(repo.join("README.md"), "demo").unwrap();
        run_git(&repo, &["add", "README.md"]).unwrap();
        run_git(&repo, &["commit", "-m", "initial"]).unwrap();

        create_project(&projects, "demo", "Demo").unwrap();
        set_workspace_root(&projects, "demo", repo.to_str()).unwrap();
        let a = create_session_workspace(&projects, "demo", "session-aaaaaaaaaaaa1111").unwrap();
        let b = create_session_workspace(&projects, "demo", "session-bbbbbbbbbbbb2222").unwrap();

        assert_ne!(a["path"], b["path"]);
        assert_eq!(a["branch"], "calicode/demo/aaaaaaaaaaaa");
        assert_eq!(b["branch"], "calicode/demo/bbbbbbbbbbbb");
        assert!(Path::new(a["path"].as_str().unwrap())
            .join("README.md")
            .exists());
        assert_eq!(
            read_project(&projects, "demo").unwrap()["workspaceRoot"],
            repo.to_string_lossy().as_ref()
        );
    }

    #[test]
    fn cleanup_removes_only_a_clean_session_worktree() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let repo = home.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]).unwrap();
        run_git(&repo, &["config", "user.email", "tests@example.com"]).unwrap();
        run_git(&repo, &["config", "user.name", "CaliCode Tests"]).unwrap();
        std::fs::write(repo.join("README.md"), "demo").unwrap();
        run_git(&repo, &["add", "README.md"]).unwrap();
        run_git(&repo, &["commit", "-m", "initial"]).unwrap();

        create_project(&projects, "demo", "Demo").unwrap();
        set_workspace_root(&projects, "demo", repo.to_str()).unwrap();
        let workspace =
            create_session_workspace(&projects, "demo", "session-aaaaaaaaaaaa1111").unwrap();
        let path = workspace["path"].as_str().unwrap();
        let result = cleanup_session_workspace(
            &projects,
            "demo",
            Some(path),
            workspace["worktreeId"].as_str(),
            workspace["branch"].as_str(),
        )
        .unwrap();

        assert_eq!(result["deleted"], true);
        assert!(!Path::new(path).exists());
        assert_eq!(
            read_project(&projects, "demo").unwrap()["workspaceRoot"],
            repo.to_string_lossy().as_ref(),
            "cleaning a session must not rebind the project"
        );
        assert!(
            git_stdout(
                &repo,
                &[
                    "show-ref",
                    "--verify",
                    "refs/heads/calicode/demo/aaaaaaaaaaaa"
                ]
            )
            .is_ok(),
            "cleanup must not delete the branch that may contain user work"
        );
    }

    #[test]
    fn cleanup_preserves_dirty_session_worktree_and_shared_workspace() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let repo = home.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]).unwrap();
        run_git(&repo, &["config", "user.email", "tests@example.com"]).unwrap();
        run_git(&repo, &["config", "user.name", "CaliCode Tests"]).unwrap();
        std::fs::write(repo.join("README.md"), "demo").unwrap();
        run_git(&repo, &["add", "README.md"]).unwrap();
        run_git(&repo, &["commit", "-m", "initial"]).unwrap();

        create_project(&projects, "demo", "Demo").unwrap();
        set_workspace_root(&projects, "demo", repo.to_str()).unwrap();
        let workspace =
            create_session_workspace(&projects, "demo", "session-bbbbbbbbbbbb2222").unwrap();
        let path = workspace["path"].as_str().unwrap();
        std::fs::write(Path::new(path).join("keep-me.txt"), "user work").unwrap();
        let dirty = cleanup_session_workspace(
            &projects,
            "demo",
            Some(path),
            workspace["worktreeId"].as_str(),
            workspace["branch"].as_str(),
        )
        .unwrap();
        assert_eq!(dirty["deleted"], false);
        assert_eq!(dirty["preserved"], true);
        assert!(Path::new(path).join("keep-me.txt").exists());

        let shared =
            cleanup_session_workspace(&projects, "demo", Some(repo.to_str().unwrap()), None, None)
                .unwrap();
        assert_eq!(shared["deleted"], false);
        assert_eq!(shared["isolated"], false);
        assert!(repo.join("README.md").exists());
    }

    #[test]
    fn cleanup_rejects_a_session_path_outside_the_generated_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let result = cleanup_session_workspace(
            root.path(),
            "demo",
            Some(outside.path().to_str().unwrap()),
            Some("demo-aaaaaaaaaaaa"),
            Some("calicode/demo/aaaaaaaaaaaa"),
        )
        .unwrap();
        assert_eq!(result["deleted"], false);
        assert_eq!(result["preserved"], true);
        assert!(outside.path().exists());
    }

    fn run_git(directory: &Path, args: &[&str]) -> Result<()> {
        let output = Command::new("git")
            .arg("-C")
            .arg(directory)
            .args(args)
            .output()?;
        if !output.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(&output.stderr));
        }
        Ok(())
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
        let dir = project_dir(root.path(), "demo")
            .unwrap()
            .join("checkpoints");
        let on_disk = std::fs::read_dir(dir).unwrap().count();
        assert_eq!(on_disk, 12, "every returned id must exist on disk");
    }

    #[test]
    fn checkpoint_response_hides_the_host_path() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let result = checkpoint_project(root.path(), "demo").unwrap();
        assert!(
            result.get("path").is_none(),
            "absolute host path must not be returned"
        );
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
        assert!(
            leftovers.is_empty(),
            "temp files must be renamed, not left behind"
        );
    }

    #[test]
    fn set_workspace_root_binds_and_detaches_a_game_folder() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();

        let bound = set_workspace_root(root.path(), "demo", Some("/tmp/my-game")).unwrap();
        assert_eq!(bound["workspaceRoot"], "/tmp/my-game");
        assert_eq!(
            read_project(root.path(), "demo").unwrap()["workspaceRoot"],
            "/tmp/my-game"
        );

        let detached = set_workspace_root(root.path(), "demo", None).unwrap();
        assert!(detached["workspaceRoot"].is_null());
    }

    #[test]
    fn each_game_keeps_its_own_workspace_root() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "one", "One").unwrap();
        create_project(root.path(), "two", "Two").unwrap();

        set_workspace_root(root.path(), "one", Some("/tmp/one")).unwrap();
        set_workspace_root(root.path(), "two", Some("/tmp/two")).unwrap();

        assert_eq!(
            read_project(root.path(), "one").unwrap()["workspaceRoot"],
            "/tmp/one"
        );
        assert_eq!(
            read_project(root.path(), "two").unwrap()["workspaceRoot"],
            "/tmp/two"
        );
    }

    #[test]
    fn validate_project_rejects_a_non_string_workspace_root() {
        let mut project: Value = serde_json::from_str(SAMPLE_PROJECT).unwrap();
        project["workspaceRoot"] = serde_json::json!(42);
        assert!(validate_project(&project).is_err());
    }
}
