//! Starters: file trees CaliCode writes to disk to bring a new workspace into
//! existence.
//!
//! `store.rs` templates and this module answer different questions. A project
//! template is a *scene document* — entities, scripts, settings — and is the
//! right shape for something the three.js editor owns end to end. A starter is
//! a *repository*: `package.json`, sources, a dev script. It is what
//! `workspace.rs` can open, and until this module existed CaliCode could open
//! somebody else's codebase but never create one, so every workspace had to be
//! scaffolded by hand somewhere else first.
//!
//! Compiled-in starters are overridable by a directory of the same id, the same
//! arrangement `graph.rs` uses for node templates. `CALI_STARTERS_DIR` moves
//! that root for an isolated run, as `CALI_SKILLS_DIR` does; the `*_in`
//! functions take it as an argument instead so tests never touch a
//! process-wide variable they would race each other on.
//!
//! **Nothing here fetches.** A starter is either compiled into this binary or
//! already on the user's disk under `~/.cali`, which is the same trust level as
//! `~/.cali/commands` and `~/.cali/agents` — the user put it there. A registry
//! that cloned a remote repo would be a different proposition entirely: it would
//! be arbitrary third-party source arriving because somebody clicked a name, and
//! it must not ship without first-use consent keyed on the source, the way
//! `approved_project_mcp` gates a project-scoped MCP server. That is why there
//! is no `url:` field in the manifest — an absent field cannot be half-honoured.
//!
//! Dependencies are deliberately *not* installed here. `npm install` needs the
//! network, and the only sanctioned way to run a command on the user's machine
//! is `terminal.rs`, which is user-initiated by design. `install` in the
//! manifest is reported back as a string for the client to offer, never spawned.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

/// A starter may not carry more files than this, nor more bytes in total. Both
/// bound what one `workspace_create_from_template` can write.
const MAX_FILES: usize = 500;
const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;

/// Directories inside a user starter that are never copied. A starter authored
/// by running the thing once would otherwise carry its whole `node_modules`.
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "dist", "build", ".vite", "target"];

/// Roots a workspace may never be created at, mirroring `workspace::open`.
const FORBIDDEN_ROOTS: &[&str] = &[
    "/", "/etc", "/System", "/Library", "/usr", "/bin", "/var", "/Volumes",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StarterScope {
    Builtin,
    User,
}

impl StarterScope {
    pub fn as_str(self) -> &'static str {
        match self {
            StarterScope::Builtin => "builtin",
            StarterScope::User => "user",
        }
    }
}

/// The manifest, as written in `starter.yaml`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// `package.json` script the dev server should run. `devserver::start`
    /// takes a script *name*, never a command line.
    #[serde(default = "default_dev_script")]
    pub dev_script: String,
    /// Reported to the client so it can offer the command. Never spawned here.
    #[serde(default)]
    pub install: Option<String>,
}

fn default_dev_script() -> String {
    "dev".to_string()
}

#[derive(Debug, Clone)]
pub struct Starter {
    pub id: String,
    pub manifest: Manifest,
    pub scope: StarterScope,
}

impl Starter {
    pub fn describe(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.manifest.name,
            "description": self.manifest.description,
            "tags": self.manifest.tags,
            "devScript": self.manifest.dev_script,
            "install": self.manifest.install,
            "scope": self.scope.as_str(),
        })
    }
}

/// One compiled-in starter. The files are `include_str!`d so a packaged app
/// carries them without needing the repo beside it.
struct Builtin {
    id: &'static str,
    manifest: &'static str,
    files: &'static [(&'static str, &'static str)],
}

const BUILTINS: &[Builtin] = &[Builtin {
    id: "iso-city",
    manifest: include_str!("../starters/iso-city/starter.yaml"),
    files: &[
        (
            "package.json",
            include_str!("../starters/iso-city/files/package.json"),
        ),
        (
            "tsconfig.json",
            include_str!("../starters/iso-city/files/tsconfig.json"),
        ),
        (
            "vite.config.ts",
            include_str!("../starters/iso-city/files/vite.config.ts"),
        ),
        (
            "index.html",
            include_str!("../starters/iso-city/files/index.html"),
        ),
        (
            "README.md",
            include_str!("../starters/iso-city/files/README.md"),
        ),
        (
            "src/main.ts",
            include_str!("../starters/iso-city/files/src/main.ts"),
        ),
        (
            "src/engine/view.ts",
            include_str!("../starters/iso-city/files/src/engine/view.ts"),
        ),
        (
            "src/engine/grid.ts",
            include_str!("../starters/iso-city/files/src/engine/grid.ts"),
        ),
        (
            "src/engine/city.ts",
            include_str!("../starters/iso-city/files/src/engine/city.ts"),
        ),
        (
            "src/engine/loop.ts",
            include_str!("../starters/iso-city/files/src/engine/loop.ts"),
        ),
    ],
}];

/// `CALI_STARTERS_DIR` overrides it for the same reason `CALI_SKILLS_DIR`
/// does: a test run must not read or write the developer's own `~/.cali`.
pub fn global_starters_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CALI_STARTERS_DIR") {
        return PathBuf::from(dir);
    }
    crate::workspace::shellexpand("~/.cali/starters").into()
}

/// Every available starter, user entries shadowing a builtin of the same id,
/// sorted by name. Never errors: an unreadable directory yields nothing and an
/// unparsable manifest drops that one entry rather than the whole list.
pub fn list() -> Vec<Starter> {
    list_in(&global_starters_dir())
}

pub fn get(id: &str) -> Result<Starter> {
    get_in(&global_starters_dir(), id)
}

/// Materialize `id` at `dest`, returning the created root.
pub fn create(id: &str, dest: &str) -> Result<PathBuf> {
    create_in(&global_starters_dir(), id, dest)
}

/// The user root is threaded through rather than read from the environment so
/// tests can isolate it without `set_var`, which races across the test threads.
pub fn list_in(user_dir: &Path) -> Vec<Starter> {
    let mut starters: Vec<Starter> = BUILTINS
        .iter()
        .filter_map(|builtin| {
            serde_yaml::from_str::<Manifest>(builtin.manifest)
                .ok()
                .map(|manifest| Starter {
                    id: builtin.id.to_string(),
                    manifest,
                    scope: StarterScope::Builtin,
                })
        })
        .collect();

    for starter in scan_user_dir(user_dir) {
        match starters.iter().position(|s| s.id == starter.id) {
            Some(at) => starters[at] = starter,
            None => starters.push(starter),
        }
    }

    starters.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    starters
}

pub fn get_in(user_dir: &Path, id: &str) -> Result<Starter> {
    list_in(user_dir)
        .into_iter()
        .find(|starter| starter.id == id)
        .with_context(|| format!("unknown starter {id}"))
}

fn scan_user_dir(dir: &Path) -> Vec<Starter> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.filter_map(Result::ok) {
        if !entry.path().is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if !is_valid_id(&id) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path().join("starter.yaml")) else {
            continue;
        };
        let Ok(manifest) = serde_yaml::from_str::<Manifest>(&text) else {
            continue;
        };
        found.push(Starter {
            id,
            manifest,
            scope: StarterScope::User,
        });
    }
    found
}

fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Files a starter contributes, as `(relative path, bytes)`.
fn files_for(user_dir: &Path, starter: &Starter) -> Result<Vec<(String, Vec<u8>)>> {
    if starter.scope == StarterScope::Builtin {
        let builtin = BUILTINS
            .iter()
            .find(|b| b.id == starter.id)
            .context("builtin starter vanished")?;
        return Ok(builtin
            .files
            .iter()
            .map(|(rel, body)| ((*rel).to_string(), body.as_bytes().to_vec()))
            .collect());
    }

    let root = user_dir.join(&starter.id).join("files");
    let root = root
        .canonicalize()
        .with_context(|| format!("starter {} has no files/ directory", starter.id))?;
    let mut out = Vec::new();
    let mut total = 0u64;
    collect(&root, &root, &mut out, &mut total)?;
    if out.is_empty() {
        bail!("starter {} contributes no files", starter.id);
    }
    Ok(out)
}

fn collect(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(String, Vec<u8>)>,
    total: &mut u64,
) -> Result<()> {
    for entry in std::fs::read_dir(dir)?.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // `symlink_metadata` rather than `metadata`: a symlink out of the
        // starter would otherwise be followed and its target copied in.
        let meta = std::fs::symlink_metadata(&path)?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            collect(root, &path, out, total)?;
            continue;
        }
        *total += meta.len();
        if out.len() >= MAX_FILES || *total > MAX_TOTAL_BYTES {
            bail!("starter is too large (limit {MAX_FILES} files, {MAX_TOTAL_BYTES} bytes)");
        }
        let rel = path
            .strip_prefix(root)?
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");
        out.push((rel, std::fs::read(&path)?));
    }
    Ok(())
}

/// Materialize `id` at `dest`, returning the created root.
///
/// The destination is required to be absent or empty. Merging a starter into a
/// populated directory is how a scaffold silently overwrites somebody's work,
/// and there is no undo for a file that was never in git.
pub fn create_in(user_dir: &Path, id: &str, dest: &str) -> Result<PathBuf> {
    let starter = get_in(user_dir, id)?;
    let root = PathBuf::from(crate::workspace::shellexpand(dest));
    if !root.is_absolute() {
        bail!("{} is not an absolute path", root.display());
    }
    if FORBIDDEN_ROOTS.iter().any(|deny| root == Path::new(deny)) {
        bail!("{} cannot be created as a workspace", root.display());
    }
    if let Some(home) = std::env::var_os("HOME") {
        if root.as_path() == Path::new(&home) {
            bail!("the home directory cannot be created as a workspace");
        }
    }
    if root.exists() {
        if !root.is_dir() {
            bail!("{} already exists and is not a directory", root.display());
        }
        if std::fs::read_dir(&root)?.next().is_some() {
            bail!("{} is not empty", root.display());
        }
    }

    let files = files_for(user_dir, &starter)?;
    std::fs::create_dir_all(&root)
        .with_context(|| format!("could not create {}", root.display()))?;
    // Canonicalize only after the directory exists — the escape check needs a
    // real path to compare against, and `dest` may name something that did not
    // exist a line ago.
    let real_root = root.canonicalize()?;

    for (rel, bytes) in &files {
        let target = safe_join(&real_root, rel)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&target, bytes)
            .with_context(|| format!("could not write {}", target.display()))?;
    }
    Ok(real_root)
}

/// Join a starter-relative path under `root`, refusing anything that is not a
/// plain descending path. A starter file named `../../.ssh/authorized_keys`
/// would otherwise be written exactly where it asked.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf> {
    if rel.is_empty() || rel.contains('\0') {
        bail!("invalid path in starter: {rel:?}");
    }
    let candidate = PathBuf::from(rel);
    if candidate.is_absolute() {
        bail!("starter path must be relative: {rel}");
    }
    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            _ => bail!("starter path must not traverse: {rel}"),
        }
    }
    Ok(root.join(candidate))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An empty user root: only the builtins are visible. Threading the path in
    /// rather than setting `CALI_STARTERS_DIR` keeps these tests from racing
    /// each other on a process-wide variable.
    fn empty_user_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn write_user_starter(root: &Path, id: &str, name: &str) {
        let base = root.join(id);
        std::fs::create_dir_all(base.join("files/src")).unwrap();
        std::fs::write(
            base.join("starter.yaml"),
            format!("name: {name}\ndescription: a test starter\n"),
        )
        .unwrap();
        std::fs::write(base.join("files/package.json"), r#"{"name":"t"}"#).unwrap();
        std::fs::write(base.join("files/src/main.ts"), "export {};\n").unwrap();
    }

    #[test]
    fn the_builtin_starter_parses_and_carries_its_files() {
        let dir = empty_user_dir();
        let starter = get_in(dir.path(), "iso-city").unwrap();
        assert_eq!(starter.scope, StarterScope::Builtin);
        assert_eq!(starter.manifest.dev_script, "dev");
        assert_eq!(starter.manifest.install.as_deref(), Some("npm install"));

        let files = files_for(dir.path(), &starter).unwrap();
        let names: Vec<&str> = files.iter().map(|(rel, _)| rel.as_str()).collect();
        assert!(names.contains(&"package.json"));
        assert!(names.contains(&"src/engine/city.ts"));
    }

    /// The starter is only useful if `workspace::open` accepts the result, and
    /// that requires a `package.json` at the root.
    #[test]
    fn every_builtin_is_openable_as_a_workspace() {
        let dir = empty_user_dir();
        for starter in list_in(dir.path())
            .into_iter()
            .filter(|s| s.scope == StarterScope::Builtin)
        {
            let files = files_for(dir.path(), &starter).unwrap();
            assert!(
                files.iter().any(|(rel, _)| rel == "package.json"),
                "{} has no package.json; workspace::open would refuse it",
                starter.id
            );
        }
    }

    /// `devserver::start` looks the script up by name in `package.json`, so a
    /// manifest naming a script its own files do not define would fail only at
    /// PLAY time, long after the scaffold reported success.
    #[test]
    fn every_builtin_dev_script_exists_in_its_package_json() {
        let dir = empty_user_dir();
        for starter in list_in(dir.path())
            .into_iter()
            .filter(|s| s.scope == StarterScope::Builtin)
        {
            let files = files_for(dir.path(), &starter).unwrap();
            let (_, manifest) = files.iter().find(|(rel, _)| rel == "package.json").unwrap();
            let parsed: Value = serde_json::from_slice(manifest).unwrap();
            assert!(
                parsed["scripts"][&starter.manifest.dev_script].is_string(),
                "{} declares devScript '{}' with no such script",
                starter.id,
                starter.manifest.dev_script
            );
        }
    }

    #[test]
    fn create_writes_the_tree_and_refuses_a_populated_destination() {
        let dir = empty_user_dir();
        let target = tempfile::tempdir().unwrap();
        let dest = target.path().join("city");

        let root = create_in(dir.path(), "iso-city", dest.to_str().unwrap()).unwrap();
        assert!(root.join("package.json").exists());
        assert!(root.join("src/engine/view.ts").exists());

        let again = create_in(dir.path(), "iso-city", dest.to_str().unwrap());
        assert!(again.unwrap_err().to_string().contains("not empty"));
    }

    #[test]
    fn an_existing_empty_directory_is_accepted() {
        let dir = empty_user_dir();
        let target = tempfile::tempdir().unwrap();
        let dest = target.path().join("empty");
        std::fs::create_dir_all(&dest).unwrap();
        assert!(create_in(dir.path(), "iso-city", dest.to_str().unwrap()).is_ok());
    }

    #[test]
    fn a_user_starter_shadows_a_builtin_of_the_same_id() {
        let dir = empty_user_dir();
        write_user_starter(dir.path(), "iso-city", "My City");

        let starter = get_in(dir.path(), "iso-city").unwrap();
        assert_eq!(starter.scope, StarterScope::User);
        assert_eq!(starter.manifest.name, "My City");

        let files = files_for(dir.path(), &starter).unwrap();
        assert!(files.iter().any(|(rel, _)| rel == "src/main.ts"));
        // The builtin's files must not leak through the override.
        assert!(!files.iter().any(|(rel, _)| rel == "src/engine/city.ts"));
    }

    #[test]
    fn a_user_starter_with_a_new_id_joins_the_list() {
        let dir = empty_user_dir();
        write_user_starter(dir.path(), "my-roguelike", "Roguelike");
        let ids: Vec<String> = list_in(dir.path()).into_iter().map(|s| s.id).collect();
        assert!(ids.contains(&"my-roguelike".to_string()));
        assert!(ids.contains(&"iso-city".to_string()));
    }

    #[test]
    fn an_unparsable_manifest_drops_only_that_starter() {
        let dir = empty_user_dir();
        write_user_starter(dir.path(), "good", "Good");
        std::fs::create_dir_all(dir.path().join("bad")).unwrap();
        std::fs::write(dir.path().join("bad/starter.yaml"), "name: [unclosed").unwrap();

        let ids: Vec<String> = list_in(dir.path()).into_iter().map(|s| s.id).collect();
        assert!(ids.contains(&"good".to_string()));
        assert!(!ids.contains(&"bad".to_string()));
        assert!(ids.contains(&"iso-city".to_string()));
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_inside_a_starter_is_not_copied_out() {
        let dir = empty_user_dir();
        write_user_starter(dir.path(), "linky", "Linky");
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, "do not copy me").unwrap();
        std::os::unix::fs::symlink(&secret, dir.path().join("linky/files/leak.txt")).unwrap();

        let files = files_for(dir.path(), &get_in(dir.path(), "linky").unwrap()).unwrap();
        assert!(!files.iter().any(|(rel, _)| rel == "leak.txt"));
    }

    #[test]
    fn node_modules_in_a_user_starter_is_skipped() {
        let dir = empty_user_dir();
        write_user_starter(dir.path(), "heavy", "Heavy");
        std::fs::create_dir_all(dir.path().join("heavy/files/node_modules/three")).unwrap();
        std::fs::write(
            dir.path().join("heavy/files/node_modules/three/index.js"),
            "// huge",
        )
        .unwrap();

        let files = files_for(dir.path(), &get_in(dir.path(), "heavy").unwrap()).unwrap();
        assert!(!files.iter().any(|(rel, _)| rel.starts_with("node_modules")));
    }

    #[test]
    fn a_traversing_path_is_refused_rather_than_written() {
        let root = tempfile::tempdir().unwrap();
        assert!(safe_join(root.path(), "../escape.txt").is_err());
        assert!(safe_join(root.path(), "/etc/passwd").is_err());
        assert!(safe_join(root.path(), "src/ok.ts").is_ok());
    }

    #[test]
    fn forbidden_roots_and_a_relative_destination_are_refused() {
        let dir = empty_user_dir();
        assert!(create_in(dir.path(), "iso-city", "/").is_err());
        assert!(create_in(dir.path(), "iso-city", "/etc").is_err());
        assert!(create_in(dir.path(), "iso-city", "relative/path").is_err());
        if let Some(home) = std::env::var_os("HOME") {
            assert!(create_in(dir.path(), "iso-city", &home.to_string_lossy()).is_err());
        }
    }

    #[test]
    fn an_unknown_starter_is_named_in_the_error() {
        let dir = empty_user_dir();
        let error = get_in(dir.path(), "nope").unwrap_err().to_string();
        assert!(error.contains("nope"), "{error}");
    }
}
