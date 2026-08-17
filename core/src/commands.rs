//! File-defined slash commands: a markdown file whose body is a prompt.
//!
//! The third use of the pattern `skills.rs` established — frontmatter, a scan
//! that refuses symlink escapes, project scope shadowing global, and a listing
//! that carries descriptions rather than bodies. What differs is what the body
//! *is*: a skill is instructions the agent pulls in mid-task through
//! `skill_load`, while a command is a prompt the **user** fires, so its body
//! never enters a system prompt and is expanded only when someone types the
//! command.
//!
//! That difference is why a command may not shadow a built-in. `/compact` and
//! `/loop` are harness controls with client-side behaviour that a prompt
//! cannot reproduce, so a file claiming one of those names is listed with an
//! error rather than silently winning — the same rule skills already follow.
//!
//! Argument substitution is deliberately tiny: `$ARGUMENTS` for the whole tail
//! and `$1`..`$9` for positional words. Anything more would be a template
//! language, and a template language in a prompt file is a thing to debug at
//! the moment you least want to.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// A command body past this is a document, not a prompt.
pub const MAX_BODY_BYTES: usize = 32 * 1024;

const MAX_NAME_LEN: usize = 48;

/// Names the client owns. A file may not take one: these carry behaviour that
/// lives in the panel (clearing a transcript, driving a loop, switching a
/// model), and a prompt that merely *describes* doing so would look like it
/// worked and do nothing. Mirrors `SLASH_COMMANDS` in
/// `client/src/lib/slashCommands.ts`; a test pins the two together.
pub const BUILTIN_COMMAND_NAMES: &[&str] = &[
    "help",
    "loop",
    "compact",
    "usage",
    "diff",
    "clear",
    "new",
    "model",
    "resume",
    "fork",
    "sessions",
    "subagent",
    "side",
    "graph",
    "stop",
    "goal",
    "checkpoints",
    "restore",
    "skill",
    "init",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandScope {
    Global,
    Project,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    pub name: String,
    pub description: String,
    /// Shown after the name in the slash menu, e.g. `<pr numbers>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
    pub scope: CommandScope,
    pub path: String,
    /// Parse problem, if any. Broken files stay listed so a typo is visible in
    /// the menu instead of the command simply not being there.
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Frontmatter {
    description: String,
    #[serde(default, rename = "argument-hint")]
    argument_hint: Option<String>,
}

/// `~/.cali/commands`. `CALI_COMMANDS_DIR` isolates a test run, exactly as
/// `CALI_SKILLS_DIR` and `CALI_MEMORY_DIR` do.
pub fn global_commands_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CALI_COMMANDS_DIR") {
        return crate::config::expand_tilde(&dir.to_string_lossy());
    }
    crate::config::expand_tilde("~/.cali/commands")
}

/// Project commands dir per the `game_file_base` rule; `None` when the project
/// JSON cannot be read. Mirrors `skills::project_skills_dir`.
pub fn project_commands_dir(projects_root: &Path, slug: &str) -> Option<PathBuf> {
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
    Some(base.join(".cali").join("commands"))
}

/// Split frontmatter off a command file. The name comes from the filename, not
/// the frontmatter: the file *is* the command, and a `name:` that disagreed
/// with its filename would give one command two spellings.
fn parse_command(text: &str) -> Result<(Frontmatter, String)> {
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
        bail!("command body is empty — the body is the prompt this command sends");
    }
    if body.len() > MAX_BODY_BYTES {
        bail!(
            "command body is {} bytes, over the {MAX_BODY_BYTES}-byte limit",
            body.len()
        );
    }
    Ok((
        Frontmatter {
            description,
            argument_hint: frontmatter
                .argument_hint
                .map(|hint| hint.trim().to_string())
                .filter(|hint| !hint.is_empty()),
        },
        body.to_string(),
    ))
}

fn validate_name(raw: &str) -> Result<String> {
    let name = raw.trim().to_ascii_lowercase();
    if name.is_empty() {
        bail!("command name must not be empty");
    }
    if name.len() > MAX_NAME_LEN {
        bail!("command name must be at most {MAX_NAME_LEN} characters");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        bail!("command name must match [A-Za-z0-9_-]");
    }
    Ok(name)
}

/// Every command visible to `slug`, project shadowing global, sorted by name.
pub fn list_commands(projects_root: &Path, slug: Option<&str>) -> Vec<CommandInfo> {
    let project = slug.and_then(|slug| project_commands_dir(projects_root, slug));
    list_from_dirs(&global_commands_dir(), project.as_deref())
}

fn list_from_dirs(global: &Path, project: Option<&Path>) -> Vec<CommandInfo> {
    let mut valid: BTreeMap<String, CommandInfo> = BTreeMap::new();
    let mut broken: Vec<CommandInfo> = Vec::new();
    let mut absorb = |infos: Vec<CommandInfo>| {
        for info in infos {
            if info.error.is_some() {
                broken.push(info);
            } else {
                valid.insert(info.name.clone(), info);
            }
        }
    };
    absorb(scan_dir(global, CommandScope::Global));
    if let Some(project) = project {
        absorb(scan_dir(project, CommandScope::Project));
    }
    let mut out: Vec<CommandInfo> = valid.into_values().collect();
    out.extend(broken);
    out
}

fn scan_dir(dir: &Path, scope: CommandScope) -> Vec<CommandInfo> {
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
            tracing::warn!(path = %path.display(), "skipping command symlinked outside its directory");
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
            if BUILTIN_COMMAND_NAMES.contains(&name.as_str()) {
                bail!("'{name}' is a built-in command; rename this file");
            }
            let text = std::fs::read_to_string(&path)?;
            let (frontmatter, _) = parse_command(&text)?;
            Ok((name, frontmatter))
        });
        out.push(match parsed {
            Ok((name, frontmatter)) => CommandInfo {
                name,
                description: frontmatter.description,
                argument_hint: frontmatter.argument_hint,
                scope,
                path: path_string,
                error: None,
            },
            Err(error) => CommandInfo {
                name: stem.to_ascii_lowercase(),
                description: String::new(),
                argument_hint: None,
                scope,
                path: path_string,
                error: Some(format!("{error:#}")),
            },
        });
    }
    out
}

/// The prompt one command expands to, with `args` substituted.
pub fn render(
    projects_root: &Path,
    slug: Option<&str>,
    name: &str,
    args: &str,
) -> Result<(CommandInfo, String)> {
    let project = slug.and_then(|slug| project_commands_dir(projects_root, slug));
    render_from_dirs(&global_commands_dir(), project.as_deref(), name, args)
}

fn render_from_dirs(
    global: &Path,
    project: Option<&Path>,
    name: &str,
    args: &str,
) -> Result<(CommandInfo, String)> {
    let name = validate_name(name)?;
    let info = list_from_dirs(global, project)
        .into_iter()
        .find(|info| info.name == name && info.error.is_none())
        .with_context(|| format!("no command named '{name}'"))?;
    let text =
        std::fs::read_to_string(&info.path).with_context(|| format!("reading command '{name}'"))?;
    let (_, body) = parse_command(&text)?;
    Ok((info, substitute(&body, args)))
}

/// `$ARGUMENTS` → the whole tail; `$1`..`$9` → whitespace-separated words.
///
/// **An unfilled positional is left exactly as written.** The alternative —
/// expanding it to nothing — silently turns a prompt that says `costs $5.00`
/// into one that says `costs .00` whenever fewer than five arguments were
/// passed, and a prompt file is precisely the place where that corruption
/// would go unnoticed. A literal `$3` surviving into the prompt is visible and
/// says something true: no third argument was given. Deleting text the caller
/// can see they wrote is the worse failure, so the substitution only ever
/// replaces a placeholder it can actually fill.
fn substitute(body: &str, args: &str) -> String {
    let args = args.trim();
    let words: Vec<&str> = args.split_whitespace().collect();
    let mut out = String::with_capacity(body.len() + args.len());
    let mut chars = body.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '$' {
            out.push(ch);
            continue;
        }
        match chars.peek() {
            Some('A') => {
                // Only the exact word ARGUMENTS; `$AMOUNT` stays literal.
                let rest: String = chars.clone().take("ARGUMENTS".len()).collect();
                if rest == "ARGUMENTS" {
                    for _ in 0.."ARGUMENTS".len() {
                        chars.next();
                    }
                    out.push_str(args);
                } else {
                    out.push('$');
                }
            }
            Some(digit) if digit.is_ascii_digit() && *digit != '0' => {
                let index = digit.to_digit(10).expect("checked ascii digit") as usize;
                match words.get(index - 1) {
                    Some(word) => {
                        chars.next();
                        out.push_str(word);
                    }
                    // Nothing to fill it with: leave `$5` (and whatever
                    // follows, e.g. `.00`) untouched.
                    None => out.push('$'),
                }
            }
            _ => out.push('$'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_command(dir: &Path, file: &str, description: &str, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join(file),
            format!("---\ndescription: {description}\n---\n\n{body}\n"),
        )
        .unwrap();
    }

    #[test]
    fn arguments_placeholder_takes_the_whole_tail() {
        assert_eq!(
            substitute("Review $ARGUMENTS now", "151 152"),
            "Review 151 152 now"
        );
    }

    #[test]
    fn positional_placeholders_take_single_words() {
        assert_eq!(
            substitute("$1 then $2", "alpha beta gamma"),
            "alpha then beta"
        );
    }

    #[test]
    fn an_unfilled_positional_is_left_alone_rather_than_deleted() {
        // The reverse of this — expanding to nothing — is what turns
        // `costs $5.00` into `costs .00`, which is the case below.
        assert_eq!(substitute("[$1][$3]", "only"), "[only][$3]");
    }

    #[test]
    fn dollar_signs_that_are_not_placeholders_survive() {
        assert_eq!(
            substitute("costs $5.00 and $AMOUNT", ""),
            "costs $5.00 and $AMOUNT"
        );
        assert_eq!(substitute("shell $(pwd) stays", "x"), "shell $(pwd) stays");
    }

    #[test]
    fn a_command_file_parses_into_description_hint_and_body() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("review.md"),
            "---\ndescription: Review PRs\nargument-hint: <pr numbers>\n---\n\nReview $ARGUMENTS.\n",
        )
        .unwrap();
        let listed = list_from_dirs(dir.path(), None);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "review");
        assert_eq!(listed[0].description, "Review PRs");
        assert_eq!(listed[0].argument_hint.as_deref(), Some("<pr numbers>"));

        let (_, prompt) = render_from_dirs(dir.path(), None, "review", "151 152").unwrap();
        assert_eq!(prompt.trim(), "Review 151 152.");
    }

    #[test]
    fn a_file_may_not_take_a_built_in_name() {
        let dir = tempfile::tempdir().unwrap();
        write_command(dir.path(), "compact.md", "not the real one", "body");
        let listed = list_from_dirs(dir.path(), None);
        assert_eq!(listed.len(), 1);
        assert!(
            listed[0].error.as_deref().unwrap().contains("built-in"),
            "{:?}",
            listed[0].error
        );
        // And it cannot be rendered either — listing it as broken would be
        // pointless if `render` still served it.
        assert!(render_from_dirs(dir.path(), None, "compact", "").is_err());
    }

    #[test]
    fn the_name_comes_from_the_filename_and_is_lowercased() {
        let dir = tempfile::tempdir().unwrap();
        write_command(dir.path(), "Deploy-Staging.md", "ship it", "do the thing");
        let listed = list_from_dirs(dir.path(), None);
        assert_eq!(listed[0].name, "deploy-staging");
    }

    #[test]
    fn project_scope_shadows_global() {
        let global = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        write_command(global.path(), "ship.md", "global ship", "global body");
        write_command(project.path(), "ship.md", "project ship", "project body");
        let listed = list_from_dirs(global.path(), Some(project.path()));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].description, "project ship");
        let (_, prompt) =
            render_from_dirs(global.path(), Some(project.path()), "ship", "").unwrap();
        assert_eq!(prompt.trim(), "project body");
    }

    #[test]
    fn an_empty_body_is_refused_because_the_body_is_the_prompt() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(
            dir.path().join("hollow.md"),
            "---\ndescription: d\n---\n\n   \n",
        )
        .unwrap();
        let listed = list_from_dirs(dir.path(), None);
        assert!(listed[0]
            .error
            .as_deref()
            .unwrap()
            .contains("body is empty"));
    }

    #[test]
    fn a_broken_file_is_listed_rather_than_vanishing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(dir.path().join("oops.md"), "no frontmatter here").unwrap();
        let listed = list_from_dirs(dir.path(), None);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "oops");
        assert!(listed[0].error.is_some());
    }

    #[test]
    fn symlinked_commands_escaping_the_dir_are_skipped() {
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

    #[test]
    fn project_commands_dir_follows_the_game_file_base_rule() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();
        let dir = project_commands_dir(root.path(), "demo").unwrap();
        assert_eq!(
            dir,
            crate::store::project_dir(root.path(), "demo")
                .unwrap()
                .join(".cali")
                .join("commands")
        );
    }
}
