//! Durable cross-session memory: one fact per markdown file with a small YAML
//! frontmatter, plus an index that carries only the descriptions.
//!
//! This is `skills` with the authorship reversed. A skill is written by the
//! user and pulled in when a task matches it; a memory is written by the agent
//! and exists so the *next* session does not rediscover something this one paid
//! for. The mechanics are deliberately the same — frontmatter, a scan that
//! refuses symlink escapes, project scope shadowing global, and progressive
//! disclosure through a one-line index — because two loaders with two different
//! sets of edge cases is how one of them ends up wrong.
//!
//! **One fact per file.** A memory that turns out to be wrong has to be
//! deletable without taking three correct facts with it, and a body cap
//! (`MAX_BODY_BYTES`) is what keeps the format honest: a memory that grew into
//! a document is a mistake in how it was written, so the write refuses rather
//! than the read truncating.
//!
//! **The `description` is the whole system.** It is not a summary of the body —
//! it is the sentence a future session reads to decide whether to open the
//! body at all, which is why the index costs one line per memory instead of one
//! document per memory.
//!
//! There is no on-disk index file. Claude Code keeps a `MEMORY.md` because a
//! prompt reads it as plain text; we have a scanner, and a derived index cannot
//! drift out of sync with the directory it describes.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// A memory is a fact. Past this it is a document, and `memory_write` says so
/// rather than storing something the index can no longer honestly summarize.
pub const MAX_BODY_BYTES: usize = 8 * 1024;

const MAX_NAME_LEN: usize = 48;

/// Byte budget for the whole system-prompt index, header included.
///
/// The per-session block of the prompt has its own budget, asserted in
/// `rpc::tests::default_system_prompt_stays_small_and_never_dumps_project_json`,
/// and an unbounded index would eat it: sixty memories at a hundred bytes each
/// is six kilobytes charged to every turn of every session whether or not any
/// of them turns out to be relevant. The cap is bytes rather than entries
/// because descriptions vary in length by an order of magnitude, so an entry
/// count bounds nothing that matters. Past the budget the tail is counted
/// rather than listed, and `memory_list` still reaches all of it.
const MAX_INDEX_BYTES: usize = 2 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryScope {
    Global,
    Project,
}

/// What kind of fact this is. The four have different lifetimes, and that is
/// the point of recording it: a `user` fact outlives the project, a `project`
/// fact dies with it, `feedback` is a standing instruction, and `reference` is
/// a pointer that may rot and should be re-checked before being relied on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKind {
    User,
    Feedback,
    Project,
    Reference,
}

impl MemoryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryKind::User => "user",
            MemoryKind::Feedback => "feedback",
            MemoryKind::Project => "project",
            MemoryKind::Reference => "reference",
        }
    }

    pub const ALL: [MemoryKind; 4] = [
        MemoryKind::User,
        MemoryKind::Feedback,
        MemoryKind::Project,
        MemoryKind::Reference,
    ];

    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "user" => Some(MemoryKind::User),
            "feedback" => Some(MemoryKind::Feedback),
            "project" => Some(MemoryKind::Project),
            "reference" => Some(MemoryKind::Reference),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub name: String,
    pub description: String,
    pub kind: MemoryKind,
    pub scope: MemoryScope,
    /// Absolute path, for the UI and for `memory_forget`'s readout.
    pub path: String,
    /// Parse problem, if any. Broken files stay listed so they can be seen and
    /// fixed, but they are excluded from the index and from `memory_read`.
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Frontmatter {
    name: String,
    description: String,
    #[serde(default)]
    metadata: Metadata,
}

#[derive(Debug, Default, Deserialize)]
struct Metadata {
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

/// `~/.cali/memory`. Created lazily on first write, never on read.
///
/// `CALI_MEMORY_DIR` overrides it for the same reason `CALI_SKILLS_DIR` and
/// `CALI_PROJECTS_DIR` exist: a test run must not read — or seed — the
/// developer's real `~/.cali`.
pub fn global_memory_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CALI_MEMORY_DIR") {
        return crate::config::expand_tilde(&dir.to_string_lossy());
    }
    crate::config::expand_tilde("~/.cali/memory")
}

/// Project memory dir per the `game_file_base` rule; `None` when the project
/// JSON cannot be read.
///
/// Mirrors `skills::project_skills_dir` (which in turn mirrors the private
/// `tools::game_file_base`): the attached `workspaceRoot` when there is one and
/// it exists, otherwise the CaliCode-owned project directory. Memory follows
/// the code it is about, so a checkout that moves keeps its facts.
pub fn project_memory_dir(projects_root: &Path, slug: &str) -> Option<PathBuf> {
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
    Some(base.join(".cali").join("memory"))
}

/// Split the leading `---` frontmatter off a memory file and validate it.
///
/// An unrecognised `metadata.type` reads back as `Project` rather than failing:
/// losing a hard-won fact over a typo in its label is a far worse outcome than
/// filing it under the commonest kind. `write_memory` is strict about the same
/// field, so the typo is refused where it can still be corrected cheaply.
fn parse_memory(text: &str) -> Result<(String, String, MemoryKind, String)> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let rest = text
        .strip_prefix("---")
        .context("missing frontmatter: file must start with ---")?;
    let rest = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
        .context("missing frontmatter: file must start with --- on its own line")?;

    // The closing `---` on its own line, not a longer dash run inside the body.
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
    let name = validate_name(&frontmatter.name)?;
    let description = validate_description(&frontmatter.description)?;
    let kind = frontmatter
        .metadata
        .kind
        .as_deref()
        .and_then(MemoryKind::parse)
        .unwrap_or(MemoryKind::Project);
    Ok((name, description, kind, body.to_string()))
}

/// `[A-Za-z0-9_-]`, non-empty, bounded. This is also the whole path defence:
/// a name that cannot hold `/`, `\` or `.` cannot escape its directory when it
/// becomes `<name>.md`.
fn validate_name(raw: &str) -> Result<String> {
    let name = raw.trim().to_string();
    if name.is_empty() {
        bail!("memory name must not be empty");
    }
    if name.len() > MAX_NAME_LEN {
        bail!("memory name must be at most {MAX_NAME_LEN} characters");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        bail!("memory name must match [A-Za-z0-9_-]");
    }
    Ok(name)
}

/// The index is line-oriented, so a multi-line description would let one memory
/// file inject arbitrary extra lines into the system prompt.
fn validate_description(raw: &str) -> Result<String> {
    let description = raw.lines().next().unwrap_or("").trim().to_string();
    if description.is_empty() {
        bail!("memory description must not be empty — it is what a later session reads to decide whether this fact is relevant");
    }
    Ok(description)
}

/// Emit a YAML double-quoted scalar. Descriptions are free text and routinely
/// contain `:` and `#`, either of which turns a bare scalar into a parse error
/// or, worse, into a silently different value.
fn yaml_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// Every memory visible to `slug`, project shadowing global, sorted by name.
///
/// Never errors: an unreadable directory yields nothing, an unparsable file
/// yields a `MemoryInfo` carrying its error.
pub fn list_memories(projects_root: &Path, slug: Option<&str>) -> Vec<MemoryInfo> {
    let project = slug.and_then(|slug| project_memory_dir(projects_root, slug));
    list_from_dirs(&global_memory_dir(), project.as_deref())
}

fn list_from_dirs(global: &Path, project: Option<&Path>) -> Vec<MemoryInfo> {
    let mut valid: BTreeMap<String, MemoryInfo> = BTreeMap::new();
    let mut broken: Vec<MemoryInfo> = Vec::new();
    let mut absorb = |infos: Vec<MemoryInfo>| {
        for info in infos {
            if info.error.is_some() {
                broken.push(info);
            } else {
                // Project overwrites global: a fact about this game beats a
                // general one that happens to share its name.
                valid.insert(info.name.clone(), info);
            }
        }
    };
    absorb(scan_dir(global, MemoryScope::Global));
    if let Some(project) = project {
        absorb(scan_dir(project, MemoryScope::Project));
    }
    let mut out: Vec<MemoryInfo> = valid.into_values().collect();
    out.extend(broken);
    out
}

fn scan_dir(dir: &Path, scope: MemoryScope) -> Vec<MemoryInfo> {
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
        // A memory directory is a place the agent writes to. A symlink out of
        // it would turn `memory_read` into an arbitrary-file read and
        // `memory_forget` into an arbitrary-file delete.
        if !real.starts_with(&canonical_dir) {
            tracing::warn!(path = %path.display(), "skipping memory symlinked outside its directory");
            continue;
        }
        if !real.is_file() {
            continue;
        }
        let path_string = path.display().to_string();
        let info = match std::fs::read_to_string(&path)
            .map_err(anyhow::Error::from)
            .and_then(|text| parse_memory(&text))
        {
            Ok((name, description, kind, _)) => MemoryInfo {
                name,
                description,
                kind,
                scope,
                path: path_string,
                error: None,
            },
            Err(error) => MemoryInfo {
                name: path
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().to_string())
                    .unwrap_or_default(),
                description: String::new(),
                kind: MemoryKind::Project,
                scope,
                path: path_string,
                error: Some(format!("{error:#}")),
            },
        };
        out.push(info);
    }
    out
}

/// One memory's full body, project scope preferred on a name clash.
pub fn load_memory(
    projects_root: &Path,
    slug: Option<&str>,
    name: &str,
) -> Result<(MemoryInfo, String)> {
    let project = slug.and_then(|slug| project_memory_dir(projects_root, slug));
    load_from_dirs(&global_memory_dir(), project.as_deref(), name)
}

fn load_from_dirs(
    global: &Path,
    project: Option<&Path>,
    name: &str,
) -> Result<(MemoryInfo, String)> {
    let name = validate_name(name)?;
    let info = list_from_dirs(global, project)
        .into_iter()
        .find(|info| info.name == name && info.error.is_none())
        .with_context(|| format!("no memory named '{name}'"))?;
    let text =
        std::fs::read_to_string(&info.path).with_context(|| format!("reading memory '{name}'"))?;
    let (_, _, _, body) = parse_memory(&text)?;
    Ok((info, body.trim().to_string()))
}

/// Store one fact, replacing any memory of the same name in the same scope.
///
/// Written temp-then-rename: a memory half-written by a crash would be a broken
/// row in every later session's index, and the failure would look like a bad
/// fact rather than a bad write.
pub fn write_memory(
    projects_root: &Path,
    slug: Option<&str>,
    scope: MemoryScope,
    name: &str,
    description: &str,
    kind: Option<&str>,
    body: &str,
) -> Result<MemoryInfo> {
    let dir = memory_dir_for(projects_root, slug, scope)?;
    write_to_dir(&dir, scope, name, description, kind, body)
}

fn write_to_dir(
    dir: &Path,
    scope: MemoryScope,
    name: &str,
    description: &str,
    kind: Option<&str>,
    body: &str,
) -> Result<MemoryInfo> {
    let name = validate_name(name)?;
    let description = validate_description(description)?;
    let kind = match kind {
        None => MemoryKind::Project,
        Some(raw) => MemoryKind::parse(raw).with_context(|| {
            let known: Vec<&str> = MemoryKind::ALL.iter().map(|k| k.as_str()).collect();
            format!(
                "unknown memory type '{raw}' — expected one of {}",
                known.join(", ")
            )
        })?,
    };
    let body = body.trim();
    if body.is_empty() {
        bail!("a memory needs a body: the fact itself, not just its description");
    }
    if body.len() > MAX_BODY_BYTES {
        bail!(
            "memory body is {} bytes, over the {MAX_BODY_BYTES}-byte limit — a memory holds one \
             fact; split it or shorten it rather than storing a document",
            body.len()
        );
    }
    std::fs::create_dir_all(dir)
        .with_context(|| format!("creating memory directory {}", dir.display()))?;
    let path = dir.join(format!("{name}.md"));
    let contents = format!(
        "---\nname: {name}\ndescription: {}\nmetadata:\n  type: {}\n---\n\n{body}\n",
        yaml_quote(&description),
        kind.as_str(),
    );
    let temp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&temp, &contents).with_context(|| format!("writing {}", temp.display()))?;
    std::fs::rename(&temp, &path).with_context(|| format!("writing {}", path.display()))?;
    Ok(MemoryInfo {
        name,
        description,
        kind,
        scope,
        path: path.display().to_string(),
        error: None,
    })
}

/// Delete one memory. Returns what was removed, so a caller can report the
/// description rather than just the name.
pub fn forget_memory(projects_root: &Path, slug: Option<&str>, name: &str) -> Result<MemoryInfo> {
    let project = slug.and_then(|slug| project_memory_dir(projects_root, slug));
    forget_in_dirs(&global_memory_dir(), project.as_deref(), name)
}

fn forget_in_dirs(global: &Path, project: Option<&Path>, name: &str) -> Result<MemoryInfo> {
    let name = validate_name(name)?;
    let info = list_from_dirs(global, project)
        .into_iter()
        .find(|info| info.name == name)
        .with_context(|| format!("no memory named '{name}'"))?;
    std::fs::remove_file(&info.path)
        .with_context(|| format!("removing memory '{name}' at {}", info.path))?;
    Ok(info)
}

fn memory_dir_for(projects_root: &Path, slug: Option<&str>, scope: MemoryScope) -> Result<PathBuf> {
    match scope {
        MemoryScope::Global => Ok(global_memory_dir()),
        MemoryScope::Project => {
            let slug = slug.context("project-scoped memory needs a project slug")?;
            project_memory_dir(projects_root, slug)
                .with_context(|| format!("no project directory for '{slug}'"))
        }
    }
}

/// The index appended to the system prompt: one line per memory, descriptions
/// only.
///
/// Callers must append this to the volatile `## This session` region of the
/// prompt, never to `STATIC_SYSTEM_PROMPT` — that const is byte-identical
/// across projects and sessions so a provider prefix cache serves it as one
/// shared read, and a per-project index inside it re-bills the whole static
/// body on every turn.
pub fn prompt_index(projects_root: &Path, slug: Option<&str>) -> String {
    render_index(&list_memories(projects_root, slug))
}

fn render_index(memories: &[MemoryInfo]) -> String {
    let usable: Vec<&MemoryInfo> = memories
        .iter()
        .filter(|memory| memory.error.is_none())
        .collect();
    if usable.is_empty() {
        return String::new();
    }
    let mut index = String::from(
        "\n\nMemory from earlier sessions — durable facts, one line each. Call memory_read with a \
         name before acting on its subject; these lines are pointers, not the whole fact. Record \
         something new with memory_write, and delete one you find to be wrong with memory_forget:",
    );
    let mut listed = 0usize;
    for memory in &usable {
        let line = format!(
            "\n- {} ({}): {}",
            memory.name,
            memory.kind.as_str(),
            memory.description
        );
        if index.len() + line.len() > MAX_INDEX_BYTES {
            break;
        }
        index.push_str(&line);
        listed += 1;
    }
    // A header promising an index and then naming nothing is worse than no
    // index: it tells the model memories exist and gives it no way to want one.
    if listed == 0 {
        return String::new();
    }
    if listed < usable.len() {
        // Deliberately allowed to exceed the budget by this one short line —
        // silently dropping the count is how an index reads as complete when
        // it is not.
        index.push_str(&format!(
            "\n- … and {} more; call memory_list for the rest.",
            usable.len() - listed
        ));
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_raw(dir: &Path, file: &str, contents: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(file), contents).unwrap();
    }

    fn write_fact(dir: &Path, name: &str, description: &str, kind: &str, body: &str) {
        write_raw(
            dir,
            &format!("{name}.md"),
            &format!(
                "---\nname: {name}\ndescription: {description}\nmetadata:\n  type: {kind}\n---\n\n{body}\n"
            ),
        );
    }

    #[test]
    fn parse_reads_frontmatter_body_and_type() {
        let (name, description, kind, body) = parse_memory(
            "---\nname: port-rule\ndescription: core binds 8765\nmetadata:\n  type: reference\n---\n\nthe body\n",
        )
        .unwrap();
        assert_eq!(name, "port-rule");
        assert_eq!(description, "core binds 8765");
        assert_eq!(kind, MemoryKind::Reference);
        assert_eq!(body.trim(), "the body");
    }

    #[test]
    fn an_unknown_type_reads_back_as_project_rather_than_losing_the_fact() {
        let (_, _, kind, _) =
            parse_memory("---\nname: x\ndescription: d\nmetadata:\n  type: prohect\n---\n\nbody\n")
                .unwrap();
        assert_eq!(kind, MemoryKind::Project);

        // Absent metadata is the same story.
        let (_, _, kind, _) = parse_memory("---\nname: x\ndescription: d\n---\n\nbody\n").unwrap();
        assert_eq!(kind, MemoryKind::Project);
    }

    #[test]
    fn write_refuses_an_unknown_type_where_the_typo_is_still_cheap_to_fix() {
        let global = tempfile::tempdir().unwrap();
        let error = write_to_dir(
            global.path(),
            MemoryScope::Global,
            "x",
            "d",
            Some("prohect"),
            "body",
        )
        .unwrap_err();
        assert!(
            format!("{error:#}").contains("unknown memory type"),
            "{error:#}"
        );
    }

    #[test]
    fn a_multi_line_description_cannot_inject_extra_index_lines() {
        let (_, description, _, _) = parse_memory(
            "---\nname: x\ndescription: |\n  first line\n  - injected: fake\n---\n\nbody\n",
        )
        .unwrap();
        assert_eq!(description, "first line");
    }

    #[test]
    fn write_then_load_round_trips_through_the_scanner() {
        let global = tempfile::tempdir().unwrap();
        write_raw(
            global.path(),
            "n.md",
            "---\nname: n\ndescription: d\nmetadata:\n  type: user\n---\n\nbody\n",
        );
        let listed = list_from_dirs(global.path(), None);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, MemoryKind::User);
        assert_eq!(listed[0].scope, MemoryScope::Global);

        // What the write path emits is exactly what the read path accepts —
        // the pair that would otherwise drift apart silently.
        write_to_dir(
            global.path(),
            MemoryScope::Global,
            "n2",
            "second fact",
            Some("feedback"),
            "the second body",
        )
        .unwrap();
        let (info, body) = load_from_dirs(global.path(), None, "n2").unwrap();
        assert_eq!(info.description, "second fact");
        assert_eq!(info.kind, MemoryKind::Feedback);
        assert_eq!(body, "the second body");
    }

    #[test]
    fn a_description_carrying_yaml_punctuation_survives_the_round_trip() {
        let global = tempfile::tempdir().unwrap();
        let tricky = r#"core binds :8765 # always, and "quotes" too"#;
        write_to_dir(
            global.path(),
            MemoryScope::Global,
            "ports",
            tricky,
            None,
            "body",
        )
        .unwrap();
        let (info, _) = load_from_dirs(global.path(), None, "ports").unwrap();
        assert_eq!(info.description, tricky);
    }

    #[test]
    fn write_refuses_an_oversized_body_instead_of_the_read_truncating_it() {
        let global = tempfile::tempdir().unwrap();
        let big = "x".repeat(MAX_BODY_BYTES + 1);
        let error =
            write_to_dir(global.path(), MemoryScope::Global, "big", "d", None, &big).unwrap_err();
        assert!(format!("{error:#}").contains("over the"), "{error:#}");
    }

    #[test]
    fn a_name_that_could_escape_the_directory_is_refused() {
        for bad in ["../escape", "a/b", "a\\b", "a.b", ""] {
            assert!(validate_name(bad).is_err(), "accepted {bad:?}");
        }
        assert!(validate_name("a-good_Name9").is_ok());
    }

    #[test]
    fn an_empty_description_is_refused_because_the_index_would_be_useless() {
        assert!(validate_description("   ").is_err());
    }

    #[test]
    fn project_scope_shadows_global_on_a_name_clash() {
        let global = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        write_fact(global.path(), "ports", "the global one", "reference", "g");
        write_fact(project.path(), "ports", "the project one", "project", "p");
        let listed = list_from_dirs(global.path(), Some(project.path()));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].description, "the project one");
        assert_eq!(listed[0].scope, MemoryScope::Project);
    }

    #[test]
    fn index_is_empty_without_usable_memories() {
        let global = tempfile::tempdir().unwrap();
        assert_eq!(render_index(&list_from_dirs(global.path(), None)), "");

        // A broken file is listed for the UI but never reaches the prompt.
        write_raw(global.path(), "broken.md", "junk");
        let listed = list_from_dirs(global.path(), None);
        assert_eq!(listed.len(), 1);
        assert!(listed[0].error.is_some());
        assert_eq!(render_index(&listed), "");
    }

    #[test]
    fn index_lists_one_line_per_memory_with_its_kind() {
        let global = tempfile::tempdir().unwrap();
        write_fact(global.path(), "alpha", "does alpha things", "project", "a");
        write_fact(global.path(), "beta", "does beta things", "user", "b");
        let index = render_index(&list_from_dirs(global.path(), None));
        assert!(
            index.contains("\n- alpha (project): does alpha things"),
            "{index}"
        );
        assert!(
            index.contains("\n- beta (user): does beta things"),
            "{index}"
        );
        // One line per memory, plus the header.
        assert_eq!(
            index.lines().filter(|line| line.starts_with("- ")).count(),
            2
        );
    }

    #[test]
    fn index_stays_inside_its_byte_budget_and_says_how_many_it_left_out() {
        let global = tempfile::tempdir().unwrap();
        // Long descriptions, so the byte budget binds well before any
        // plausible entry count would have.
        let long = "a fact worth remembering across sessions, at length".repeat(3);
        for i in 0..80 {
            write_fact(global.path(), &format!("m{i:03}"), &long, "project", "b");
        }
        let index = render_index(&list_from_dirs(global.path(), None));
        let listed_bytes = index.split("\n- … and").next().unwrap().len();
        assert!(
            listed_bytes <= MAX_INDEX_BYTES,
            "index body is {listed_bytes} bytes, budget is {MAX_INDEX_BYTES}"
        );
        assert!(index.contains("more; call memory_list"), "{index}");
        // Something was listed — a budget that admits nothing must not leave a
        // header standing on its own.
        assert!(index.contains("\n- m000 (project):"), "{index}");
    }

    #[test]
    fn a_single_memory_too_large_for_the_budget_yields_no_index_at_all() {
        let global = tempfile::tempdir().unwrap();
        write_fact(
            global.path(),
            "huge",
            &"x".repeat(MAX_INDEX_BYTES + 1),
            "project",
            "b",
        );
        assert_eq!(render_index(&list_from_dirs(global.path(), None)), "");
    }

    #[test]
    fn forget_removes_the_file_and_reports_what_it_removed() {
        let global = tempfile::tempdir().unwrap();
        write_fact(global.path(), "stale", "no longer true", "project", "b");
        let removed = forget_in_dirs(global.path(), None, "stale").unwrap();
        let missing = forget_in_dirs(global.path(), None, "stale").unwrap_err();
        assert_eq!(removed.description, "no longer true");
        assert!(!global.path().join("stale.md").exists());
        assert!(
            format!("{missing:#}").contains("no memory named"),
            "{missing:#}"
        );
    }

    #[test]
    fn symlinked_memories_escaping_the_dir_are_skipped() {
        let global = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.md");
        std::fs::write(
            &secret,
            "---\nname: sneaky\ndescription: d\n---\n\nsecret\n",
        )
        .unwrap();
        std::fs::create_dir_all(global.path()).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&secret, global.path().join("link.md")).unwrap();
            let listed = list_from_dirs(global.path(), None);
            assert!(listed.is_empty(), "{listed:?}");
        }
    }

    #[test]
    fn project_memory_dir_follows_the_game_file_base_rule() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();

        let dir = project_memory_dir(root.path(), "demo").unwrap();
        assert_eq!(
            dir,
            crate::store::project_dir(root.path(), "demo")
                .unwrap()
                .join(".cali")
                .join("memory")
        );

        let workspace = tempfile::tempdir().unwrap();
        crate::store::set_workspace_root(
            root.path(),
            "demo",
            Some(workspace.path().to_str().unwrap()),
        )
        .unwrap();
        let dir = project_memory_dir(root.path(), "demo").unwrap();
        assert_eq!(dir, workspace.path().join(".cali").join("memory"));
    }
}
