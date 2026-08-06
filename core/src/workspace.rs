//! Workspaces: real folders on disk that CaliCode edits in place.
//!
//! A project (`store.rs`) is a scene document CaliCode owns end to end. A
//! workspace is somebody else's repository — the San Francisco world, say —
//! that CaliCode browses, edits, and runs without taking ownership of it.
//! The two stay separate deliberately: a 53k-line three.js game has no
//! entities/scripts/assets/tests to squeeze into the project schema.
//!
//! `workspace_open` is the trust boundary. It is the only method that accepts
//! an absolute path; every other method addresses files by `{id, relPath}`.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

/// Read cap. Anything larger is returned truncated rather than streamed into
/// an editor buffer.
const MAX_READ_BYTES: usize = 2 * 1024 * 1024;
/// Write cap.
const MAX_WRITE_BYTES: usize = 8 * 1024 * 1024;
/// Per-directory entry cap, so a listing can never stall the UI.
const MAX_TREE_ENTRIES: usize = 2000;

/// Never traversed. `public/data` in the San Francisco repo alone holds
/// ~410MB of generated atlases and contours.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    ".vite",
    ".next",
    ".cache",
    ".wt",
    "target",
    "public/data",
];

/// Never read or written, regardless of whether the path resolves.
const SECRET_PATTERNS: &[&str] = &[".env", "id_rsa", "id_ed25519", ".pem", ".p12", ".keystore"];

/// Roots that are never valid workspaces on their own.
const FORBIDDEN_ROOTS: &[&str] = &["/", "/etc", "/System", "/Library", "/usr", "/bin", "/var", "/Volumes"];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root: PathBuf,
}

pub type Registry = HashMap<String, Workspace>;

/// Stable across restarts so a saved workspace id keeps resolving.
fn workspace_id(root: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(root.to_string_lossy().as_bytes());
    format!("ws-{:x}", hasher.finalize())[..15].to_string()
}

pub fn open(registry: &mut Registry, path: &str, name: Option<&str>) -> Result<Value> {
    let requested = PathBuf::from(shellexpand(path));
    let root = requested
        .canonicalize()
        .with_context(|| format!("{} is not a readable directory", requested.display()))?;

    if !root.is_dir() {
        anyhow::bail!("{} is not a directory", root.display());
    }
    if FORBIDDEN_ROOTS.iter().any(|deny| root == Path::new(deny)) {
        anyhow::bail!("{} cannot be opened as a workspace", root.display());
    }
    if let Some(home) = std::env::var_os("HOME") {
        if root == PathBuf::from(home) {
            anyhow::bail!("the home directory cannot be opened as a workspace");
        }
    }
    // A workspace should be a project, not an arbitrary folder. This keeps a
    // stray `workspace_open` from turning into a filesystem browser.
    if !root.join("package.json").exists() && !root.join(".git").exists() {
        anyhow::bail!("{} has no package.json or .git; refusing to open", root.display());
    }

    let id = workspace_id(&root);
    let label = name
        .map(str::to_string)
        .or_else(|| root.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| id.clone());

    let workspace = Workspace { id: id.clone(), name: label, root: root.clone() };
    registry.insert(id.clone(), workspace.clone());
    Ok(describe(&workspace))
}

pub fn describe(workspace: &Workspace) -> Value {
    let manifest = std::fs::read_to_string(workspace.root.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let scripts = manifest
        .as_ref()
        .and_then(|m| m.get("scripts"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let entries: Vec<String> = std::fs::read_dir(&workspace.root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".html"))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();

    json!({
        "id": workspace.id,
        "name": workspace.name,
        "root": workspace.root.display().to_string(),
        "hasPackageJson": manifest.is_some(),
        "hasGit": workspace.root.join(".git").exists(),
        "scripts": scripts,
        "entries": entries,
    })
}

/// Re-opens previously attached folders at startup.
///
/// The registry lives in memory, so without this every core restart silently
/// dropped whatever folder the user had attached and the client came back
/// with no workspace. Paths that no longer resolve are skipped rather than
/// failing boot.
pub fn restore(registry: &mut Registry, paths: &[String]) -> Vec<String> {
    let mut opened = Vec::new();
    for path in paths {
        match open(registry, path, None) {
            Ok(_) => opened.push(path.clone()),
            Err(error) => tracing::warn!(%path, %error, "skipping unavailable workspace"),
        }
    }
    opened
}

/// Absolute roots of every open workspace, for persisting to config.
pub fn roots(registry: &Registry) -> Vec<String> {
    let mut roots: Vec<String> = registry.values().map(|w| w.root.display().to_string()).collect();
    roots.sort();
    roots
}

pub fn list(registry: &Registry) -> Value {
    let mut items: Vec<Value> = registry.values().map(describe).collect();
    items.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    json!(items)
}

pub fn get<'a>(registry: &'a Registry, id: &str) -> Result<&'a Workspace> {
    registry.get(id).with_context(|| format!("workspace {id} is not open"))
}

/// Resolves a workspace-relative path to a real path inside the root.
///
/// Unlike `store::safe_join`, this canonicalizes. The lexical `..` check alone
/// is not enough for a real repository: a symlink inside the tree would
/// otherwise be followed straight out of it.
pub fn safe_resolve(root: &Path, rel: &str) -> Result<PathBuf> {
    // Reject absolute paths rather than silently reinterpreting them as
    // workspace-relative — `/etc/passwd` quietly becoming `<root>/etc/passwd`
    // reads as a successful read of the wrong file.
    if rel.starts_with('/') || rel.contains('\0') || rel.is_empty() {
        anyhow::bail!("path must be relative to the workspace");
    }
    let trimmed = rel;
    for component in Path::new(trimmed).components() {
        match component {
            Component::ParentDir => anyhow::bail!("path escapes the workspace"),
            Component::Prefix(_) | Component::RootDir => anyhow::bail!("path escapes the workspace"),
            _ => {}
        }
    }

    let lower = trimmed.to_ascii_lowercase();
    if SECRET_PATTERNS.iter().any(|pattern| lower.contains(pattern)) {
        anyhow::bail!("refusing to access {trimmed}");
    }

    let root_real = root.canonicalize().context("workspace root is unavailable")?;
    let candidate = root_real.join(trimmed);

    // The leaf may not exist yet on a write, so resolve the deepest existing
    // ancestor and check containment against that.
    let mut probe = candidate.as_path();
    let resolved = loop {
        match probe.canonicalize() {
            Ok(real) => break real,
            Err(_) => match probe.parent() {
                Some(parent) => probe = parent,
                None => anyhow::bail!("path escapes the workspace"),
            },
        }
    };
    if !resolved.starts_with(&root_real) {
        anyhow::bail!("path escapes the workspace");
    }
    Ok(candidate)
}

fn is_skipped(rel: &str, name: &str) -> bool {
    SKIP_DIRS
        .iter()
        .any(|skip| name == *skip || rel == *skip || rel.starts_with(&format!("{skip}/")))
}

pub fn tree(workspace: &Workspace, rel: &str, depth: u32, include_hidden: bool) -> Result<Value> {
    let base = if rel.is_empty() {
        workspace.root.clone()
    } else {
        safe_resolve(&workspace.root, rel)?
    };
    let entries = read_level(workspace, &base, rel, depth.min(3), include_hidden)?;
    Ok(json!({ "path": rel, "entries": entries }))
}

fn read_level(
    workspace: &Workspace,
    dir: &Path,
    rel: &str,
    depth: u32,
    include_hidden: bool,
) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut listing: Vec<_> = std::fs::read_dir(dir)
        .with_context(|| format!("cannot list {rel}"))?
        .filter_map(Result::ok)
        .collect();

    // Directories first, then files, each alphabetical. Without this, a repo
    // that keeps build artifacts at the root (the San Francisco world has ~60
    // .qa-*.png screenshots) buries src/ far below the fold.
    listing.sort_by_key(|entry| {
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        (!is_dir, entry.file_name().to_string_lossy().to_lowercase())
    });

    for entry in listing.into_iter().take(MAX_TREE_ENTRIES) {
        let name = entry.file_name().to_string_lossy().to_string();
        let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && is_skipped(&child_rel, &name) {
            continue;
        }
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let mut node = json!({
            "name": name,
            "path": child_rel,
            "kind": if is_dir { "dir" } else { "file" },
            "size": size,
        });
        if is_dir && depth > 1 {
            node["children"] =
                json!(read_level(workspace, &entry.path(), &child_rel, depth - 1, include_hidden)?);
        }
        out.push(node);
    }
    Ok(out)
}

pub fn read_file(workspace: &Workspace, rel: &str) -> Result<Value> {
    let path = safe_resolve(&workspace.root, rel)?;
    let bytes = std::fs::read(&path).with_context(|| format!("cannot read {rel}"))?;
    let truncated = bytes.len() > MAX_READ_BYTES;
    let slice = if truncated { &bytes[..MAX_READ_BYTES] } else { &bytes[..] };

    // A NUL in the first 8KiB means binary. The project-scoped `file_read`
    // hard-errors on these because it uses read_to_string; report honestly
    // instead so the client can show "binary file" rather than a failure.
    let probe = &slice[..slice.len().min(8192)];
    if probe.contains(&0) {
        return Ok(json!({
            "path": rel, "encoding": "binary", "bytes": bytes.len(), "truncated": truncated,
        }));
    }

    let content = String::from_utf8_lossy(slice).to_string();
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    Ok(json!({
        "path": rel,
        "content": content,
        "encoding": "utf8",
        "bytes": bytes.len(),
        "sha256": sha256,
        "truncated": truncated,
    }))
}

pub fn write_file(workspace: &Workspace, rel: &str, content: &str, expected: Option<&str>) -> Result<Value> {
    if content.len() > MAX_WRITE_BYTES {
        anyhow::bail!("refusing to write more than {MAX_WRITE_BYTES} bytes");
    }
    let path = safe_resolve(&workspace.root, rel)?;

    // Optimistic concurrency: a stale editor buffer must not clobber a file
    // that HMR, git, or another tool changed underneath it.
    if let Some(expected) = expected {
        if let Ok(current) = std::fs::read(&path) {
            let actual = format!("{:x}", Sha256::digest(&current));
            if actual != expected {
                anyhow::bail!("{rel} changed on disk since it was read");
            }
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("calicode-tmp");
    std::fs::write(&temp, content)?;
    std::fs::rename(&temp, &path)?;

    Ok(json!({
        "path": rel,
        "written": true,
        "bytes": content.len(),
        "sha256": format!("{:x}", Sha256::digest(content.as_bytes())),
    }))
}

fn shellexpand(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => match std::env::var_os("HOME") {
            Some(home) => format!("{}/{}", home.to_string_lossy(), rest),
            None => path.to_string(),
        },
        None => path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/main.js"), "console.log('hi')").unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        let root = dir.path().canonicalize().unwrap();
        let workspace = Workspace { id: workspace_id(&root), name: "fixture".into(), root };
        (dir, workspace)
    }

    #[test]
    fn open_requires_a_project_marker() {
        let bare = tempfile::tempdir().unwrap();
        let mut registry = Registry::new();
        assert!(open(&mut registry, bare.path().to_str().unwrap(), None).is_err());

        std::fs::write(bare.path().join("package.json"), "{}").unwrap();
        assert!(open(&mut registry, bare.path().to_str().unwrap(), None).is_ok());
    }

    #[test]
    fn open_refuses_system_roots() {
        let mut registry = Registry::new();
        for path in ["/", "/etc", "/System"] {
            assert!(open(&mut registry, path, None).is_err(), "{path} must be refused");
        }
    }

    #[test]
    fn workspace_ids_are_stable() {
        let (_dir, workspace) = fixture();
        assert_eq!(workspace.id, workspace_id(&workspace.root));
        assert!(workspace.id.starts_with("ws-"));
    }

    #[test]
    fn safe_resolve_blocks_traversal_and_symlinks() {
        let (_dir, workspace) = fixture();
        assert!(safe_resolve(&workspace.root, "src/main.js").is_ok());
        assert!(safe_resolve(&workspace.root, "../outside").is_err());
        assert!(safe_resolve(&workspace.root, "/etc/passwd").is_err());
        assert!(safe_resolve(&workspace.root, "src/../../escape").is_err());

        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), workspace.root.join("link")).unwrap();
            assert!(safe_resolve(&workspace.root, "link/secret.txt").is_err());
        }
    }

    #[test]
    fn safe_resolve_refuses_secret_files() {
        let (_dir, workspace) = fixture();
        for path in [".env", ".env.local", "keys/id_rsa", "certs/server.pem"] {
            assert!(safe_resolve(&workspace.root, path).is_err(), "{path} must be refused");
        }
    }

    #[test]
    fn tree_skips_heavy_directories() {
        let (_dir, workspace) = fixture();
        let listing = tree(&workspace, "", 1, false).unwrap();
        let names: Vec<&str> = listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"src"));
        assert!(!names.contains(&"node_modules"), "node_modules must not be traversed");
    }

    #[test]
    fn tree_puts_directories_first_and_hides_dotfiles() {
        let (_dir, workspace) = fixture();
        // Mirrors the San Francisco repo, which keeps ~60 .qa-*.png artifacts
        // at its root; without this, src/ sorts far below the fold.
        std::fs::write(workspace.root.join(".qa-shot.png"), "x").unwrap();
        std::fs::write(workspace.root.join("zzz.js"), "x").unwrap();
        std::fs::create_dir_all(workspace.root.join("assets")).unwrap();

        let listing = tree(&workspace, "", 1, false).unwrap();
        let entries = listing["entries"].as_array().unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e["name"].as_str().unwrap()).collect();
        let kinds: Vec<&str> = entries.iter().map(|e| e["kind"].as_str().unwrap()).collect();

        assert!(!names.contains(&".qa-shot.png"), "dotfiles hidden by default");
        let first_file = kinds.iter().position(|k| *k == "file").unwrap_or(kinds.len());
        assert!(
            kinds[..first_file].iter().all(|k| *k == "dir"),
            "directories must sort before files, got {names:?}"
        );

        let with_hidden = tree(&workspace, "", 1, true).unwrap();
        let hidden_names: Vec<String> = with_hidden["entries"]
            .as_array().unwrap().iter()
            .map(|e| e["name"].as_str().unwrap().to_string()).collect();
        assert!(hidden_names.iter().any(|n| n == ".qa-shot.png"));
    }

    #[test]
    fn read_and_write_roundtrip() {
        let (_dir, workspace) = fixture();
        let read = read_file(&workspace, "src/main.js").unwrap();
        assert_eq!(read["encoding"], "utf8");
        let sha = read["sha256"].as_str().unwrap().to_string();

        write_file(&workspace, "src/main.js", "console.log('edited')", Some(&sha)).unwrap();
        let after = read_file(&workspace, "src/main.js").unwrap();
        assert_eq!(after["content"], "console.log('edited')");
    }

    #[test]
    fn write_rejects_a_stale_hash() {
        let (_dir, workspace) = fixture();
        let result = write_file(&workspace, "src/main.js", "clobber", Some("deadbeef"));
        assert!(result.is_err(), "a stale buffer must not overwrite newer content");
        let after = read_file(&workspace, "src/main.js").unwrap();
        assert_eq!(after["content"], "console.log('hi')");
    }

    #[test]
    fn binary_files_are_reported_not_mangled() {
        let (_dir, workspace) = fixture();
        std::fs::write(workspace.root.join("blob.bin"), [0u8, 1, 2, 3]).unwrap();
        let read = read_file(&workspace, "blob.bin").unwrap();
        assert_eq!(read["encoding"], "binary");
    }

    #[test]
    fn restore_reopens_known_roots_and_skips_missing_ones() {
        // The registry is in-memory, so without restore every core restart
        // silently dropped the attached folder.
        let (_dir, workspace) = fixture();
        let root = workspace.root.display().to_string();

        let mut registry = Registry::new();
        let opened = restore(&mut registry, &[root.clone(), "/nope/does/not/exist".into()]);

        assert_eq!(opened, vec![root.clone()]);
        assert_eq!(registry.len(), 1, "a missing path must not abort the restore");
        assert_eq!(roots(&registry), vec![root]);
    }

    #[test]
    fn roots_are_stable_and_sorted() {
        let (_a, first) = fixture();
        let (_b, second) = fixture();
        let mut registry = Registry::new();
        open(&mut registry, first.root.to_str().unwrap(), None).unwrap();
        open(&mut registry, second.root.to_str().unwrap(), None).unwrap();

        let listed = roots(&registry);
        assert_eq!(listed.len(), 2);
        let mut sorted = listed.clone();
        sorted.sort();
        assert_eq!(listed, sorted);
    }
}
