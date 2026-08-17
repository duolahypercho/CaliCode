//! User-authored skills: markdown files with a small YAML frontmatter that the
//! agent can pull into context on demand.
//!
//! Skills follow progressive disclosure — the system prompt only carries a
//! compact index (`prompt_index`), and the agent fetches a full body through
//! the `skill_load` core tool. Global skills live in `~/.cali/skills/*.md`;
//! project skills live in `<base>/.cali/skills/*.md` where `<base>` follows
//! the same resolution rule as the file tools (`tools::game_file_base`): the
//! project's attached `workspaceRoot` when it has one, otherwise the
//! CaliCode-owned project directory.
//!
//! Enable/disable state lives in `config.skills.disabled` (keys formatted by
//! [`disabled_key`]), never in the skill files themselves — a UI toggle must
//! not rewrite user-authored markdown.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

/// `skill_load` never returns more than this many bytes of body.
pub const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_NAME_LEN: usize = 48;

/// The entry file of a directory-packaged skill (`<dir>/<name>/SKILL.md`).
const PACKAGE_ENTRY: &str = "SKILL.md";

/// How many support files `skill_load` will name back to the agent. A skill
/// that ships hundreds of references (some published ones ship 400+) must not
/// turn one `skill_load` into a wall of paths.
const MAX_LISTED_FILES: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillScope {
    Global,
    Project,
}

impl SkillScope {
    pub fn as_str(self) -> &'static str {
        match self {
            SkillScope::Global => "global",
            SkillScope::Project => "project",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub scope: SkillScope,
    /// Absolute path, for the UI. For a packaged skill this is its `SKILL.md`.
    pub path: String,
    /// Set only for a directory-packaged skill: the package root that its
    /// support files resolve against. `None` for a plain `<name>.md`, which is
    /// what keeps a flat skill from ever exposing the whole skills directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    /// Derived from `SkillsConfig.disabled`; always false for broken files.
    pub enabled: bool,
    /// Parse problem, if any. Broken files stay listed so the UI can show
    /// them, but they are excluded from the prompt index and `skill_load`.
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Frontmatter {
    pub name: String,
    pub description: String,
}

/// The key stored in `config.skills.disabled`: `"global:foo"` / `"project:foo"`.
pub fn disabled_key(scope: SkillScope, name: &str) -> String {
    format!("{}:{}", scope.as_str(), name)
}

/// `~/.cali/skills`. Created lazily on first write, never on read.
///
/// `CALI_SKILLS_DIR` overrides it for the same reason `CALI_PROJECTS_DIR`
/// exists: a test run must not read (or seed) the user's real `~/.cali`.
pub fn global_skills_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CALI_SKILLS_DIR") {
        return crate::config::expand_tilde(&dir.to_string_lossy());
    }
    crate::config::expand_tilde("~/.cali/skills")
}

/// Project skills dir per the `game_file_base` rule; None when the project
/// JSON can't be read.
///
/// This intentionally mirrors `tools::game_file_base` (private to tools.rs):
/// `workspaceRoot` when attached and present on disk, else the store-owned
/// project directory.
pub fn project_skills_dir(projects_root: &Path, slug: &str) -> Option<PathBuf> {
    let project = crate::store::read_project(projects_root, slug).ok()?;
    let attached = project
        .get("workspaceRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir());
    let base = match attached {
        Some(base) => base,
        None => crate::store::project_dir(projects_root, slug).ok()?,
    };
    Some(base.join(".cali").join("skills"))
}

/// Split the leading `---` frontmatter block off a skill file and validate it.
///
/// Errors on missing/unterminated frontmatter, YAML that does not deserialize
/// into `{ name, description }`, an empty or overlong name, or a name outside
/// `[A-Za-z0-9_-]`.
pub fn parse_skill(text: &str) -> Result<(Frontmatter, String)> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let rest = text
        .strip_prefix("---")
        .context("missing frontmatter: file must start with ---")?;
    let rest = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
        .context("missing frontmatter: file must start with --- on its own line")?;

    // Find the closing `---` on its own line (not a longer dash run).
    let mut search_from = 0usize;
    let (front, body) = loop {
        let found = rest[search_from..]
            .find("\n---")
            .map(|offset| search_from + offset)
            .context("unterminated frontmatter: no closing ---")?;
        let after = &rest[found + 4..];
        if after.is_empty() {
            break (&rest[..found], "");
        }
        if let Some(stripped) = after
            .strip_prefix("\r\n")
            .or_else(|| after.strip_prefix('\n'))
        {
            break (&rest[..found], stripped);
        }
        search_from = found + 1;
    };

    let frontmatter: Frontmatter =
        serde_yaml::from_str(front).context("invalid frontmatter YAML")?;
    let name = frontmatter.name.trim().to_string();
    if name.is_empty() {
        bail!("frontmatter name must not be empty");
    }
    if name.len() > MAX_NAME_LEN {
        bail!("frontmatter name must be at most {MAX_NAME_LEN} characters");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        bail!("frontmatter name must match [A-Za-z0-9_-]");
    }
    // The prompt index is line-oriented; a multi-line description would let a
    // skill file inject arbitrary extra lines into the system prompt.
    let description = frontmatter
        .description
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if description.is_empty() {
        bail!("frontmatter description must not be empty");
    }
    Ok((Frontmatter { name, description }, body.to_string()))
}

/// Enumerate global + (optional) project skills, project shadowing global,
/// sorted by name. Applies the disabled list. Never errors: unreadable dirs
/// yield nothing, unparsable files yield `SkillInfo { error: Some(..) }`.
pub fn list_skills(
    projects_root: &Path,
    slug: Option<&str>,
    skills: &crate::config::SkillsConfig,
) -> Vec<SkillInfo> {
    let project_dir = slug.and_then(|slug| project_skills_dir(projects_root, slug));
    composed(
        &extra_skill_dirs(skills),
        &global_skills_dir(),
        project_dir.as_deref(),
        &skills.disabled,
    )
}

/// The configured external roots, tilde-expanded, in precedence order.
///
/// A root that does not exist is kept rather than filtered: `scan_dir` already
/// treats an unreadable directory as empty, and dropping it here would make a
/// skills folder created later invisible until restart.
pub fn extra_skill_dirs(skills: &crate::config::SkillsConfig) -> Vec<PathBuf> {
    // `CALI_SKILLS_DIR` means "this run is isolated" — the same reason it
    // exists for the global root. External roots are the developer's real
    // machine too, and a suite whose skill list depends on whether the person
    // running it happens to use Claude Code is not a suite.
    if std::env::var_os("CALI_SKILLS_DIR").is_some() {
        return Vec::new();
    }
    skills
        .extra_dirs
        .iter()
        .map(|dir| crate::config::expand_tilde(dir))
        .collect()
}

/// Full body of one enabled, valid skill (project scope preferred on a name
/// clash). A disabled name is disabled outright — the shadowed global skill
/// does not reappear when the project one is toggled off; one name, one
/// state, simpler mental model.
pub fn load_skill(
    projects_root: &Path,
    slug: Option<&str>,
    name: &str,
    skills: &crate::config::SkillsConfig,
) -> Result<(SkillInfo, String)> {
    let project_dir = slug.and_then(|slug| project_skills_dir(projects_root, slug));
    load_from_roots(
        &extra_skill_dirs(skills),
        &global_skills_dir(),
        project_dir.as_deref(),
        name,
        &skills.disabled,
    )
}

/// Support files a packaged skill ships, relative to its root and sorted.
/// Empty for a flat `<name>.md` skill, which has no package to walk.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFiles {
    pub files: Vec<String>,
    /// True when the package holds more than [`MAX_LISTED_FILES`]; the agent
    /// can still read an unlisted file by naming its path directly.
    pub truncated: bool,
}

/// Enumerate a packaged skill's support files, excluding its entry file.
pub fn list_skill_files(info: &SkillInfo) -> SkillFiles {
    let Some(dir) = info.dir.as_deref().map(Path::new) else {
        return SkillFiles::default();
    };
    let mut files = Vec::new();
    walk_support(dir, dir, 0, &mut files);
    files.sort();
    let truncated = files.len() > MAX_LISTED_FILES;
    files.truncate(MAX_LISTED_FILES);
    SkillFiles { files, truncated }
}

/// Depth is bounded because a skill package is user-supplied content and a
/// symlink loop inside one must not hang the scan.
fn walk_support(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
    const MAX_DEPTH: usize = 4;
    if depth > MAX_DEPTH || out.len() > MAX_LISTED_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        // Symlinks are not followed during the walk; a listed path still has
        // to survive the escape check in `load_skill_file` before it is read.
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            walk_support(root, &path, depth + 1, out);
        } else if meta.is_file() && path.file_name().is_some_and(|f| f != PACKAGE_ENTRY) {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// Read one support file from inside a packaged skill.
///
/// The skill must be enabled and packaged, and `rel` must resolve inside its
/// own directory — the same containment rule `scan_dir` applies, extended to
/// the sub-path so `references/../../../.ssh/id_rsa` cannot be reached.
pub fn load_skill_file(
    projects_root: &Path,
    slug: Option<&str>,
    name: &str,
    rel: &str,
    skills: &crate::config::SkillsConfig,
) -> Result<(SkillInfo, String)> {
    let project_dir = slug.and_then(|slug| project_skills_dir(projects_root, slug));
    load_file_from_roots(
        &extra_skill_dirs(skills),
        &global_skills_dir(),
        project_dir.as_deref(),
        name,
        rel,
        &skills.disabled,
    )
}

/// Test-only shorthand for the no-external-roots case, which is what most
/// of the scoping tests are about.
#[cfg(test)]
fn load_file_from_dirs(
    global: &Path,
    project: Option<&Path>,
    name: &str,
    rel: &str,
    disabled: &[String],
) -> Result<(SkillInfo, String)> {
    load_file_from_roots(&[], global, project, name, rel, disabled)
}

fn load_file_from_roots(
    extras: &[PathBuf],
    global: &Path,
    project: Option<&Path>,
    name: &str,
    rel: &str,
    disabled: &[String],
) -> Result<(SkillInfo, String)> {
    let (info, _) = load_from_roots(extras, global, project, name, disabled)?;
    let Some(dir) = info.dir.as_deref().map(Path::new) else {
        bail!("skill '{name}' is a single file and ships no support files");
    };
    let rel_path = Path::new(rel);
    if rel.trim().is_empty() || rel_path.is_absolute() {
        bail!("file must be a relative path inside the skill");
    }
    if rel_path
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        bail!("file must not escape the skill directory");
    }
    let target = dir.join(rel_path);
    let (Ok(real), Ok(real_dir)) = (target.canonicalize(), dir.canonicalize()) else {
        bail!("skill file not found: {rel}");
    };
    if !real.starts_with(&real_dir) || !real.is_file() {
        bail!("skill file not found: {rel}");
    }
    let text =
        std::fs::read_to_string(&real).with_context(|| format!("cannot read skill file {rel}"))?;
    Ok((info, truncate_body(text)))
}

/// Compact system-prompt index of enabled skills; `""` when there are none.
pub fn prompt_index(
    projects_root: &Path,
    slug: Option<&str>,
    skills: &crate::config::SkillsConfig,
) -> String {
    render_index(&list_skills(projects_root, slug, skills))
}

fn render_index(skills: &[SkillInfo]) -> String {
    let usable: Vec<&SkillInfo> = skills
        .iter()
        .filter(|skill| skill.enabled && skill.error.is_none())
        .collect();
    if usable.is_empty() {
        return String::new();
    }
    let mut index = String::from(
        "\n\nSkills available via the skill_load tool (pass a name to get the full instructions):",
    );
    for skill in usable {
        index.push_str(&format!("\n- {}: {}", skill.name, skill.description));
    }
    index
}

/// Test-only shorthand for the no-external-roots case, which is what most
/// of the scoping tests are about.
#[cfg(test)]
fn list_from_dirs(global: &Path, project: Option<&Path>, disabled: &[String]) -> Vec<SkillInfo> {
    list_from_roots(&[], global, project, disabled)
}

/// As `list_from_dirs`, plus external roots that rank below `~/.cali/skills`.
///
/// External roots are absorbed in reverse so that, with later scans winning,
/// the *first* configured root takes a name clash — `caliber-skill` exists
/// under both `~/.claude` and `~/.codex`, and the order in the config is what
/// should decide. A clash across roots resolves silently; only a duplicate
/// *within* one directory is worth reporting as a broken row, because that one
/// is a mistake rather than a choice.
fn list_from_roots(
    extras: &[PathBuf],
    global: &Path,
    project: Option<&Path>,
    disabled: &[String],
) -> Vec<SkillInfo> {
    let mut valid: BTreeMap<String, SkillInfo> = BTreeMap::new();
    let mut broken: Vec<SkillInfo> = Vec::new();
    let mut absorb = |infos: Vec<SkillInfo>| {
        for info in infos {
            if info.error.is_some() {
                broken.push(info);
            } else {
                // Within one scan the first file wins (duplicates arrive as
                // error entries); across scopes, project overwrites global.
                valid.insert(info.name.clone(), info);
            }
        }
    };
    for extra in extras.iter().rev() {
        absorb(scan_dir(extra, SkillScope::Global));
    }
    absorb(scan_dir(global, SkillScope::Global));
    if let Some(project) = project {
        absorb(scan_dir(project, SkillScope::Project));
    }
    let mut out: Vec<SkillInfo> = valid
        .into_values()
        .map(|mut info| {
            info.enabled = !disabled.contains(&disabled_key(info.scope, &info.name));
            info
        })
        .collect();
    out.extend(broken);
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.path.cmp(&b.path)));
    out
}

/// Test-only shorthand for the no-external-roots case, which is what most
/// of the scoping tests are about.
#[cfg(test)]
fn load_from_dirs(
    global: &Path,
    project: Option<&Path>,
    name: &str,
    disabled: &[String],
) -> Result<(SkillInfo, String)> {
    load_from_roots(&[], global, project, name, disabled)
}

fn load_from_roots(
    extras: &[PathBuf],
    global: &Path,
    project: Option<&Path>,
    name: &str,
    disabled: &[String],
) -> Result<(SkillInfo, String)> {
    let all = composed(extras, global, project, disabled);
    let Some(info) = all
        .iter()
        .find(|skill| skill.name == name && skill.error.is_none())
    else {
        if let Some(bad) = all.iter().find(|skill| skill.name == name) {
            bail!(
                "skill invalid: {}",
                bad.error.as_deref().unwrap_or("unparsable")
            );
        }
        bail!("skill not found: {name}");
    };
    if !info.enabled {
        bail!("skill disabled: {name}");
    }
    let text = if info.path == BUILTIN_PATH {
        builtin_body(name).context("built-in skill vanished between list and load")?
    } else {
        std::fs::read_to_string(&info.path)
            .with_context(|| format!("cannot read skill file {}", info.path))?
    };
    let (_, body) = parse_skill(&text)?;
    Ok((info.clone(), truncate_body(body)))
}

fn truncate_body(mut body: String) -> String {
    if body.len() <= MAX_BODY_BYTES {
        return body;
    }
    let mut end = MAX_BODY_BYTES;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    body.truncate(end);
    body.push_str("\n[truncated]");
    body
}

/// Scan one directory for skills in either supported layout:
///
/// - `<dir>/<name>.md` — a single self-contained file.
/// - `<dir>/<name>/SKILL.md` — a package whose sibling files (`references/`,
///   `scripts/`, …) load on demand through [`load_skill_file`]. This is the
///   layout the wider agent-skill ecosystem publishes, and the reason skills
///   that orchestrate via "load references/foo.md" work here at all.
///
/// Only the package root is scanned for an entry file; a nested `SKILL.md`
/// under `references/` is support content, not a second skill.
///
/// Missing/unreadable dirs yield an empty vec. Symlinks that escape the
/// directory are skipped — project skill dirs can live inside user repos, and
/// a symlinked "skill" pointing at `~/.ssh` must not become readable through
/// `skill_load`.
/// Skills that ship with core, in the same markdown-plus-frontmatter format a
/// user would write.
///
/// These exist to keep prose out of `STATIC_SYSTEM_PROMPT`. Instructions that
/// only a fraction of turns can act on — the goal-tier quality loop is 673
/// tokens and a one-line fix can do nothing with it — cost every turn of every
/// session when they live in the prompt, and cost only their description here.
/// That is exactly the trade `skill_load` exists to make; the authorship being
/// ours rather than the user's changes nothing about it.
const BUILTIN_SKILLS: &[&str] = &[include_str!("../skills/goal-loop.md")];

/// Marker in [`SkillInfo::path`] for a compiled-in skill, so `load_from_roots`
/// serves the body from the binary instead of trying to read it off disk.
/// Angle brackets keep it from ever colliding with a real path.
const BUILTIN_PATH: &str = "<built-in>";

/// Directory skills plus the built-ins no directory skill shadows.
///
/// Merged here rather than inside [`list_from_roots`] on purpose: that
/// function answers "how do the configured directories rank against each
/// other", and its tests are about exactly that. Salting every one of them
/// with a built-in row would make them assert less about what they exist to
/// pin. A user file always wins — writing `goal-loop.md` replaces ours.
fn composed(
    extras: &[PathBuf],
    global: &Path,
    project: Option<&Path>,
    disabled: &[String],
) -> Vec<SkillInfo> {
    let mut out = list_from_roots(extras, global, project, disabled);
    let taken: HashSet<String> = out.iter().map(|skill| skill.name.clone()).collect();
    for mut builtin in builtin_skills() {
        if taken.contains(&builtin.name) {
            continue;
        }
        builtin.enabled = !disabled.contains(&disabled_key(builtin.scope, &builtin.name));
        out.push(builtin);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.path.cmp(&b.path)));
    out
}

fn builtin_skills() -> Vec<SkillInfo> {
    BUILTIN_SKILLS
        .iter()
        .filter_map(|text| {
            // A malformed built-in is our bug, not the user's, and
            // `builtins_parse` fails the build before it can ship. Skipping
            // here rather than panicking keeps one bad entry from taking down
            // every session's prompt.
            let (front, _) = parse_skill(text).ok()?;
            Some(SkillInfo {
                name: front.name,
                description: front.description,
                scope: SkillScope::Global,
                path: BUILTIN_PATH.to_string(),
                dir: None,
                enabled: true,
                error: None,
            })
        })
        .collect()
}

/// The compiled-in body for a built-in skill name, if it is one.
fn builtin_body(name: &str) -> Option<String> {
    BUILTIN_SKILLS.iter().find_map(|text| {
        let (front, _) = parse_skill(text).ok()?;
        (front.name == name).then(|| (*text).to_string())
    })
}

fn scan_dir(dir: &Path, scope: SkillScope) -> Vec<SkillInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let Ok(canonical_dir) = dir.canonicalize() else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter_map(|path| {
            if path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            {
                return Some(path);
            }
            // A directory counts only when it actually holds an entry file, so
            // an unrelated folder in the skills dir stays silently ignored
            // rather than being listed as a broken skill.
            let entry_file = path.join(PACKAGE_ENTRY);
            entry_file.is_file().then_some(entry_file)
        })
        .collect();
    files.sort();

    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for path in files {
        let Ok(real) = path.canonicalize() else {
            continue;
        };
        if !real.starts_with(&canonical_dir) {
            tracing::warn!(path = %path.display(), "skipping skill symlinked outside its directory");
            continue;
        }
        if !real.is_file() {
            continue;
        }
        // A package's identity is its folder, so a broken `foo/SKILL.md` is
        // reported as "foo" rather than as "SKILL".
        let packaged = path.file_name().is_some_and(|file| file == PACKAGE_ENTRY);
        let package_dir = packaged.then(|| path.parent()).flatten();
        let stem = package_dir
            .or(Some(path.as_path()))
            .and_then(|source| source.file_stem())
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
        let dir = package_dir.map(|dir| dir.display().to_string());
        let path_string = path.display().to_string();
        let info = match std::fs::read_to_string(&path)
            .map_err(anyhow::Error::from)
            .and_then(|text| parse_skill(&text))
        {
            Ok((frontmatter, _)) => {
                if seen.insert(frontmatter.name.clone()) {
                    SkillInfo {
                        name: frontmatter.name,
                        description: frontmatter.description,
                        scope,
                        path: path_string,
                        dir,
                        enabled: true,
                        error: None,
                    }
                } else {
                    SkillInfo {
                        name: frontmatter.name.clone(),
                        description: frontmatter.description,
                        scope,
                        path: path_string,
                        dir,
                        enabled: false,
                        error: Some(format!(
                            "duplicate skill name '{}' in this scope",
                            frontmatter.name
                        )),
                    }
                }
            }
            Err(error) => SkillInfo {
                name: stem,
                description: String::new(),
                scope,
                path: path_string,
                dir,
                enabled: false,
                error: Some(error.to_string()),
            },
        };
        out.push(info);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(dir: &Path, file: &str, name: &str, description: &str, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join(file),
            format!("---\nname: {name}\ndescription: {description}\n---\n{body}"),
        )
        .unwrap();
    }

    /// Every built-in must parse, or it would be silently dropped from every
    /// session's prompt with no failing test to say so.
    #[test]
    fn builtins_parse_and_goal_loop_is_one_of_them() {
        let names: Vec<String> = builtin_skills().into_iter().map(|s| s.name).collect();
        assert_eq!(
            names.len(),
            BUILTIN_SKILLS.len(),
            "a built-in failed to parse: {names:?}"
        );
        assert!(names.iter().any(|name| name == "goal-loop"));
    }

    /// The point of the built-in: it reaches the prompt as a description and
    /// its body only through `skill_load`. A regression that inlined the body
    /// would put 673 tokens back into every turn.
    #[test]
    fn a_builtin_is_listed_and_loadable_without_any_skills_directory() {
        let global = tempfile::tempdir().unwrap();
        let listed = composed(&[], global.path(), None, &[]);
        let goal = listed
            .iter()
            .find(|skill| skill.name == "goal-loop")
            .expect("goal-loop is available with no skills dir at all");
        assert_eq!(goal.path, BUILTIN_PATH);
        assert!(goal.enabled && goal.error.is_none());

        let (info, body) = load_from_roots(&[], global.path(), None, "goal-loop", &[]).unwrap();
        assert_eq!(info.name, "goal-loop");
        assert!(body.contains("NAME THE BAR"), "body served from the binary");
        // The description carries the trigger, since that line alone decides
        // whether a later turn opens the body.
        assert!(goal.description.contains("GOAL"));

        let index = render_index(&listed);
        assert!(index.contains("goal-loop"));
        assert!(
            !index.contains("NAME THE BAR"),
            "the index must carry descriptions only, never the body"
        );
    }

    #[test]
    fn a_user_file_shadows_the_builtin_of_the_same_name() {
        let global = tempfile::tempdir().unwrap();
        write_skill(
            global.path(),
            "goal-loop.md",
            "goal-loop",
            "mine",
            "my body",
        );

        let listed = composed(&[], global.path(), None, &[]);
        let matches: Vec<&SkillInfo> = listed
            .iter()
            .filter(|skill| skill.name == "goal-loop")
            .collect();
        assert_eq!(matches.len(), 1, "shadowed, not duplicated");
        assert_eq!(matches[0].description, "mine");
        assert_ne!(matches[0].path, BUILTIN_PATH);

        let (_, body) = load_from_roots(&[], global.path(), None, "goal-loop", &[]).unwrap();
        assert_eq!(body, "my body");
    }

    #[test]
    fn a_builtin_can_be_disabled_like_any_other_skill() {
        let global = tempfile::tempdir().unwrap();
        let disabled = vec![disabled_key(SkillScope::Global, "goal-loop")];

        let listed = composed(&[], global.path(), None, &disabled);
        let goal = listed.iter().find(|s| s.name == "goal-loop").unwrap();
        assert!(!goal.enabled);
        assert!(!render_index(&listed).contains("goal-loop"));
        assert!(load_from_roots(&[], global.path(), None, "goal-loop", &disabled).is_err());
    }

    #[test]
    fn parse_skill_splits_frontmatter_and_preserves_body() {
        let (frontmatter, body) = parse_skill(
            "---\nname: blockout-standards\ndescription: How to blockout\n---\n# Title\n\nBody with --- dashes inline.\n",
        )
        .unwrap();
        assert_eq!(frontmatter.name, "blockout-standards");
        assert_eq!(frontmatter.description, "How to blockout");
        assert_eq!(body, "# Title\n\nBody with --- dashes inline.\n");
    }

    #[test]
    fn parse_skill_handles_crlf_and_empty_body() {
        let (frontmatter, body) =
            parse_skill("---\r\nname: a\r\ndescription: d\r\n---\r\nbody").unwrap();
        assert_eq!(frontmatter.name, "a");
        assert_eq!(body, "body");
        let (_, body) = parse_skill("---\nname: a\ndescription: d\n---").unwrap();
        assert_eq!(body, "");
    }

    #[test]
    fn parse_skill_rejects_bad_input() {
        assert!(parse_skill("no frontmatter at all").is_err());
        assert!(parse_skill("---\nname: a\ndescription: d\n").is_err()); // unterminated
        assert!(parse_skill("---\nname: 'bad name!'\ndescription: d\n---\n").is_err());
        assert!(parse_skill("---\nname: ''\ndescription: d\n---\n").is_err());
        assert!(parse_skill(&format!(
            "---\nname: {}\ndescription: d\n---\n",
            "x".repeat(MAX_NAME_LEN + 1)
        ))
        .is_err());
        assert!(parse_skill("---\ndescription: d\n---\n").is_err()); // missing name
        assert!(parse_skill("---\nname: a\n---\n").is_err()); // missing description
    }

    #[test]
    fn multiline_description_keeps_only_the_first_line() {
        let (frontmatter, _) =
            parse_skill("---\nname: a\ndescription: |\n  first line\n  injected line\n---\n")
                .unwrap();
        assert_eq!(frontmatter.description, "first line");
    }

    /// `<dir>/<name>/SKILL.md` plus a support file, the layout most published
    /// agent-skill packages ship in.
    fn write_package(dir: &Path, folder: &str, name: &str, description: &str, body: &str) {
        let root = dir.join(folder);
        write_skill(&root, PACKAGE_ENTRY, name, description, body);
    }

    #[test]
    fn packaged_and_flat_skills_are_both_discovered() {
        let global = tempfile::tempdir().unwrap();
        write_skill(global.path(), "flat.md", "flat-one", "a flat skill", "F");
        write_package(
            global.path(),
            "threejs-game-director",
            "threejs-game-director",
            "orchestrates a build",
            "load references/phase-playbook.md",
        );
        // A folder with no entry file is not a skill and must not be listed.
        std::fs::create_dir_all(global.path().join("not-a-skill")).unwrap();

        let skills = list_from_dirs(global.path(), None, &[]);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["flat-one", "threejs-game-director"]);

        let packaged = skills.iter().find(|s| s.name == "threejs-game-director");
        assert!(packaged.unwrap().dir.is_some(), "package exposes its root");
        let flat = skills.iter().find(|s| s.name == "flat-one").unwrap();
        assert!(flat.dir.is_none(), "a flat skill must not expose a dir");
    }

    #[test]
    fn support_files_list_and_load_from_inside_the_package() {
        let global = tempfile::tempdir().unwrap();
        write_package(global.path(), "director", "director", "d", "body");
        let refs = global.path().join("director").join("references");
        std::fs::create_dir_all(&refs).unwrap();
        std::fs::write(refs.join("game-feel.md"), "# Game feel\nhitstop").unwrap();

        let skills = list_from_dirs(global.path(), None, &[]);
        let info = skills.iter().find(|s| s.name == "director").unwrap();
        let listed = list_skill_files(info);
        assert_eq!(listed.files, vec!["references/game-feel.md"]);
        assert!(!listed.truncated);
        // The entry file is the instructions, not a support file.
        assert!(!listed.files.iter().any(|f| f == PACKAGE_ENTRY));

        let (_, contents) = load_file_from_dirs(
            global.path(),
            None,
            "director",
            "references/game-feel.md",
            &[],
        )
        .unwrap();
        assert!(contents.contains("hitstop"));
    }

    #[test]
    fn support_file_reads_cannot_escape_the_package() {
        let global = tempfile::tempdir().unwrap();
        write_package(global.path(), "director", "director", "d", "body");
        write_skill(global.path(), "other.md", "other", "sibling", "SECRET");

        for attempt in [
            "../other.md",
            "references/../../other.md",
            "/etc/passwd",
            "",
        ] {
            let result = load_file_from_dirs(global.path(), None, "director", attempt, &[]);
            assert!(result.is_err(), "{attempt} must be rejected");
        }
    }

    #[test]
    fn flat_skill_has_no_support_files() {
        let global = tempfile::tempdir().unwrap();
        write_skill(global.path(), "flat.md", "flat-one", "d", "body");
        let skills = list_from_dirs(global.path(), None, &[]);
        let info = skills.iter().find(|s| s.name == "flat-one").unwrap();
        assert!(list_skill_files(info).files.is_empty());
        assert!(load_file_from_dirs(global.path(), None, "flat-one", "a.md", &[]).is_err());
    }

    #[test]
    fn broken_package_is_named_after_its_folder() {
        let global = tempfile::tempdir().unwrap();
        let root = global.path().join("threejs-shaders");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(PACKAGE_ENTRY), "no frontmatter here").unwrap();

        let skills = list_from_dirs(global.path(), None, &[]);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "threejs-shaders");
        assert!(skills[0].error.is_some());
    }

    #[test]
    fn external_roots_are_read_but_rank_below_the_global_dir() {
        let claude = tempfile::tempdir().unwrap();
        let codex = tempfile::tempdir().unwrap();
        let global = tempfile::tempdir().unwrap();
        write_package(claude.path(), "fusion", "fusion", "from claude", "C");
        write_package(claude.path(), "caliber", "caliber", "claude copy", "C");
        write_package(codex.path(), "caliber", "caliber", "codex copy", "X");
        write_package(codex.path(), "watch", "watch", "from codex", "X");
        write_skill(global.path(), "fusion.md", "fusion", "mine wins", "G");

        let extras = vec![claude.path().to_path_buf(), codex.path().to_path_buf()];
        let skills = list_from_roots(&extras, global.path(), None, &[]);
        let by_name: BTreeMap<&str, &SkillInfo> =
            skills.iter().map(|s| (s.name.as_str(), s)).collect();

        assert_eq!(
            by_name.keys().copied().collect::<Vec<_>>(),
            vec!["caliber", "fusion", "watch"]
        );
        // ~/.cali/skills outranks every external root.
        assert_eq!(by_name["fusion"].description, "mine wins");
        // Earlier root wins a clash between two external roots.
        assert_eq!(by_name["caliber"].description, "claude copy");
        // A clash across roots is a choice, not a mistake: no broken rows.
        assert!(skills.iter().all(|s| s.error.is_none()));
    }

    #[test]
    fn a_missing_external_root_is_simply_empty() {
        let global = tempfile::tempdir().unwrap();
        write_skill(global.path(), "a.md", "mine", "d", "G");
        let extras = vec![PathBuf::from("/nope/does/not/exist")];

        let skills = list_from_roots(&extras, global.path(), None, &[]);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "mine");
    }

    #[test]
    fn an_external_skill_loads_its_body_and_support_files() {
        let claude = tempfile::tempdir().unwrap();
        let global = tempfile::tempdir().unwrap();
        write_package(claude.path(), "fusion", "fusion", "d", "panel of models");
        let refs = claude.path().join("fusion").join("references");
        std::fs::create_dir_all(&refs).unwrap();
        std::fs::write(refs.join("panel.md"), "judge prompt").unwrap();

        let extras = vec![claude.path().to_path_buf()];
        let (info, body) = load_from_roots(&extras, global.path(), None, "fusion", &[]).unwrap();
        assert!(body.contains("panel of models"));
        assert_eq!(list_skill_files(&info).files, vec!["references/panel.md"]);

        let (_, contents) = load_file_from_roots(
            &extras,
            global.path(),
            None,
            "fusion",
            "references/panel.md",
            &[],
        )
        .unwrap();
        assert_eq!(contents, "judge prompt");
    }

    #[test]
    fn default_roots_are_the_conventional_harness_dirs() {
        // A config file with no `skills:` block must still see them, so the
        // serde default and the Rust default have to agree.
        let from_rust = crate::config::SkillsConfig::default();
        let from_yaml: crate::config::AppConfig =
            serde_yaml::from_str("model:\n  default: m\n").expect("config without a skills block");
        assert_eq!(from_rust.extra_dirs, from_yaml.skills.extra_dirs);
        assert!(from_rust.extra_dirs.iter().any(|d| d.contains(".claude")));

        // And an explicit empty list opts out rather than re-seeding.
        let opted_out: crate::config::AppConfig =
            serde_yaml::from_str("model:\n  default: m\nskills:\n  extra_dirs: []\n").unwrap();
        assert!(opted_out.skills.extra_dirs.is_empty());
    }

    #[test]
    fn project_shadows_global_and_disabled_filters() {
        let global = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        write_skill(global.path(), "a.md", "shared", "global version", "G");
        write_skill(global.path(), "b.md", "only-global", "global only", "G");
        write_skill(project.path(), "a.md", "shared", "project version", "P");
        write_skill(project.path(), "c.md", "only-project", "project only", "P");

        let skills = list_from_dirs(global.path(), Some(project.path()), &[]);
        let names: Vec<(&str, SkillScope)> =
            skills.iter().map(|s| (s.name.as_str(), s.scope)).collect();
        assert_eq!(
            names,
            vec![
                ("only-global", SkillScope::Global),
                ("only-project", SkillScope::Project),
                ("shared", SkillScope::Project),
            ]
        );
        assert!(skills.iter().all(|s| s.enabled));

        // Disabling the winning project skill hides the name entirely: the
        // global one stays shadowed rather than silently reappearing.
        let disabled = vec!["project:shared".to_string()];
        let skills = list_from_dirs(global.path(), Some(project.path()), &disabled);
        let shared: Vec<&SkillInfo> = skills.iter().filter(|s| s.name == "shared").collect();
        assert_eq!(shared.len(), 1);
        assert_eq!(shared[0].scope, SkillScope::Project);
        assert!(!shared[0].enabled);
        let err = load_from_dirs(global.path(), Some(project.path()), "shared", &disabled)
            .unwrap_err()
            .to_string();
        assert!(err.contains("skill disabled"), "{err}");

        // A "global:shared" key does nothing while the project skill wins.
        let disabled = vec!["global:shared".to_string()];
        let (info, body) =
            load_from_dirs(global.path(), Some(project.path()), "shared", &disabled).unwrap();
        assert_eq!(info.scope, SkillScope::Project);
        assert_eq!(body, "P");
    }

    #[test]
    fn broken_files_are_listed_with_error_but_unloadable() {
        let global = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(global.path()).unwrap();
        std::fs::write(global.path().join("broken.md"), "no frontmatter here").unwrap();
        write_skill(global.path(), "good.md", "good", "fine", "body");

        let skills = list_from_dirs(global.path(), None, &[]);
        assert_eq!(skills.len(), 2);
        let broken = skills.iter().find(|s| s.name == "broken").unwrap();
        assert!(!broken.enabled);
        assert!(broken.error.is_some());

        let err = load_from_dirs(global.path(), None, "broken", &[])
            .unwrap_err()
            .to_string();
        assert!(err.contains("skill invalid"), "{err}");
        assert!(load_from_dirs(global.path(), None, "missing", &[])
            .unwrap_err()
            .to_string()
            .contains("skill not found"));
    }

    #[test]
    fn duplicate_names_within_a_scope_keep_the_first_file() {
        let global = tempfile::tempdir().unwrap();
        write_skill(global.path(), "a.md", "dupe", "first", "first body");
        write_skill(global.path(), "b.md", "dupe", "second", "second body");

        let skills = list_from_dirs(global.path(), None, &[]);
        let winners: Vec<&SkillInfo> = skills.iter().filter(|s| s.error.is_none()).collect();
        assert_eq!(winners.len(), 1);
        assert_eq!(winners[0].description, "first");
        assert!(skills
            .iter()
            .any(|s| s.error.as_deref().is_some_and(|e| e.contains("duplicate"))));
        let (_, body) = load_from_dirs(global.path(), None, "dupe", &[]).unwrap();
        assert_eq!(body, "first body");
    }

    #[test]
    fn prompt_index_is_empty_without_usable_skills() {
        let global = tempfile::tempdir().unwrap();
        assert_eq!(render_index(&list_from_dirs(global.path(), None, &[])), "");

        std::fs::create_dir_all(global.path()).unwrap();
        std::fs::write(global.path().join("broken.md"), "junk").unwrap();
        write_skill(global.path(), "off.md", "off", "disabled one", "b");
        let disabled = vec!["global:off".to_string()];
        let index = render_index(&list_from_dirs(global.path(), None, &disabled));
        assert_eq!(index, "");
    }

    #[test]
    fn prompt_index_lists_enabled_skills_one_per_line() {
        let global = tempfile::tempdir().unwrap();
        write_skill(global.path(), "a.md", "alpha", "does alpha things", "b");
        write_skill(global.path(), "b.md", "beta", "does beta things", "b");
        let index = render_index(&list_from_dirs(global.path(), None, &[]));
        assert!(index.starts_with("\n\nSkills available via the skill_load tool"));
        assert!(index.contains("\n- alpha: does alpha things"));
        assert!(index.contains("\n- beta: does beta things"));
    }

    #[test]
    fn load_skill_truncates_oversized_bodies() {
        let global = tempfile::tempdir().unwrap();
        let big = "x".repeat(MAX_BODY_BYTES + 100);
        write_skill(global.path(), "big.md", "big", "huge body", &big);
        let (_, body) = load_from_dirs(global.path(), None, "big", &[]).unwrap();
        assert!(body.ends_with("\n[truncated]"));
        assert!(body.len() <= MAX_BODY_BYTES + "\n[truncated]".len());
    }

    #[test]
    fn symlinked_skills_escaping_the_dir_are_skipped() {
        let global = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.md");
        std::fs::write(&secret, "---\nname: sneaky\ndescription: d\n---\nsecret").unwrap();
        std::fs::create_dir_all(global.path()).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&secret, global.path().join("link.md")).unwrap();
            let skills = list_from_dirs(global.path(), None, &[]);
            assert!(skills.is_empty(), "{skills:?}");
        }
    }

    #[test]
    fn project_skills_dir_follows_the_game_file_base_rule() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();

        // Store-only project: under the project directory.
        let dir = project_skills_dir(root.path(), "demo").unwrap();
        assert_eq!(
            dir,
            crate::store::project_dir(root.path(), "demo")
                .unwrap()
                .join(".cali")
                .join("skills")
        );

        // Attached workspace: under the workspace root.
        let workspace = tempfile::tempdir().unwrap();
        crate::store::set_workspace_root(
            root.path(),
            "demo",
            Some(workspace.path().to_str().unwrap()),
        )
        .unwrap();
        let dir = project_skills_dir(root.path(), "demo").unwrap();
        assert_eq!(dir, workspace.path().join(".cali").join("skills"));

        // Unknown project: None, not an error.
        assert!(project_skills_dir(root.path(), "nope").is_none());
    }

    #[test]
    fn disabled_key_formats_scope_and_name() {
        assert_eq!(disabled_key(SkillScope::Global, "foo"), "global:foo");
        assert_eq!(disabled_key(SkillScope::Project, "bar"), "project:bar");
    }
}
