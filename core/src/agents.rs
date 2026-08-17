//! File-defined subagents: a markdown file whose body is a system prompt.
//!
//! The fourth use of the pattern `skills.rs` established, and the one that
//! removes a hardcoded list. `subagent_spawn` has always taken `role` as a
//! free string, but the composer only ever offered four —
//! `planner | coder | tester | critic`, spelled out in `slashCommands.ts` —
//! so the flexibility core already had was unreachable from the UI.
//!
//! What a definition adds over a bare role name:
//!
//! - **A body that becomes the child's system prompt**, instead of the generic
//!   "you are a {role} subagent" sentence. This is the whole point: a reviewer
//!   that knows this project's conventions is worth more than one told it is a
//!   reviewer.
//! - **An optional `tools:` allowlist**, which narrows what the child may call.
//!   A reviewer defined with `tools: [file_read, file_grep]` cannot write, and
//!   that is enforced by giving it a smaller tool set rather than by asking it
//!   nicely in the prompt.
//!
//! An agent may not take a built-in role's name: those four still work with no
//! file at all, and a definition that shadowed one would make the same word
//! mean two things depending on a directory listing.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// A system prompt past this is a document. The child pays for it on every
/// turn it takes, so the cap is deliberately tighter than a skill's.
pub const MAX_BODY_BYTES: usize = 16 * 1024;

const MAX_NAME_LEN: usize = 48;

/// Roles that work without any file, and that a file may therefore not claim.
/// Mirrors `SUBAGENT_ROLES` in `client/src/lib/slashCommands.ts`.
pub const BUILTIN_ROLES: &[&str] = &["planner", "coder", "tester", "critic"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentScope {
    Global,
    Project,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub name: String,
    pub description: String,
    /// Empty means "everything the parent can reach".
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    pub scope: AgentScope,
    pub path: String,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Frontmatter {
    description: String,
    #[serde(default)]
    tools: Vec<String>,
}

/// `~/.cali/agents`. `CALI_AGENTS_DIR` isolates a test run.
pub fn global_agents_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CALI_AGENTS_DIR") {
        return crate::config::expand_tilde(&dir.to_string_lossy());
    }
    crate::config::expand_tilde("~/.cali/agents")
}

/// Project agents dir per the `game_file_base` rule; `None` when the project
/// JSON cannot be read. Mirrors `commands::project_commands_dir`.
pub fn project_agents_dir(projects_root: &Path, slug: &str) -> Option<PathBuf> {
    let project = crate::store::read_project(projects_root, slug).ok()?;
    let attached = project
        .get("workspaceRoot")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir());
    let base = match attached {
        Some(base) => base,
        None => crate::store::project_dir(projects_root, slug).ok()?,
    };
    Some(base.join(".cali").join("agents"))
}

fn parse_agent(text: &str) -> Result<(Frontmatter, String)> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let rest = text
        .strip_prefix("---")
        .context("missing frontmatter: file must start with ---")?;
    let rest = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
        .context("missing frontmatter: file must start with --- on its own line")?;

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
    if body.trim().is_empty() {
        bail!("agent body is empty — the body is this agent's system prompt");
    }
    if body.len() > MAX_BODY_BYTES {
        bail!(
            "agent body is {} bytes, over the {MAX_BODY_BYTES}-byte limit",
            body.len()
        );
    }
    let tools = frontmatter
        .tools
        .into_iter()
        .map(|tool| tool.trim().to_string())
        .filter(|tool| !tool.is_empty())
        .collect();
    Ok((Frontmatter { description, tools }, body.to_string()))
}

fn validate_name(raw: &str) -> Result<String> {
    let name = raw.trim().to_ascii_lowercase();
    if name.is_empty() {
        bail!("agent name must not be empty");
    }
    if name.len() > MAX_NAME_LEN {
        bail!("agent name must be at most {MAX_NAME_LEN} characters");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        bail!("agent name must match [A-Za-z0-9_-]");
    }
    Ok(name)
}

/// Every agent visible to `slug`, project shadowing global, sorted by name.
pub fn list_agents(projects_root: &Path, slug: Option<&str>) -> Vec<AgentInfo> {
    let project = slug.and_then(|slug| project_agents_dir(projects_root, slug));
    list_from_dirs(&global_agents_dir(), project.as_deref())
}

fn list_from_dirs(global: &Path, project: Option<&Path>) -> Vec<AgentInfo> {
    let mut valid: BTreeMap<String, AgentInfo> = BTreeMap::new();
    let mut broken: Vec<AgentInfo> = Vec::new();
    let mut absorb = |infos: Vec<AgentInfo>| {
        for info in infos {
            if info.error.is_some() {
                broken.push(info);
            } else {
                valid.insert(info.name.clone(), info);
            }
        }
    };
    absorb(scan_dir(global, AgentScope::Global));
    if let Some(project) = project {
        absorb(scan_dir(project, AgentScope::Project));
    }
    let mut out: Vec<AgentInfo> = valid.into_values().collect();
    out.extend(broken);
    out
}

fn scan_dir(dir: &Path, scope: AgentScope) -> Vec<AgentInfo> {
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
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        })
        .collect();
    files.sort();

    let mut out = Vec::new();
    for path in files {
        let Ok(real) = path.canonicalize() else {
            continue;
        };
        if !real.starts_with(&canonical_dir) {
            tracing::warn!(path = %path.display(), "skipping agent symlinked outside its directory");
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
        let parsed = validate_name(&stem).and_then(|name| {
            if BUILTIN_ROLES.contains(&name.as_str()) {
                bail!("'{name}' is a built-in role; rename this file");
            }
            let text = std::fs::read_to_string(&path)?;
            let (frontmatter, _) = parse_agent(&text)?;
            Ok((name, frontmatter))
        });
        out.push(match parsed {
            Ok((name, frontmatter)) => AgentInfo {
                name,
                description: frontmatter.description,
                tools: frontmatter.tools,
                scope,
                path: path_string,
                error: None,
            },
            Err(error) => AgentInfo {
                name: stem.to_ascii_lowercase(),
                description: String::new(),
                tools: Vec::new(),
                scope,
                path: path_string,
                error: Some(format!("{error:#}")),
            },
        });
    }
    out
}

/// One agent's definition and its system prompt, or `None` when no file
/// defines that name. `None` is the ordinary case — the four built-in roles
/// have no file — so this returns an option rather than an error.
pub fn load_agent(
    projects_root: &Path,
    slug: Option<&str>,
    name: &str,
) -> Option<(AgentInfo, String)> {
    let project = slug.and_then(|slug| project_agents_dir(projects_root, slug));
    load_from_dirs(&global_agents_dir(), project.as_deref(), name)
}

fn load_from_dirs(
    global: &Path,
    project: Option<&Path>,
    name: &str,
) -> Option<(AgentInfo, String)> {
    let name = validate_name(name).ok()?;
    let info = list_from_dirs(global, project)
        .into_iter()
        .find(|info| info.name == name && info.error.is_none())?;
    let text = std::fs::read_to_string(&info.path).ok()?;
    let (_, body) = parse_agent(&text).ok()?;
    Some((info, body.trim().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_agent(dir: &Path, file: &str, description: &str, tools: &str, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let tools_line = if tools.is_empty() {
            String::new()
        } else {
            format!("tools: [{tools}]\n")
        };
        std::fs::write(
            dir.join(file),
            format!("---\ndescription: {description}\n{tools_line}---\n\n{body}\n"),
        )
        .unwrap();
    }

    #[test]
    fn an_agent_file_becomes_a_named_definition_with_a_system_prompt() {
        let dir = tempfile::tempdir().unwrap();
        write_agent(
            dir.path(),
            "shader-critic.md",
            "Reviews shaders for banding and overdraw",
            "file_read, file_grep",
            "You review shaders. Never edit; report only.",
        );
        let listed = list_from_dirs(dir.path(), None);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "shader-critic");
        assert_eq!(listed[0].tools, vec!["file_read", "file_grep"]);

        let (info, body) = load_from_dirs(dir.path(), None, "shader-critic").unwrap();
        assert_eq!(info.description, "Reviews shaders for banding and overdraw");
        assert_eq!(body, "You review shaders. Never edit; report only.");
    }

    #[test]
    fn a_name_with_no_file_is_not_an_error() {
        // The four built-in roles have no file; asking for one must simply
        // report "not defined" so the caller falls back to the generic prompt.
        let dir = tempfile::tempdir().unwrap();
        assert!(load_from_dirs(dir.path(), None, "planner").is_none());
        assert!(load_from_dirs(dir.path(), None, "nobody").is_none());
    }

    #[test]
    fn a_file_may_not_claim_a_built_in_role() {
        let dir = tempfile::tempdir().unwrap();
        write_agent(dir.path(), "critic.md", "not the real one", "", "body");
        let listed = list_from_dirs(dir.path(), None);
        assert!(
            listed[0]
                .error
                .as_deref()
                .unwrap()
                .contains("built-in role"),
            "{:?}",
            listed[0].error
        );
        assert!(load_from_dirs(dir.path(), None, "critic").is_none());
    }

    #[test]
    fn an_empty_body_is_refused_because_the_body_is_the_prompt() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(
            dir.path().join("hollow.md"),
            "---\ndescription: d\n---\n\n  \n",
        )
        .unwrap();
        assert!(list_from_dirs(dir.path(), None)[0]
            .error
            .as_deref()
            .unwrap()
            .contains("body is empty"));
    }

    #[test]
    fn tools_default_to_everything_the_parent_can_reach() {
        let dir = tempfile::tempdir().unwrap();
        write_agent(dir.path(), "wide.md", "does anything", "", "body");
        assert!(list_from_dirs(dir.path(), None)[0].tools.is_empty());
    }

    #[test]
    fn project_scope_shadows_global() {
        let global = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        write_agent(global.path(), "critic2.md", "global", "", "global body");
        write_agent(project.path(), "critic2.md", "project", "", "project body");
        let (info, body) = load_from_dirs(global.path(), Some(project.path()), "critic2").unwrap();
        assert_eq!(info.description, "project");
        assert_eq!(body, "project body");
    }

    #[test]
    fn symlinked_agents_escaping_the_dir_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.md");
        std::fs::write(&secret, "---\ndescription: d\n---\n\nbody\n").unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&secret, dir.path().join("link.md")).unwrap();
            assert!(list_from_dirs(dir.path(), None).is_empty());
        }
    }
}
