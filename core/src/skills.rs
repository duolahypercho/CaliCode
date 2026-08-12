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
    /// Absolute path, for the UI.
    pub path: String,
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
    disabled: &[String],
) -> Vec<SkillInfo> {
    let project_dir = slug.and_then(|slug| project_skills_dir(projects_root, slug));
    list_from_dirs(&global_skills_dir(), project_dir.as_deref(), disabled)
}

/// Full body of one enabled, valid skill (project scope preferred on a name
/// clash). A disabled name is disabled outright — the shadowed global skill
/// does not reappear when the project one is toggled off; one name, one
/// state, simpler mental model.
pub fn load_skill(
    projects_root: &Path,
    slug: Option<&str>,
    name: &str,
    disabled: &[String],
) -> Result<(SkillInfo, String)> {
    let project_dir = slug.and_then(|slug| project_skills_dir(projects_root, slug));
    load_from_dirs(&global_skills_dir(), project_dir.as_deref(), name, disabled)
}

/// Compact system-prompt index of enabled skills; `""` when there are none.
pub fn prompt_index(projects_root: &Path, slug: Option<&str>, disabled: &[String]) -> String {
    render_index(&list_skills(projects_root, slug, disabled))
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

fn list_from_dirs(global: &Path, project: Option<&Path>, disabled: &[String]) -> Vec<SkillInfo> {
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

fn load_from_dirs(
    global: &Path,
    project: Option<&Path>,
    name: &str,
    disabled: &[String],
) -> Result<(SkillInfo, String)> {
    let all = list_from_dirs(global, project, disabled);
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
    let text = std::fs::read_to_string(&info.path)
        .with_context(|| format!("cannot read skill file {}", info.path))?;
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

/// Scan one directory for `*.md` skills. Missing/unreadable dirs yield an
/// empty vec. Symlinks that escape the directory are skipped — project skill
/// dirs can live inside user repos, and a symlinked "skill" pointing at
/// `~/.ssh` must not become readable through `skill_load`.
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
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("md"))
                .unwrap_or(false)
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
        let stem = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
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
                        enabled: true,
                        error: None,
                    }
                } else {
                    SkillInfo {
                        name: frontmatter.name.clone(),
                        description: frontmatter.description,
                        scope,
                        path: path_string,
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
