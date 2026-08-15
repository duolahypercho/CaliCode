use crate::baselines;
use crate::image3d;
use crate::store;
use crate::video_analysis;
use crate::AppState;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

/// Where a game's file tools operate.
///
/// A game with a folder attached (`workspaceRoot`) reads and writes THAT
/// folder — that is the whole point of a game owning a workspace. Without one
/// the tools stay inside the CaliCode-owned project directory. Before this
/// split, `file_read` always resolved under `~/.cali/projects/<slug>`, so an
/// agent working on a real repo could not see a single one of its files.
pub(crate) struct GameFileBase {
    pub(crate) base: PathBuf,
    /// True when `base` is a user folder, which needs the workspace module's
    /// stricter resolution (symlink escapes, secret-file refusal).
    is_workspace: bool,
}

pub(crate) fn game_file_base(
    root: &Path,
    slug: &str,
    workspace_override: Option<&Path>,
) -> Result<GameFileBase> {
    if let Some(base) = workspace_override {
        if !base.is_dir() {
            anyhow::bail!("session workspace {} is unavailable", base.display());
        }
        return Ok(GameFileBase {
            base: base.to_path_buf(),
            is_workspace: true,
        });
    }
    let project = store::read_project(root, slug)?;
    let attached = project
        .get("workspaceRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir());
    match attached {
        Some(base) => Ok(GameFileBase {
            base,
            is_workspace: true,
        }),
        None => Ok(GameFileBase {
            base: store::project_dir(root, slug)?,
            is_workspace: false,
        }),
    }
}

/// Directories a tool may read but must never write into.
///
/// `.git` is the one that matters. An unattended `/loop` can legitimately
/// rewrite every source file in a game — that is the job — and the way back
/// from a bad run is the repository history. A tool that can corrupt `.git`
/// takes the undo with it, so the recovery path is protected even though the
/// working tree is not. `.wt` holds worktree metadata for the same reason.
///
/// This is a write guard, not a search filter: `SEARCH_SKIP_DIRS` above keeps
/// these out of listings for noise and speed, which stops nothing.
const PROTECTED_WRITE_DIRS: &[&str] = &[".git", ".wt"];

/// Refuse a write that lands inside a protected directory.
///
/// Checked on the *resolved* path rather than the caller's string, so a
/// symlink or an odd spelling cannot walk in sideways.
pub(crate) fn reject_protected_write(base: &Path, path: &Path) -> Result<()> {
    let relative = path.strip_prefix(base).unwrap_or(path);
    for component in relative.components() {
        if let std::path::Component::Normal(name) = component {
            let name = name.to_string_lossy();
            if PROTECTED_WRITE_DIRS.iter().any(|guarded| name == *guarded) {
                anyhow::bail!(
                    "refusing to write inside {name}: it is the repository's history, which is how a bad run is undone"
                );
            }
        }
    }
    Ok(())
}

pub(crate) fn resolve_in_base(base: &GameFileBase, rel: &str) -> Result<PathBuf> {
    if base.is_workspace {
        crate::workspace::safe_resolve(&base.base, rel)
    } else {
        store::safe_join(&base.base, rel)
    }
}

/// Resolve `rel` for a game, returning the base it resolved against so errors
/// can say which folder was searched.
///
/// Shared with the JSON-RPC handlers so the client and the agent always see the
/// same files — they had diverged, with each resolving its own way.
pub(crate) fn resolve_game_file(root: &Path, slug: &str, rel: &str) -> Result<(PathBuf, PathBuf)> {
    let base = game_file_base(root, slug, None)?;
    let path = resolve_in_base(&base, rel)?;
    Ok((base.base, path))
}

/// Resolve a path that must already exist, repairing the spellings a model
/// cannot see it got wrong and, on a genuine miss, naming what to try instead.
///
/// The candidate ladder exists because macOS filenames are adversarial in ways
/// that do not survive rendering: APFS stores names NFD-decomposed, screenshots
/// carry a narrow no-break space before AM/PM, Finder rewrites `'` as `’`. The
/// model reads the path off the screen, retypes it faithfully, and gets "not
/// found" — no amount of reasoning recovers, because the difference is not in
/// the glyphs. Retrying is the tool's job.
///
/// Every candidate goes back through `resolve_in_base`, so a repair can never
/// quietly become an escape hatch. The original is resolved first and its error
/// propagates untouched: a refusal (traversal, secret file) must never be
/// downgraded into a "did you mean".
fn resolve_existing(base: &GameFileBase, rel: &str) -> Result<(PathBuf, Option<String>)> {
    let direct = resolve_in_base(base, rel)?;
    if direct.exists() {
        return Ok((direct, None));
    }
    for candidate in crate::fileread::spelling_candidates(rel)
        .into_iter()
        .skip(1)
    {
        let Ok(path) = resolve_in_base(base, &candidate) else {
            continue;
        };
        if path.exists() {
            let notice = format!(
                "{rel:?} did not exist; read {candidate:?} instead — the two render \
                 identically but differ in bytes."
            );
            return Ok((path, Some(notice)));
        }
    }

    // Only ever suggest a name this caller could actually open. Filtering
    // through the resolver itself — rather than re-listing the secret
    // patterns here — keeps the two in sync forever, and covers traversal and
    // every future rule for free.
    //
    // Without this, "did you mean" was an oracle: `file_read {"path":"rsa"}`
    // does not match any secret pattern, so it got as far as the suggestion
    // pass and answered with `id_rsa` — confirming the exact name and
    // existence of a file file_read is hard-refused from opening.
    let parent_rel = Path::new(rel)
        .parent()
        .map(|parent| parent.to_string_lossy().to_string())
        .unwrap_or_default();
    let suggestions: Vec<String> = direct
        .parent()
        .map(|parent| {
            let name = Path::new(rel)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| rel.to_string());
            crate::fileread::did_you_mean(parent, &name)
        })
        .unwrap_or_default()
        .into_iter()
        .filter(|name| {
            let candidate = if parent_rel.is_empty() {
                name.clone()
            } else {
                format!("{parent_rel}/{name}")
            };
            resolve_in_base(base, &candidate).is_ok()
        })
        .collect();
    if suggestions.is_empty() {
        anyhow::bail!(
            "{rel} does not exist under {}; use file_list or file_glob to find it",
            base.base.display()
        );
    }
    anyhow::bail!(
        "{rel} does not exist under {}. Did you mean: {}?",
        base.base.display(),
        suggestions.join(", ")
    )
}

/// Directory names never descended into by `file_grep`/`file_glob`. Mirrors
/// `workspace::SKIP_DIRS` (private there); keep the lists in sync.
const SEARCH_SKIP_DIRS: &[&str] = &[
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

/// Path fragments never surfaced by search tools, regardless of resolution.
/// Mirrors `workspace::SECRET_PATTERNS` (private there); keep in sync.
const SEARCH_SECRET_PATTERNS: &[&str] =
    &[".env", "id_rsa", "id_ed25519", ".pem", ".p12", ".keystore"];

/// Write cap for `file_edit`, mirroring `workspace::MAX_WRITE_BYTES` (private
/// there) so an edit can never grow a file past what `file_write` allows.
const EDIT_MAX_WRITE_BYTES: usize = 8 * 1024 * 1024;

/// Reserved only for the in-process agent activity bridge. Public RPC callers
/// receive the normal tool result without this field; the agent removes it
/// before appending the result to provider history and emits it separately on
/// the `agent.tool_finished` SSE event.
pub(crate) const INTERNAL_ACTIVITY_KEY: &str = "__cali_internal_activity";

/// File snapshots are useful to the editor for a diff preview, but must never
/// turn a single write into an unbounded SSE payload. The actual write cap is
/// much larger; this is only the transient activity preview cap.
const ACTIVITY_TEXT_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug)]
struct ActivityText {
    text: String,
    bytes: u64,
    truncated: bool,
}

fn utf8_prefix(bytes: &[u8], max: usize) -> &[u8] {
    if bytes.len() <= max {
        return bytes;
    }
    let mut end = max;
    while end > 0 && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    &bytes[..end]
}

fn activity_text(text: &str) -> ActivityText {
    let bytes = text.as_bytes();
    ActivityText {
        text: String::from_utf8_lossy(utf8_prefix(bytes, ACTIVITY_TEXT_MAX_BYTES)).into_owned(),
        bytes: bytes.len() as u64,
        truncated: bytes.len() > ACTIVITY_TEXT_MAX_BYTES,
    }
}

/// Read at most one extra byte beyond the preview cap while the caller holds
/// the path write lock. Metadata supplies the full length without reading a
/// potentially huge file into memory.
fn read_activity_text(path: &Path) -> Option<ActivityText> {
    let bytes = std::fs::metadata(path).ok()?.len();
    let file = std::fs::File::open(path).ok()?;
    let preview_len = bytes.min((ACTIVITY_TEXT_MAX_BYTES + 1) as u64) as usize;
    let mut preview = Vec::with_capacity(preview_len);
    file.take((ACTIVITY_TEXT_MAX_BYTES + 1) as u64)
        .read_to_end(&mut preview)
        .ok()?;
    let preview = utf8_prefix(&preview, ACTIVITY_TEXT_MAX_BYTES);
    let text = std::str::from_utf8(preview).ok()?.to_string();
    Some(ActivityText {
        text,
        bytes,
        truncated: bytes > ACTIVITY_TEXT_MAX_BYTES as u64,
    })
}

fn activity_metadata(
    operation: &str,
    rel: &str,
    before: Option<ActivityText>,
    after: &str,
) -> Value {
    let after = activity_text(after);
    let truncated = before.as_ref().is_some_and(|snapshot| snapshot.truncated) || after.truncated;
    let mut activity = json!({
        "operation": operation,
        "path": rel,
        "after": after.text,
        "afterBytes": after.bytes,
        "truncated": truncated,
    });
    if let Some(before) = before {
        activity["before"] = json!(before.text);
        activity["beforeBytes"] = json!(before.bytes);
    }
    activity
}

fn with_activity(mut result: Value, activity: Value) -> Value {
    if let Some(object) = result.as_object_mut() {
        object.insert(INTERNAL_ACTIVITY_KEY.to_string(), activity);
        result
    } else {
        json!({
            "result": result,
            INTERNAL_ACTIVITY_KEY: activity,
        })
    }
}

/// Remove the reserved activity payload from a tool result before it reaches
/// provider history or the public-facing tool-finished event.
pub(crate) fn take_internal_activity(result: &mut Value) -> Option<Value> {
    result
        .as_object_mut()
        .and_then(|object| object.remove(INTERNAL_ACTIVITY_KEY))
}

/// `file_grep` hard caps: matches returned, bytes of match text emitted,
/// per-file size searched, and characters shown per matched line.
const GREP_MAX_MATCHES: usize = 2000;
const GREP_MAX_OUTPUT_BYTES: usize = 64 * 1024;
const GREP_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const GREP_MAX_LINE_CHARS: usize = 400;

/// `file_glob` result cap.
const GLOB_MAX_RESULTS: usize = 500;

/// `file_list` entry cap. Generated asset folders run to tens of thousands of
/// files, and a listing that big is both useless to read and permanent in the
/// context once it lands there.
const LIST_MAX_ENTRIES: usize = 1_000;

/// Files visited before a search walk gives up, so a pathological tree can
/// never stall the agent loop.
const SEARCH_MAX_FILES_WALKED: usize = 20_000;

fn search_skipped_dir(name: &str, rel: &str) -> bool {
    SEARCH_SKIP_DIRS
        .iter()
        .any(|skip| name == *skip || rel == *skip || rel.starts_with(&format!("{skip}/")))
}

/// Paths that look like credentials. Also consulted by the advisor, which
/// refuses to open one even when asked for it by name.
pub(crate) fn search_secret_path(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    SEARCH_SECRET_PATTERNS
        .iter()
        .any(|pattern| lower.contains(pattern))
}

/// Collect regular files under `dir` as `(relative path, absolute path)`,
/// applying the same visibility rules the other file tools enforce: dotfiles
/// hidden, skip-dirs pruned, secret-pattern paths refused, symlinks never
/// followed (a link inside the tree would otherwise escape it). `budget`
/// counts files; hitting zero abandons the walk.
fn walk_search_files(
    dir: &Path,
    rel_prefix: &str,
    out: &mut Vec<(String, PathBuf)>,
    budget: &mut usize,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if *budget == 0 {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        if search_skipped_dir(&name, &rel) || search_secret_path(&rel) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            walk_search_files(&entry.path(), &rel, out, budget);
        } else if file_type.is_file() {
            *budget -= 1;
            out.push((rel, entry.path()));
        }
    }
}

fn file_mtime(path: &Path) -> std::time::SystemTime {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
}

/// `file_edit`: exact-string replacement with opencode semantics — the edit
/// is refused unless `old` matches exactly once, or `replace_all` is set.
///
/// Async because the read-modify-write below must happen under this path's
/// write lock: a turn's tool calls run concurrently, so two edits to one file
/// would otherwise both read the original text and the second write would
/// erase the first edit while reporting success. The guard is taken after
/// resolution (the key is a resolved path) and held to the end of the
/// function, which is what makes read-then-write atomic against other writers.
#[cfg(test)]
async fn apply_file_edit(
    root: &Path,
    slug: &str,
    rel: &str,
    old: &str,
    new: &str,
    replace_all: bool,
) -> Result<Value> {
    apply_file_edit_request(
        FileEditRequest {
            root,
            slug,
            rel,
            old,
            new,
            replace_all,
            workspace_override: None,
        },
        false,
    )
    .await
}

struct FileEditRequest<'a> {
    root: &'a Path,
    slug: &'a str,
    rel: &'a str,
    old: &'a str,
    new: &'a str,
    replace_all: bool,
    workspace_override: Option<&'a Path>,
}

async fn apply_file_edit_request(
    request: FileEditRequest<'_>,
    capture_activity: bool,
) -> Result<Value> {
    let FileEditRequest {
        root,
        slug,
        rel,
        old,
        new,
        replace_all,
        workspace_override,
    } = request;
    if old.is_empty() {
        anyhow::bail!("old_string must not be empty; use file_write to create a file");
    }
    if old == new {
        anyhow::bail!("old_string and new_string are identical — nothing to change");
    }
    let base = game_file_base(root, slug, workspace_override)?;
    let (path, _) = resolve_existing(&base, rel)?;
    reject_protected_write(&base.base, &path)?;
    let _write_lock = crate::pathlock::write_lock(&path).await;
    // `resolve_existing` already proved the file is there, so a failure here
    // is about its contents. Reporting it as "not found" would send the model
    // off to re-list a directory it has already seen.
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read {rel} as UTF-8 text; it may be binary"))?;
    // Reading here counts as having seen it: an edit proves current knowledge
    // of the file, so a later `file_write` should not be refused for it.
    crate::staleness::remember(&path);
    // Exact first, then layout-tolerant fallbacks. The fallbacks never accept
    // text that is not in the file — see `crate::edit_match` — so the refusals
    // below still mean what they always did.
    let Some(found) = crate::edit_match::find(&text, old) else {
        anyhow::bail!(
            "old_string not found in {rel}; read the file and pass the exact current text"
        );
    };
    let count = found.spans.len();
    if count > 1 && !replace_all {
        anyhow::bail!(
            "old_string matches {count} times in {rel}; add surrounding context to make it \
             unique, or set replace_all to true"
        );
    }
    let matched_by = found.strategy;
    let updated = {
        // Spliced by byte span rather than by `str::replace`, because a
        // fallback match is not literally equal to `old_string` — replacing by
        // value would find nothing.
        let mut spans = found.spans.clone();
        spans.sort_by_key(|(from, _)| *from);
        if !replace_all {
            spans.truncate(1);
        }
        let mut out = String::with_capacity(text.len());
        let mut cursor = 0usize;
        for (from, to) in &spans {
            out.push_str(&text[cursor..*from]);
            out.push_str(new);
            cursor = *to;
        }
        out.push_str(&text[cursor..]);
        out
    };
    if updated.len() > EDIT_MAX_WRITE_BYTES {
        anyhow::bail!("refusing to write more than {EDIT_MAX_WRITE_BYTES} bytes");
    }
    std::fs::write(&path, &updated)?;
    crate::staleness::remember(&path);
    // See `file_write`: the cheapest moment to learn an edit broke the file is
    // the result of that edit.
    let mut result = json!({
        "path": rel,
        "replacements": if replace_all { count } else { 1 },
        "written": true
    });
    if matched_by != crate::edit_match::Strategy::Exact {
        // Said out loud rather than silently accepted: the model's picture of
        // the file differs from the file, and the next edit it writes from the
        // same memory will differ too.
        result["matchedBy"] = json!(matched_by.label());
        result["note"] = json!(format!(
            "old_string did not match the file exactly — it was located {}. The file's own              formatting is unchanged; re-read {rel} before your next edit to it.",
            matched_by.label()
        ));
    }
    let result = crate::diagnostics::attach(
        result,
        &path,
        &updated,
        base.is_workspace.then_some(base.base.as_path()),
    );
    if capture_activity {
        let mut activity = activity_metadata("edit", rel, Some(activity_text(&text)), &updated);
        // A preview of the beginning of a large file may be byte-for-byte
        // identical even when an edit changed text much later. Keep the
        // bounded replacement itself so the editor can always render a
        // trustworthy local diff.
        activity["beforeSnippet"] = json!(activity_text(old).text);
        activity["afterSnippet"] = json!(activity_text(new).text);
        activity["replacements"] = json!(if replace_all { count } else { 1 });
        Ok(with_activity(result, activity))
    } else {
        Ok(result)
    }
}

/// `file_grep`: regex search over text files under `dir`, reporting paths
/// relative to the game base (`sub` is the subdirectory prefix `dir` sits
/// at, empty for the base itself). Binary files (NUL in the head) and files
/// over the read cap are skipped; results sort newest-file first.
fn grep_game_files(dir: &Path, sub: &str, pattern: &str, max_results: usize) -> Result<Value> {
    let regex = regex::Regex::new(pattern)
        .map_err(|err| anyhow::anyhow!("invalid regex pattern: {err}"))?;
    let max = max_results.clamp(1, GREP_MAX_MATCHES);
    let mut files = Vec::new();
    let mut budget = SEARCH_MAX_FILES_WALKED;
    walk_search_files(dir, sub, &mut files, &mut budget);
    let mut truncated = budget == 0;
    let mut rows: Vec<(std::time::SystemTime, String, u64, String)> = Vec::new();
    let mut out_bytes = 0usize;
    'files: for (rel, path) in files {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.len() > GREP_MAX_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if bytes[..bytes.len().min(8192)].contains(&0) {
            continue; // binary
        }
        let text = String::from_utf8_lossy(&bytes);
        let mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        for (idx, line) in text.lines().enumerate() {
            if !regex.is_match(line) {
                continue;
            }
            let shown: String = if line.chars().count() > GREP_MAX_LINE_CHARS {
                line.chars().take(GREP_MAX_LINE_CHARS).collect()
            } else {
                line.to_string()
            };
            out_bytes += rel.len() + shown.len();
            rows.push((mtime, rel.clone(), (idx + 1) as u64, shown));
            if rows.len() >= max || out_bytes >= GREP_MAX_OUTPUT_BYTES {
                truncated = true;
                break 'files;
            }
        }
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let matches: Vec<Value> = rows
        .iter()
        .map(|(_, rel, line, text)| json!({ "path": rel, "line": line, "text": text }))
        .collect();
    Ok(json!({
        "pattern": pattern,
        "matchCount": matches.len(),
        "truncated": truncated,
        "matches": matches
    }))
}

/// `file_glob`: match relative paths under the game base against a glob
/// pattern (`*` does not cross `/`; use `**` for recursion). Results sort
/// newest-modified first, capped at `GLOB_MAX_RESULTS`.
fn glob_game_files(base: &Path, pattern: &str) -> Result<Value> {
    let matcher = globset::GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map_err(|err| anyhow::anyhow!("invalid glob pattern: {err}"))?
        .compile_matcher();
    let mut files = Vec::new();
    let mut budget = SEARCH_MAX_FILES_WALKED;
    walk_search_files(base, "", &mut files, &mut budget);
    let mut hits: Vec<(std::time::SystemTime, String)> = files
        .into_iter()
        .filter(|(rel, _)| matcher.is_match(rel))
        .map(|(rel, path)| (file_mtime(&path), rel))
        .collect();
    hits.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let truncated = budget == 0 || hits.len() > GLOB_MAX_RESULTS;
    hits.truncate(GLOB_MAX_RESULTS);
    let files: Vec<&String> = hits.iter().map(|(_, rel)| rel).collect();
    Ok(json!({
        "pattern": pattern,
        "count": files.len(),
        "truncated": truncated,
        "files": files
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    #[serde(skip)]
    pub kind: ToolKind,
    /// Whether this tool needs the user's yes in the ordinary permission
    /// modes. Required on every literal, which is the point: a new core tool
    /// cannot be added without someone deciding, and a reviewer cannot miss
    /// the decision because it is not there to miss.
    ///
    /// `#[serde(default)]` covers browser tools, which arrive over
    /// `tool_register` from the client and therefore have no literal to
    /// enforce. Those are classified by name instead, so the default here is
    /// never the thing that decides — and it fails closed regardless.
    #[serde(default)]
    pub access: Access,
}

/// The approval classification of a tool.
///
/// Named for what it governs rather than for what the tool does to the disk:
/// several `ReadOnly` tools do write (`project_checkpoint`,
/// `test_baseline_save`, `asset_import_file`), and they are deliberately not
/// gated because what they write is additive and recoverable. The question
/// this answers is only ever "must the user say yes first".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Access {
    /// Runs without a prompt in `auto`: reads, searches, and writes the user
    /// would not mind discovering.
    ReadOnly,
    /// Asks first in every mode short of full access — it writes over the
    /// user's work, spends money, or starts something that outlives the turn.
    ///
    /// The default, so anything that arrives unclassified fails closed.
    #[default]
    Guarded,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub enum ToolKind {
    #[default]
    Core,
    Browser,
    /// Proxied to a configured MCP server; the name carries the
    /// `mcp__<server>__` prefix (see `crate::mcp`).
    Mcp,
}

/// The approval classification of a core tool, or `None` when the name is not
/// a core tool at all.
///
/// Built once: `core_tool_defs()` allocates ~54 definitions with their JSON
/// schemas, and this is consulted on the approval path of every tool call.
pub fn core_tool_access(name: &str) -> Option<Access> {
    use std::collections::HashMap;
    use std::sync::OnceLock;
    static INDEX: OnceLock<HashMap<String, Access>> = OnceLock::new();
    INDEX
        .get_or_init(|| {
            core_tool_defs()
                .into_iter()
                .map(|def| (def.name, def.access))
                .collect()
        })
        .get(name)
        .copied()
}

pub fn core_tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "project_list".into(),
            description: "List saved CaliCode projects.".into(),
            parameters: json!({"type":"object","properties":{}}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "project_open".into(),
            description: "Open a project by slug and return its full JSON state.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "project_checkpoint".into(),
            description: "Snapshot a project before a risky edit so it can be reverted.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "project_revert".into(),
            description: "Revert a project to a previous checkpoint.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"checkpointId":{"type":"string"}},"required":["slug","checkpointId"]}),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "file_read".into(),
            description: "Read a text file from the active game's folder (its attached workspace when it has one, otherwise the project). Returns a window: at most 2000 lines and 128KB per call, with very long lines clamped. When more of the file remains the result says exactly which offset to continue from — read that rather than guessing. Non-text files report what they are instead of returning bytes.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "slug":{"type":"string"},
                    "path":{"type":"string"},
                    "offset":{"type":"integer","minimum":1,"description":"first line to return, 1-indexed; defaults to 1"},
                    "limit":{"type":"integer","minimum":1,"maximum":5000,"description":"how many lines to return; defaults to 2000"}
                },
                "required":["slug","path"]
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "file_write".into(),
            description: "Write UTF-8 text into the active game's folder (scripts, tests, docs).".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"path":{"type":"string"},"content":{"type":"string"}},"required":["slug","path","content"]}),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "tool_output_read".into(),
            description: "Read the rest of a tool result that was too large to return inline. Use the outputId from that result's notice. Pages by byte offset: pass each nextOffset back as offset until it is null.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "outputId":{"type":"string","description":"the outputId from the truncated tool result"},
                    "offset":{"type":"integer","minimum":0,"description":"byte offset to start from; defaults to 0"},
                    "limit":{"type":"integer","minimum":1,"maximum":49152,"description":"how many bytes to return; defaults to 32768"}
                },
                "required":["outputId"]
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "file_list".into(),
            description: "List files and folders in the active game's folder. Omit path for the root. Use this to explore before reading.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"path":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "file_edit".into(),
            description: "Replace an exact string in a file in the active game's folder. Fails unless old_string matches exactly once — include enough surrounding lines to make it unique, or set replace_all to change every occurrence.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "slug":{"type":"string"},
                    "path":{"type":"string"},
                    "old_string":{"type":"string","description":"exact existing text to replace"},
                    "new_string":{"type":"string","description":"replacement text"},
                    "replace_all":{"type":"boolean","default":false}
                },
                "required":["slug","path","old_string","new_string"]
            }),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "file_grep".into(),
            description: "Search file contents under the active game's folder with a regular expression. Returns matching lines with file path and line number, newest files first. Optionally scope the search to a subdirectory with path.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "slug":{"type":"string"},
                    "pattern":{"type":"string","description":"Rust regex, matched per line"},
                    "path":{"type":"string","description":"subdirectory to search; omit for the whole folder"},
                    "max_results":{"type":"integer","minimum":1,"maximum":2000}
                },
                "required":["slug","pattern"]
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "file_glob".into(),
            description: "Find files by glob pattern under the active game's folder (e.g. '**/*.ts'; a bare '*' does not cross directories). Returns matching paths sorted by modification time, newest first.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "slug":{"type":"string"},
                    "pattern":{"type":"string"}
                },
                "required":["slug","pattern"]
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "asset_import_file".into(),
            description: "Import a file into the asset library as base64 data.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"name":{"type":"string"},"data":{"type":"string"},"mime":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}}},"required":["slug","name","data","mime"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "asset_hash_dedupe".into(),
            description: "Find duplicate asset files by SHA-256.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "asset_usage".into(),
            description: "Count entity references per asset.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "asset_export_gltf".into(),
            description: "Export an asset entry to a minimal glTF 2.0 file.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"assetId":{"type":"string"}},"required":["slug","assetId"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "blender_asset_export".into(),
            description: "Run Blender headlessly to rebuild a .blend-backed asset's GLB, waiting for the export to finish. Returns the written byte count.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"assetId":{"type":"string"}},"required":["slug","assetId"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "test_baseline_save".into(),
            description: "Save a screenshot baseline for a named test.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"name":{"type":"string"},"image":{"type":"string"}},"required":["slug","name","image"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "test_baseline_compare".into(),
            description: "Compare a screenshot to a saved baseline with perceptual hashing.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"name":{"type":"string"},"image":{"type":"string"},"threshold":{"type":"number"}},"required":["slug","name","image"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "image3d_ingest".into(),
            description: "Admit a reference image into the Rust image-to-3D pipeline.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"name":{"type":"string"},"image":{"type":"string"}},"required":["slug","name","image"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "image3d_validate".into(),
            description: "Strictly validate an image3d spec before generation.".into(),
            parameters: json!({"type":"object","properties":{"spec":{"type":"object"}},"required":["spec"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "model_list".into(),
            description: "List configured model providers and the active model.".into(),
            parameters: json!({"type":"object","properties":{}}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "model_switch".into(),
            description: "Switch the active provider and model.".into(),
            parameters: json!({"type":"object","properties":{"provider":{"type":"string"},"model":{"type":"string"}},"required":["provider","model"]}),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "subagent_spawn".into(),
            description: "Spawn a CaliCode subagent to complete a focused task; it can use the same scene, asset, PIE, and test tools. Script tasks must treat state.find/state.scene as frozen snapshots, use state.patch for cross-entity transforms, and use full finite {x,y,z} vectors. Test tasks must await non-tautological assertions with positive expectation messages.".to_string(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "role":{"type":"string","description":"Subagent role, e.g. planner, coder, tester, visual-critic"},
                    "instructions":{"type":"string","description":"Focused executable task. Do not request runtime material mutation; animate each entity through its own script or apply static material changes with editor tools before PIE."},
                    "maxTurns":{"type":"number"},
                    "projectSlug":{"type":"string"}
                },
                "required":["role","instructions"]
            }),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "skill_list".into(),
            description: "List available skills (name, description, scope) for this project.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string","description":"project slug"}}}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "skill_load".into(),
            description: "Load the full instructions of a skill by name. Use when a listed skill is relevant to the current task. A packaged skill also reports its support files under `files`; pass one of those paths as `file` to read it.".into(),
            parameters: json!({"type":"object","properties":{"name":{"type":"string"},"slug":{"type":"string"},"file":{"type":"string","description":"support file to read instead of the instructions, relative to the skill's own directory (e.g. references/game-feel.md)"}},"required":["name"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "asset_search".into(),
            description: "Search for assets across the project's local store, the attached asset-repo library catalogue, and PolyHaven's free CC0 catalogue. Returns scored hits with ready-made asset_pick arguments.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query":   {"type": "string", "description": "keywords, e.g. 'wooden barrel'"},
                    "slug":    {"type": "string", "description": "project slug; required for local hits"},
                    "sources": {"type": "array", "items": {"type": "string",
                                "enum": ["local", "library", "polyhaven"]},
                                "description": "default: all three"},
                    "types":   {"type": "array", "items": {"type": "string"},
                                "description": "filter by kind: cali, image, gltf, model, texture, hdri"},
                    "limit":   {"type": "integer", "minimum": 1, "maximum": 50}
                },
                "required": ["query"]
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "asset_pick".into(),
            description: "Import one asset_search hit into a project: attaches a library repo, or downloads a PolyHaven model into the project's assets and registers it. Pass the hit's `pick` object plus the slug.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "slug":    {"type": "string"},
                    "source":  {"type": "string", "enum": ["local", "library", "polyhaven"]},
                    "id":      {"type": "string"},
                    "name":    {"type": "string", "description": "override display name"},
                    "options": {"type": "object", "description": "polyhaven: {resolution: '1k'|'2k'|'4k'}"}
                },
                "required": ["slug", "source", "id"]
            }),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "image3d_mesh".into(),
            description: "Convert a reference image into a real textured 3D mesh asset (silhouette extrusion, heightfield relief, or lathe revolution) and register it in the project. Accepts a raw base64 image OR the assetId of an image already in the project — including images generated by an image model and imported via asset_import_file or ingested via image3d_ingest.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "slug":       {"type": "string"},
                    "name":       {"type": "string"},
                    "image":      {"type": "string", "description": "base64 or data URI; omit when assetId is given"},
                    "assetId":    {"type": "string", "description": "existing image/cali asset to use as source"},
                    "mode":       {"type": "string", "enum": ["extrude", "heightfield", "lathe"], "default": "extrude"},
                    "depth":      {"type": "number", "description": "extrusion depth / relief height in world units; omit for auto"},
                    "resolution": {"type": "integer", "minimum": 8, "maximum": 192},
                    "targetSize": {"type": "number", "default": 1.6}
                },
                "required": ["slug", "name"]
            }),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "image3d_review".into(),
            description: "Compare a rendered reconstruction screenshot with its exact reference image using deterministic fidelity checks and optional native vision review; records the result in the asset review history.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "slug":   {"type": "string"},
                    "assetId":{"type": "string", "description": "generated image-to-3D asset to review"},
                    "image":  {"type": "string", "description": "base64 or data URI screenshot of the reconstruction"},
                    "passId": {"type": "string", "description": "build pass being reviewed, e.g. blockout"}
                },
                "required": ["slug", "assetId", "image", "passId"]
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "graph_plan".into(),
            description: "Decompose a goal into a task graph (DAG). Provide either template (e.g. 'aaa-fps') or nodes. Each node runs as a subagent; deps form a DAG; a terminal judge node is added if missing. For multi-domain game work, keep at least three specialist Build roots dependency-free, converge them in a separate Integration Build, then make the Judge depend on Integration. id/role are slugs ([a-z0-9-], 1-48 chars) and are auto-slugified from common provider variants like 'Gameplay Specialist' or 'BuildCore'. deps is a list of node id strings (or an object whose keys are ids). kind is 'build' or 'judge'; a judge node requires `reference` and at least one build dep. Returns the validated graph.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "goal": {"type": "string", "minLength": 1, "description": "One-sentence goal. Required."},
                    "slug": {"type": "string", "description": "Project slug; required when ownerSession binds a project."},
                    "template": {"type": "string", "description": "Template id from template_list; mutually exclusive with `nodes`."},
                    "reasoningEffort": {"type": "string", "maxLength": 32, "description": "Coordinator effort inherited by graph workers, monitor, and judge."},
                    "nodes": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 24,
                        "description": "Explicit graph. Mutually exclusive with `template`.",
                        "items": {
                            "type": "object",
                            "required": ["id", "title", "kind", "role", "instructions", "acceptance", "deps"],
                            "properties": {
                                "id": {"type": "string", "pattern": "^[a-z0-9-]{1,48}$", "description": "Node id; slug [a-z0-9-], 1-48 chars. Auto-slugified from common provider variants."},
                                "title": {"type": "string", "minLength": 1, "description": "Human-readable name shown in the UI."},
                                "kind": {"type": "string", "enum": ["build", "judge"], "description": "build does work via a subagent; judge scores deps vs `reference`."},
                                "role": {"type": "string", "pattern": "^[a-z0-9-]{1,48}$", "description": "Worker persona slug (e.g. coder, artist, critic). Auto-slugified."},
                                "instructions": {"type": "string", "minLength": 1, "description": "Task body handed to the subagent. For scripts, state.find/state.scene are frozen snapshots; use state.patch for cross-entity transforms, full finite {x,y,z} vectors, and static editor updates rather than runtime material mutation."},
                                "acceptance": {"type": "array", "items": {"type": "string"}, "description": "Monitor pass criteria; non-empty strings. Test criteria must require awaited, non-tautological assertions with positive expectation messages."},
                                "deps": {
                                    "type": "array",
                                    "items": {"type": "string", "pattern": "^[a-z0-9-]{1,48}$"},
                                    "description": "Node ids this depends on. Empty for roots. Object form `{ \"id\": [] }` is auto-flattened."
                                },
                                "reference": {"type": "string", "minLength": 1, "description": "Required when kind=judge: named AAA reference (e.g. 'DOOM (2016) arena combat slice')."},
                                "threshold": {"type": "integer", "minimum": 0, "maximum": 100, "description": "Judge pass score 0-100, default 90."},
                                "maxTurns": {"type": "integer", "minimum": 1, "maximum": 1000, "description": "Subagent turn budget, default 100. Leave it unset unless the node is unusually cheap — the budget is a runaway backstop, not a work estimate."}
                            },
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["goal"],
                "additionalProperties": false
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "graph_run".into(),
            description: "Execute a planned graph to completion: each ready node runs as a subagent, a monitor checks it against its acceptance criteria, judge nodes score 0-100 vs their AAA reference and re-queue builders with a punch list until the threshold is met. Streams graph.updated events; returns the final rollup. Long-running.".into(),
            parameters: json!({"type":"object","properties":{"graphId":{"type":"string"}},"required":["graphId"]}),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "graph_status".into(),
            description: "Read a graph's current state (nodes, statuses, scores, punch lists).".into(),
            parameters: json!({"type":"object","properties":{"graphId":{"type":"string"}},"required":["graphId"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "graph_list".into(),
            description: "List saved graphs, optionally filtered by project slug.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"}}}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "graph_cancel".into(),
            description: "Cancel a running graph after the current node finishes.".into(),
            parameters: json!({"type":"object","properties":{"graphId":{"type":"string"}},"required":["graphId"]}),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "template_list".into(),
            description: "List goal templates (id, name, description) usable with graph_plan.".into(),
            parameters: json!({"type":"object","properties":{}}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "video_contact_sheet".into(),
            description: "Build and persist a labelled multi-frame contact sheet for motion review. Pass 2-64 PNG/JPEG frame data URLs in chronological order; the result includes motion metrics plus project-relative PNG and manifest paths for a visual judge.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "slug": {"type": "string"},
                    "label": {"type": "string", "description": "safe evidence name, e.g. walk-cycle-iteration-2"},
                    "frames": {
                        "type": "array",
                        "minItems": 2,
                        "maxItems": 64,
                        "items": {
                            "type": "object",
                            "properties": {
                                "image": {"type": "string", "description": "PNG/JPEG data URL or raw base64"},
                                "timestampSeconds": {"type": "number", "minimum": 0},
                                "frameNumber": {"type": "integer", "minimum": 1},
                                "caption": {"type": "string"}
                            },
                            "required": ["image", "timestampSeconds", "frameNumber"]
                        }
                    },
                    "tileWidth": {"type": "integer", "minimum": 32, "maximum": 640},
                    "columns": {"type": "integer", "minimum": 1, "maximum": 8}
                },
                "required": ["slug", "label", "frames"]
            }),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "loop_report_start".into(),
            description: "Start a durable per-iteration /loop progress report. It writes report.json, report.md, and a standalone report.html under the project and returns their project-relative paths.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "slug":{"type":"string"},
                    "loopId":{"type":"string"},
                    "objective":{"type":"string"},
                    "reference":{"type":"string"},
                    "startedAtMs":{"type":"integer","minimum":1}
                },
                "required":["slug","loopId","objective"]
            }),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "loop_report_iteration".into(),
            description: "Append one completed /loop iteration with agent roles, checks, changed-file stats, visual/video evidence, scores, punch list, and memory for the next iteration. Refreshes JSON/Markdown/HTML atomically.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "slug":{"type":"string"},
                    "loopId":{"type":"string"},
                    "iteration":{
                        "type":"object",
                        "description":"IterationInput. Field names are camelCase (startedAtMs/completedAtMs/changedFiles/punchList/nextIterationMemory); snake_case is also accepted and normalised before deserialization.",
                        "properties":{
                            "startedAtMs":{"type":"integer","minimum":0},
                            "completedAtMs":{"type":"integer","minimum":0},
                            "outcome":{"type":"string","enum":["passed","needs-work","failed","cancelled"]},
                            "summary":{"type":"string"},
                            "agents":{"type":"array","items":{"type":"object","properties":{
                                "role":{"type":"string"},"agentId":{"type":"string"},"task":{"type":"string"},
                                "outcome":{"type":"string","enum":["passed","failed","cancelled"]},
                                "summary":{"type":"string"},"durationMs":{"type":"integer","minimum":0}
                            },"required":["role","agentId","task","outcome"]}},
                            "checks":{"type":"array","items":{"type":"object","properties":{
                                "kind":{"type":"string","enum":["build","test","lint","play","performance","other"]},
                                "name":{"type":"string"},"command":{"type":"string"},
                                "status":{"type":"string","enum":["passed","failed","skipped"]},
                                "durationMs":{"type":"integer","minimum":0},"details":{"type":"string"}
                            },"required":["kind","name","status"]}},
                            "changedFiles":{"type":"array","items":{"type":"object","properties":{
                                "path":{"type":"string"},"additions":{"type":"integer","minimum":0},
                                "deletions":{"type":"integer","minimum":0}
                            },"required":["path"]}},
                            "evidence":{"type":"array","items":{"type":"object","properties":{
                                "kind":{"type":"string","enum":["screenshot","video","contact-sheet","trace","log","other"]},
                                "path":{"type":"string"},"caption":{"type":"string"},
                                "capturedAtMs":{"type":"integer","minimum":0}
                            },"required":["kind","path"]}},
                            "scores":{"type":"array","items":{"type":"object","properties":{
                                "criterion":{"type":"string"},"score":{"type":"integer","minimum":0},
                                "maximum":{"type":"integer","minimum":1},"passThreshold":{"type":"integer","minimum":0},
                                "rationale":{"type":"string"}
                            },"required":["criterion","score"]}},
                            "punchList":{"type":"array","items":{"type":"object","properties":{
                                "priority":{"type":"string","enum":["critical","high","medium","low"]},
                                "item":{"type":"string"},"source":{"type":"string"},"resolved":{"type":"boolean"}
                            },"required":["priority","item"]}},
                            "nextIterationMemory":{"type":"object","properties":{
                                "observations":{"type":"array","items":{"type":"string"}},
                                "decisions":{"type":"array","items":{"type":"string"}},
                                "risks":{"type":"array","items":{"type":"string"}},
                                "nextActions":{"type":"array","items":{"type":"string"}}
                            }}
                        },
                        "required":["startedAtMs","completedAtMs","outcome","summary"]
                    }
                },
                "required":["slug","loopId","iteration"]
            }),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "loop_report_update".into(),
            description: "Update a durable /loop report's terminal status, summary, final punch list, or next-iteration memory. Marking completed fails closed unless the report has a named reference, at least two iterations, a passed latest iteration with durable agents, clean build/play/test checks, changed files, visual evidence, an average score of at least 90 with every explicit threshold met, and carry-forward memory.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "slug":{"type":"string"},
                    "loopId":{"type":"string"},
                    "update":{"type":"object","description":"LoopUpdate; camelCase or snake_case accepted.","properties":{
                        "status":{"type":"string","enum":["running","completed","blocked","cancelled"]},
                        "completedAtMs":{"type":"integer","minimum":0},
                        "summary":{"type":"string"},
                        "recordedAtMs":{"type":"integer","minimum":0},
                        "punchList":{"type":"array"},
                        "nextIterationMemory":{"type":"object"}
                    }}
                },
                "required":["slug","loopId","update"]
            }),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "loop_report_list".into(),
            description: "List durable /loop reports for a project, newest first, without loading every iteration.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"}},"required":["slug"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "loop_report_open".into(),
            description: "Read a durable /loop report and return its data plus project-relative JSON, Markdown, and HTML paths.".into(),
            parameters: json!({"type":"object","properties":{"slug":{"type":"string"},"loopId":{"type":"string"}},"required":["slug","loopId"]}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "capture_persist".into(),
            description: "Persist a captured PNG or JPEG (delivered as a `data:image/...;base64,...` URL) to a project-relative path under the active game. Image-typed only: rejects any other MIME, base64 noise that does not decode to a real PNG/JPEG, paths that escape the project or land on a secret-named file, and payloads over the per-file ceiling. Writes atomically (temp file + rename) so a crash mid-write cannot leave a half-rendered frame the reviewer would trust.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "slug":{"type":"string"},
                    "path":{"type":"string","description":"project-relative target; must end in .png, .jpg, or .jpeg"},
                    "dataUrl":{"type":"string","description":"data:image/png or data:image/jpeg;base64,... payload"}
                },
                "required":["slug","path","dataUrl"]
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        // The browser. Note this is a real Chrome driven over the devtools
        // protocol (`browser.rs`), not the `editor_*` family that older
        // comments in this repo also call "browser tools".
        //
        // Descriptions carry the workflow, not just the arguments: a model
        // that has not been told to snapshot before clicking will guess a ref,
        // and a guessed ref is a click on whatever happens to be first.
        ToolDef {
            name: "browser_navigate".into(),
            description: "Open a URL in the agent's browser (a real Chrome, shared with the BROWSER tab the user is watching). Starts the browser on first use. Returns the settled URL and page title. Follow it with browser_snapshot to see what is on the page — this returns no page content by itself.".into(),
            parameters: json!({
                "type":"object",
                "properties":{"url":{"type":"string","description":"full https:// address; a bare host like example.com is accepted"}},
                "required":["url"]
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "browser_search".into(),
            description: "Search the web and get back a list of results as titles and URLs. This is the way to find something online — prefer it over navigating to a search engine yourself, which costs three calls and lands on a bot wall at google.com. Follow up with browser_navigate on the URL you want.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "query":{"type":"string"},
                    "limit":{"type":"integer","description":"how many results, 1-20 (default 8)"}
                },
                "required":["query"]
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "browser_snapshot".into(),
            description: "Read the current page as a short list of interactive elements, each tagged with a ref like [ref=e7]. This is the primary way to see a page — call it after every navigation or click, because refs are invalidated by both. Pass full=true to also include the page's visible text. Refs are the argument browser_click and browser_type expect.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "full":{"type":"boolean","description":"also include page text (default false: interactive elements only)"},
                    "limit":{"type":"integer","description":"character ceiling, 500-12000 (default 12000)"}
                }
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "browser_click".into(),
            description: "Click something. Either pass `ref` (the number from a [ref=eN] tag in the last browser_snapshot — pass 7 for e7) or an x/y viewport coordinate. Use coordinates only for a <canvas>, which has no refs at all: that is how you interact with a running CaliCode game. Take a fresh snapshot afterwards.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "ref":{"type":"integer","description":"the N from [ref=eN] in the last snapshot"},
                    "x":{"type":"number","description":"viewport x, for canvas clicks"},
                    "y":{"type":"number","description":"viewport y, for canvas clicks"},
                    "clicks":{"type":"integer","description":"1 for a click, 2 for a double-click (default 1)"}
                }
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "browser_type".into(),
            description: "Type text into the page. Pass `ref` to focus a field first (the usual case), and submit=true to press Enter afterwards — that is how you run a search in one call.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "text":{"type":"string"},
                    "ref":{"type":"integer","description":"field to focus first, from the last snapshot"},
                    "submit":{"type":"boolean","description":"press Enter after typing"}
                },
                "required":["text"]
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "browser_key".into(),
            description: "Press a key, optionally holding it down. Key names: a single character, or Enter, Tab, Escape, Space, ArrowUp/ArrowDown/ArrowLeft/ArrowRight, PageUp, PageDown, Home, End, Backspace, Delete. holdMs is what makes this different from typing: to drive a game, hold W for 1500ms rather than pressing it once.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "key":{"type":"string"},
                    "holdMs":{"type":"integer","description":"how long to hold the key down, up to 10000"},
                    "repeat":{"type":"integer","description":"press this many times (default 1)"}
                },
                "required":["key"]
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "browser_scroll".into(),
            description: "Scroll the page. Positive dy scrolls down. Elements below the fold are absent from a snapshot, so scroll and re-snapshot when what you want is not listed.".into(),
            parameters: json!({
                "type":"object",
                "properties":{"dy":{"type":"number","description":"vertical pixels (default 600)"},"dx":{"type":"number"}}
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "browser_look".into(),
            description: "Look at the page with a vision model and get a written answer. Use this when the answer is visual and therefore absent from a snapshot: what a 3D model preview actually looks like, whether a game rendered correctly, which of several thumbnails matches a reference. Ask a specific question.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "question":{"type":"string","description":"what you want to know about what is on screen"},
                    "fullPage":{"type":"boolean","description":"capture past the fold (default false)"}
                }
            }),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "browser_screenshot".into(),
            description: "Save the current page as a JPEG inside the game's folder and return its project-relative path. Use it to keep evidence — a reference image to reconstruct, a before/after of a game view. The image bytes never pass through this conversation; only the path comes back.".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "slug":{"type":"string"},
                    "path":{"type":"string","description":"project-relative target ending in .jpg or .png"},
                    "fullPage":{"type":"boolean"}
                },
                "required":["slug","path"]
            }),
            kind: ToolKind::Core,
            access: Access::Guarded,
        },
        ToolDef {
            name: "browser_console".into(),
            description: "Read console output and uncaught exceptions from the page since the last read. This is how you find out why a game you built renders black: the error is in here, not in the snapshot.".into(),
            parameters: json!({
                "type":"object",
                "properties":{"clear":{"type":"boolean","description":"drain the buffer (default true)"}}
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "browser_eval".into(),
            description: "Run a JavaScript expression in the page and return its value. The escape hatch for what the other tools cannot express — reading a value out of a running game, querying an element the snapshot missed. Return JSON-serialisable values; use JSON.stringify for anything structured.".into(),
            parameters: json!({
                "type":"object",
                "properties":{"expression":{"type":"string"}},
                "required":["expression"]
            }),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
        ToolDef {
            name: "browser_close".into(),
            description: "Shut the browser down and free its memory. Optional — the browser is reused across calls and closing it discards nothing but the current page.".into(),
            parameters: json!({"type":"object","properties":{}}),
            kind: ToolKind::Core,
            access: Access::ReadOnly,
        },
    ]
}

pub fn to_openai_schema(def: &ToolDef) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": def.name,
            "description": def.description,
            "parameters": def.parameters
        }
    })
}

pub async fn execute_core_tool(
    tool: &ToolDef,
    args: &Value,
    state: &AppState,
    projects_root: &Path,
    workspace_override: Option<&Path>,
) -> Result<Value> {
    execute_core_tool_with_activity(tool, args, state, projects_root, workspace_override, false)
        .await
}

/// Execute a core tool on behalf of the in-process agent.
///
/// The activity bridge is deliberately opt-in: public RPC calls must keep
/// returning the stable tool contract, while agent calls may carry a bounded
/// before/after preview out-of-band for the activity timeline.
pub(crate) async fn execute_core_tool_with_activity(
    tool: &ToolDef,
    args: &Value,
    state: &AppState,
    projects_root: &Path,
    workspace_override: Option<&Path>,
    capture_activity: bool,
) -> Result<Value> {
    let root = projects_root;
    // Cloned, not held: this guard used to span the whole match including
    // spawn_subagent().await, which deadlocked against a concurrent
    // model_switch writer.
    let config = { state.config.read().await.clone() };
    match tool.name.as_str() {
        "project_list" => Ok(store::list_projects(root)?),
        "project_open" => Ok(store::read_project(root, required_str(args, "slug")?)?),
        "project_checkpoint" => Ok(store::checkpoint_project(
            root,
            required_str(args, "slug")?,
        )?),
        "project_revert" => Ok(store::revert_checkpoint(
            root,
            required_str(args, "slug")?,
            required_str(args, "checkpointId")?,
        )?),
        // Every edit is preceded by a read and every grep hit becomes one, so
        // this is the most-called tool in a session — and its result is
        // re-sent to the model on every following turn. `fileread` bounds what
        // it can cost and makes each dead end name its own recovery; see that
        // module for why one ceiling is not enough.
        "file_read" => {
            let slug = required_str(args, "slug")?;
            let rel = crate::fileread::arg_path(args)?;
            let offset = crate::fileread::arg_count(args, "offset", 1)?;
            let limit =
                crate::fileread::arg_count(args, "limit", crate::fileread::DEFAULT_LINE_LIMIT)?;
            let base = game_file_base(root, slug, workspace_override)?;
            let (path, repair) = resolve_existing(&base, rel)?;
            // Baseline for the staleness guard on `file_write`. Recorded from
            // the file on disk rather than from the window returned, so a
            // paged read still establishes what the file looked like when the
            // agent looked at it.
            crate::staleness::remember(&path);
            let mut result = tokio::task::spawn_blocking({
                let rel = rel.to_string();
                move || crate::fileread::read_window(&path, &rel, offset, limit)
            })
            .await??;
            // A silent repair is a trap: the model would keep typing the
            // spelling that does not exist.
            if let Some(repair) = repair {
                let notice = match result["notice"].as_str() {
                    Some(existing) => format!("{repair} {existing}"),
                    None => repair,
                };
                result["notice"] = json!(notice);
            }
            if capture_activity {
                let path = result
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or(rel)
                    .to_string();
                Ok(with_activity(
                    result,
                    json!({
                        "operation": "read",
                        "path": path,
                    }),
                ))
            } else {
                Ok(result)
            }
        }
        "file_write" => {
            let rel = crate::fileread::arg_path(args)?;
            let base = game_file_base(root, required_str(args, "slug")?, workspace_override)?;
            let path = resolve_in_base(&base, rel)?;
            reject_protected_write(&base.base, &path)?;
            let content = required_str(args, "content")?;
            // Parity with file_edit and the workspace path, both of which
            // already refuse this. Without it the agent tool was the one way
            // to write an unbounded file.
            if content.len() > EDIT_MAX_WRITE_BYTES {
                anyhow::bail!("refusing to write more than {EDIT_MAX_WRITE_BYTES} bytes");
            }
            // Ordered behind any concurrent edit of the same file rather than
            // landing in the middle of one: a whole-file write that overlaps
            // an edit's read-modify-write makes one of the two vanish.
            let _write_lock = crate::pathlock::write_lock(&path).await;
            // A whole-file write replaces everything, so a file that moved
            // since it was read means somebody's work is about to vanish
            // without either of us noticing. `file_edit` needs no such guard —
            // its exact-match requirement is its own proof of a current read.
            if crate::staleness::changed_since_seen(&path) {
                anyhow::bail!(
                    "{rel} changed since you last read it, and file_write replaces the whole \
                     file. Read it again and write from what is there now, or use file_edit to \
                     change only the part you mean."
                );
            }
            let before = capture_activity
                .then(|| read_activity_text(&path))
                .flatten();
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, content)?;
            crate::staleness::remember(&path);
            // Answered here rather than left for the next PIE run: a file that
            // no longer parses costs one tool result to learn about now, and a
            // whole build-and-play round trip to learn about later.
            let result = crate::diagnostics::attach(
                json!({ "path": rel, "written": true, "bytes": content.len() }),
                &path,
                content,
                base.is_workspace.then_some(base.base.as_path()),
            );
            if capture_activity {
                Ok(with_activity(
                    result,
                    activity_metadata("write", rel, before, content),
                ))
            } else {
                Ok(result)
            }
        }
        // Reads nothing but core's own spill directory, addressed by id rather
        // than by path — the model never names a filesystem location here, so
        // this cannot become a way around `file_read`'s confinement.
        "tool_output_read" => crate::spill::read(
            &crate::spill::dir_for(&state.sessions_root),
            required_str(args, "outputId")?,
            args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize,
            args.get("limit")
                .and_then(Value::as_u64)
                .map(|n| n as usize),
        ),
        "file_list" => {
            let slug = required_str(args, "slug")?;
            let rel = args.get("path").and_then(Value::as_str).unwrap_or("");
            let base = game_file_base(root, slug, workspace_override)?;
            let dir = if rel.is_empty() {
                base.base.clone()
            } else {
                resolve_in_base(&base, rel)?
            };
            let mut entries: Vec<Value> = Vec::new();
            for entry in std::fs::read_dir(&dir)
                .with_context(|| format!("cannot list {}", dir.display()))?
                .flatten()
            {
                let name = entry.file_name().to_string_lossy().to_string();
                // Dotfiles are noise for an agent browsing a repo, and hiding
                // them also keeps .env-style secrets out of the listing.
                if name.starts_with('.') {
                    continue;
                }
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                entries.push(json!({
                    "name": name,
                    "kind": if is_dir { "dir" } else { "file" },
                }));
            }
            entries.sort_by(|a, b| {
                let key = |v: &Value| {
                    (
                        v["kind"].as_str() != Some("dir"),
                        v["name"].as_str().unwrap_or("").to_string(),
                    )
                };
                key(a).cmp(&key(b))
            });
            // Sorting first makes the cut deterministic: directories and the
            // alphabetically-early names survive, which is what an agent
            // orienting itself in a folder actually needs. A generated
            // directory of 50,000 sprites would otherwise land whole in the
            // context and stay there for the rest of the session.
            let total = entries.len();
            let mut result =
                json!({ "path": rel, "root": base.base.display().to_string(), "count": total });
            if total > LIST_MAX_ENTRIES {
                entries.truncate(LIST_MAX_ENTRIES);
                result["truncated"] = json!(true);
                result["notice"] = json!(format!(
                    "{dir_label} holds {total} visible entries; showing the first \
                     {LIST_MAX_ENTRIES} after sorting. Use file_glob to find a specific \
                     file, or file_list on a subdirectory.",
                    dir_label = if rel.is_empty() { "this folder" } else { rel },
                ));
            }
            result["entries"] = json!(entries);
            Ok(result)
        }
        "file_edit" => {
            apply_file_edit_request(
                FileEditRequest {
                    root,
                    slug: required_str(args, "slug")?,
                    rel: required_str(args, "path")?,
                    old: required_str(args, "old_string")?,
                    new: required_str(args, "new_string")?,
                    replace_all: args
                        .get("replace_all")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    workspace_override,
                },
                capture_activity,
            )
            .await
        }
        "file_grep" => {
            let slug = required_str(args, "slug")?;
            let base = game_file_base(root, slug, workspace_override)?;
            // Resolving the subdirectory through the base's own rules keeps
            // traversal and secret-path refusal applying to the scope too.
            let sub = args
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim_end_matches('/')
                .to_string();
            let dir = if sub.is_empty() {
                base.base.clone()
            } else {
                resolve_in_base(&base, &sub)?
            };
            let pattern = required_str(args, "pattern")?.to_string();
            let max = args
                .get("max_results")
                .and_then(Value::as_u64)
                .unwrap_or(GREP_MAX_MATCHES as u64) as usize;
            tokio::task::spawn_blocking(move || grep_game_files(&dir, &sub, &pattern, max)).await?
        }
        "file_glob" => {
            let slug = required_str(args, "slug")?;
            let base = game_file_base(root, slug, workspace_override)?;
            let pattern = required_str(args, "pattern")?.to_string();
            let dir = base.base;
            tokio::task::spawn_blocking(move || glob_game_files(&dir, &pattern)).await?
        }
        "asset_import_file" => {
            let tags = args["tags"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Ok(crate::assets::import_file(
                root,
                required_str(args, "slug")?,
                required_str(args, "name")?,
                required_str(args, "data")?,
                required_str(args, "mime")?,
                tags,
            )?)
        }
        "asset_hash_dedupe" => Ok(crate::assets::dedupe(root, required_str(args, "slug")?)?),
        "asset_usage" => Ok(crate::assets::usage(root, required_str(args, "slug")?)?),
        "asset_export_gltf" => Ok(crate::image3d::export_gltf(
            root,
            required_str(args, "slug")?,
            required_str(args, "assetId")?,
        )?),
        "blender_asset_export" => Ok(crate::blender::export(
            root,
            required_str(args, "slug")?,
            required_str(args, "assetId")?,
            crate::blender::DEFAULT_EXPORT_TIMEOUT,
        )
        .await?),
        "asset_search" => {
            let query = required_str(args, "query")?;
            let slug = args.get("slug").and_then(Value::as_str);
            let default: Vec<String> = crate::asset_search::DEFAULT_SOURCES
                .iter()
                .map(|s| s.to_string())
                .collect();
            let sources = args["sources"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect::<Vec<_>>()
                })
                .filter(|v| !v.is_empty())
                .unwrap_or(default);
            let types = args["types"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
            let catalog = state.asset_catalog.read().await.clone();
            crate::asset_search::search(&catalog, root, slug, query, &sources, &types, limit).await
        }
        "asset_pick" => {
            let catalog = state.asset_catalog.read().await.clone();
            crate::asset_search::pick(
                &catalog,
                root,
                required_str(args, "slug")?,
                required_str(args, "source")?,
                required_str(args, "id")?,
                args.get("name").and_then(Value::as_str),
                &args.get("options").cloned().unwrap_or(json!({})),
            )
            .await
        }
        "image3d_mesh" => {
            let slug = required_str(args, "slug")?.to_string();
            let name = required_str(args, "name")?.to_string();
            let bytes = match args.get("image").and_then(Value::as_str) {
                Some(b64) => {
                    let bytes = crate::baselines::decode_image_base64(b64)?;
                    // Inline bytes have no registry path yet. Register the
                    // exact source before the CPU mesh step so a later review
                    // can resolve it by hash without creating a duplicate
                    // image asset that the live editor would need to adopt.
                    crate::image3d::register_source_bytes(root, &slug, &bytes)?;
                    bytes
                }
                None => {
                    crate::image3d::load_source_bytes(root, &slug, required_str(args, "assetId")?)?
                }
            };
            let opts = crate::image_mesh::MeshOptions::from_args(args)?;
            // The generated asset must retain the identity of the exact bytes
            // that were meshed, not the caller's registry id or an inline
            // placeholder. Review later resolves this hash back to the source.
            let hash = crate::assets::sha256_bytes(&bytes);
            let mesh = tokio::task::spawn_blocking(move || {
                crate::image_mesh::image_to_mesh(&bytes, &opts)
            })
            .await??;
            crate::image3d::generate_mesh_asset(root, &slug, &name, &hash, &mesh)
        }
        "image3d_review" => {
            crate::image3d::review(
                root,
                required_str(args, "slug")?,
                required_str(args, "assetId")?,
                required_str(args, "image")?,
                required_str(args, "passId")?,
            )
            .await
        }
        "skill_list" => {
            let slug = args.get("slug").and_then(Value::as_str);
            Ok(json!({
                "skills": crate::skills::list_skills(root, slug, &config.skills.disabled)
            }))
        }
        "skill_load" => {
            let slug = args.get("slug").and_then(Value::as_str);
            let name = required_str(args, "name")?;
            let disabled = &config.skills.disabled;
            if let Some(file) = args.get("file").and_then(Value::as_str) {
                let (info, contents) =
                    crate::skills::load_skill_file(root, slug, name, file, disabled)?;
                return Ok(json!({
                    "name": info.name, "scope": info.scope, "file": file, "contents": contents
                }));
            }
            let (info, body) = crate::skills::load_skill(root, slug, name, disabled)?;
            let support = crate::skills::list_skill_files(&info);
            let mut out = json!({
                "name": info.name, "scope": info.scope, "instructions": body
            });
            // Only packaged skills carry this; a flat skill would otherwise
            // advertise an empty list the agent might try to read from.
            if !support.files.is_empty() {
                out["files"] = json!(support.files);
                out["filesTruncated"] = json!(support.truncated);
            }
            Ok(out)
        }
        "graph_plan" => crate::graph::plan_tool(state, args).await,
        "graph_run" => crate::graph::run(state, required_str(args, "graphId")?, None).await,
        "graph_status" => crate::graph::status(state, args),
        "graph_list" => crate::graph::list_tool(state, args),
        "graph_cancel" => crate::graph::cancel_tool(state, args).await,
        "template_list" => Ok(json!({
            "templates": crate::graph::list_templates(&state.sessions_root)
        })),
        "video_contact_sheet" => {
            let slug = required_str(args, "slug")?;
            let label = required_str(args, "label")?.to_string();
            let frames = args["frames"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("frames must be an array"))?;
            if !(2..=video_analysis::MAX_FRAMES).contains(&frames.len()) {
                anyhow::bail!(
                    "frames must contain between 2 and {} images",
                    video_analysis::MAX_FRAMES
                );
            }
            let frames = frames
                .iter()
                .map(|frame| {
                    let bytes = baselines::decode_image_base64(required_str(frame, "image")?)?;
                    let timestamp_seconds = frame["timestampSeconds"]
                        .as_f64()
                        .ok_or_else(|| anyhow::anyhow!("timestampSeconds must be a number"))?;
                    let frame_number = frame["frameNumber"]
                        .as_u64()
                        .and_then(|value| u32::try_from(value).ok())
                        .filter(|value| *value > 0)
                        .ok_or_else(|| anyhow::anyhow!("frameNumber must be a positive integer"))?;
                    Ok(video_analysis::VideoFrame {
                        bytes,
                        timestamp_seconds,
                        frame_number,
                        caption: frame
                            .get("caption")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let config = video_analysis::ContactSheetConfig {
                tile_width: args["tileWidth"]
                    .as_u64()
                    .and_then(|value| u32::try_from(value).ok())
                    .unwrap_or(video_analysis::DEFAULT_TILE_WIDTH),
                columns: args["columns"]
                    .as_u64()
                    .and_then(|value| u32::try_from(value).ok()),
                ..video_analysis::ContactSheetConfig::default()
            };
            let reports = store::project_dir(root, slug)?
                .join("reports")
                .join("video");
            let frame_count = frames.len();
            let persisted = tokio::task::spawn_blocking(move || {
                video_analysis::persist_report(&reports, &label, &frames, &config)
            })
            .await??;
            let project_dir = store::project_dir(root, slug)?;
            let relative = |path: &Path| {
                path.strip_prefix(&project_dir)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .to_string()
            };
            Ok(json!({
                "pngPath": relative(&persisted.png_path),
                "manifestPath": relative(&persisted.manifest_path),
                "pngBytes": persisted.png_bytes,
                "frames": frame_count,
            }))
        }
        "capture_persist" => {
            let slug = required_str(args, "slug")?;
            let rel = crate::fileread::arg_path(args)?;
            let data_url = required_str(args, "dataUrl")?;
            // Same resolver ladder as `file_write`: a captured frame lives
            // wherever the rest of the project's files live, including an
            // attached workspace when one is bound.
            let persisted = crate::capture_persist::persist_capture(
                root,
                slug,
                rel,
                data_url,
                workspace_override,
            )?;
            Ok(crate::capture_persist::as_json(&persisted))
        }
        // Every browser arm reaches the same lazily-launched Chrome. The
        // launch is inside `ensure`, so the first tool the model happens to
        // call is the one that pays for it and none of them have to be
        // ordered after an explicit open.
        "browser_navigate" => {
            // Argument first, browser second, here and below: a misspelled
            // argument should cost an error, not a Chrome launch.
            let url = required_str(args, "url")?;
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            browser.navigate(url).await
        }
        "browser_search" => {
            let query = required_str(args, "query")?;
            let limit = args["limit"].as_u64().unwrap_or(8).clamp(1, 20) as usize;
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            browser.search(query, limit).await
        }
        "browser_snapshot" => {
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            let full = args["full"].as_bool().unwrap_or(false);
            let limit = args["limit"].as_u64().unwrap_or(12_000) as usize;
            let text = browser.snapshot(!full, limit).await?;
            Ok(json!({ "snapshot": text }))
        }
        "browser_click" => {
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            let clicks = args["clicks"].as_u64().unwrap_or(1).clamp(1, 3) as u32;
            let target = match (args["ref"].as_u64(), args["x"].as_f64(), args["y"].as_f64()) {
                (Some(reference), _, _) => crate::browser::ClickTarget::Ref(reference as u32),
                (None, Some(x), Some(y)) => crate::browser::ClickTarget::Point(x, y),
                // A click with neither would otherwise land at (0,0) — the top
                // left corner, which on most pages is the site logo, i.e. a
                // navigation away from wherever the model meant to click.
                _ => anyhow::bail!(
                    "browser_click needs either `ref` (from a [ref=eN] tag in the last \
                     browser_snapshot) or both `x` and `y`"
                ),
            };
            browser.click(target, clicks).await
        }
        "browser_type" => {
            let text = required_str(args, "text")?;
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            browser
                .type_text(
                    args["ref"].as_u64().map(|reference| reference as u32),
                    text,
                    args["submit"].as_bool().unwrap_or(false),
                )
                .await
        }
        "browser_key" => {
            let key = required_str(args, "key")?;
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            browser
                .key(
                    key,
                    args["holdMs"].as_u64().unwrap_or(0),
                    args["repeat"].as_u64().unwrap_or(1).clamp(1, 50) as u32,
                )
                .await
        }
        "browser_scroll" => {
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            browser
                .scroll(
                    args["dx"].as_f64().unwrap_or(0.0),
                    args["dy"].as_f64().unwrap_or(600.0),
                )
                .await
        }
        "browser_look" => {
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            let frame = browser
                .screenshot(args["fullPage"].as_bool().unwrap_or(false))
                .await?;
            let question = args["question"]
                .as_str()
                .map(str::trim)
                .filter(|question| !question.is_empty())
                .unwrap_or("Describe what is on this page and what can be done with it.");
            // The main loop's tool results are text, so the frame cannot ride
            // back with them. It goes to a vision model here instead and the
            // model's words are what the agent reads — the same shape
            // `image3d_review` uses, and the reason a provider without vision
            // degrades to a clear refusal rather than a confident guess.
            let message = json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": format!(
                        "You are looking at a screenshot of a web page an agent is driving. \
                         Answer concretely and briefly.\n\nQuestion: {question}"
                    ) },
                    { "type": "image_url", "image_url": { "url": crate::browser::data_url(&frame) } }
                ]
            });
            match crate::model::chat(&config, &[message], None, None).await {
                Ok(result) => Ok(json!({
                    "answer": result.content,
                    "model": config.model.default,
                })),
                Err(error) => Ok(json!({
                    "error": format!("vision review unavailable: {error}"),
                    "hint": "the active model may not accept images; use browser_snapshot instead",
                })),
            }
        }
        "browser_screenshot" => {
            let slug = required_str(args, "slug")?;
            let rel = crate::fileread::arg_path(args)?;
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            let frame = browser
                .screenshot(args["fullPage"].as_bool().unwrap_or(false))
                .await?;
            let persisted = crate::capture_persist::persist_capture(
                root,
                slug,
                rel,
                &crate::browser::data_url(&frame),
                workspace_override,
            )?;
            Ok(crate::capture_persist::as_json(&persisted))
        }
        "browser_console" => {
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            let lines = browser
                .console(args["clear"].as_bool().unwrap_or(true))
                .await;
            Ok(json!({ "count": lines.len(), "lines": lines }))
        }
        "browser_eval" => {
            let expression = required_str(args, "expression")?;
            let browser = state.browsers.ensure(state.bus.clone()).await?;
            let value = browser.eval(expression).await?;
            Ok(json!({ "value": value }))
        }
        "browser_close" => {
            state.browsers.shutdown().await;
            Ok(json!({ "closed": true }))
        }
        "loop_report_start" => {
            let slug = required_str(args, "slug")?;
            let loop_id = required_str(args, "loopId")?;
            let started_at_ms = args["startedAtMs"].as_u64().unwrap_or_else(current_time_ms);
            let report = crate::loop_report::create(
                root,
                slug,
                loop_id,
                crate::loop_report::NewLoopReport {
                    objective: required_str(args, "objective")?.to_string(),
                    reference: args
                        .get("reference")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    started_at_ms,
                },
            )?;
            loop_report_result(root, slug, loop_id, report)
        }
        "loop_report_iteration" => {
            let slug = required_str(args, "slug")?;
            let loop_id = required_str(args, "loopId")?;
            // Accept either camelCase (AgentPanel fallback) or snake_case
            // (a strict coordinator guessing the schema) by pre-renaming
            // snake_case keys on the iteration payload. The on-disk schema
            // stays camelCase so existing reports round-trip unchanged.
            let raw_iteration = args
                .get("iteration")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("iteration is required"))?;
            let raw_iteration = crate::loop_report::normalize_iteration_payload(raw_iteration);
            let input = serde_json::from_value::<crate::loop_report::IterationInput>(raw_iteration)
                .map_err(|error| {
                    anyhow::anyhow!(
                        "invalid loop iteration for {slug}/{loop_id}: {error}",
                        slug = slug,
                        loop_id = loop_id,
                    )
                })?;
            let report = crate::loop_report::append_iteration(root, slug, loop_id, input)?;
            loop_report_result(root, slug, loop_id, report)
        }
        "loop_report_update" => {
            let slug = required_str(args, "slug")?;
            let loop_id = required_str(args, "loopId")?;
            let raw_update = args
                .get("update")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("update is required"))?;
            let raw_update = crate::loop_report::normalize_update_payload(raw_update);
            let update = serde_json::from_value::<crate::loop_report::LoopUpdate>(raw_update)
                .map_err(|error| {
                    anyhow::anyhow!(
                        "invalid loop update for {slug}/{loop_id}: {error}",
                        slug = slug,
                        loop_id = loop_id,
                    )
                })?;
            let report = crate::loop_report::update(root, slug, loop_id, update)?;
            loop_report_result(root, slug, loop_id, report)
        }
        "loop_report_list" => Ok(json!({
            "reports": crate::loop_report::list(root, required_str(args, "slug")?)?
        })),
        "loop_report_open" => {
            let slug = required_str(args, "slug")?;
            let loop_id = required_str(args, "loopId")?;
            let report = crate::loop_report::load(root, slug, loop_id)?;
            loop_report_result(root, slug, loop_id, report)
        }
        "test_baseline_save" => Ok(baselines::save_baseline(
            root,
            required_str(args, "slug")?,
            required_str(args, "name")?,
            required_str(args, "image")?,
        )?),
        "test_baseline_compare" => Ok(baselines::compare_baseline(
            root,
            required_str(args, "slug")?,
            required_str(args, "name")?,
            required_str(args, "image")?,
            args["threshold"].as_u64().unwrap_or(8) as u32,
        )?),
        "image3d_ingest" => Ok(image3d::ingest(
            root,
            required_str(args, "slug")?,
            required_str(args, "name")?,
            required_str(args, "image")?,
        )?),
        "image3d_validate" => Ok(image3d::validate_spec(&args["spec"])?),
        "model_list" => Ok(model_list(&config)?),
        "model_switch" => {
            drop(config);
            let mut config = state.config.write().await;
            model_switch(
                &mut config,
                required_str(args, "provider")?,
                required_str(args, "model")?,
            )
            .map_err(anyhow::Error::msg)
        }
        "subagent_spawn" => spawn_subagent(state, args).await,
        _ => anyhow::bail!("unknown core tool {}", tool.name),
    }
}

/// System prompt for a spawned subagent: the caller's full override when
/// `system` is given, otherwise the default role blurb — plus, whenever the
/// spawn names a project, the same compact project digest graph-spawned nodes
/// receive (graph-engineer §3.1). Direct spawns previously got no project
/// context at all.
fn subagent_system(
    projects_root: &std::path::Path,
    role: &str,
    system: Option<&str>,
    slug: Option<&str>,
) -> String {
    if let Some(system) = system {
        return system.to_string();
    }
    let mut prompt = format!(
        "You are a {role} subagent inside CaliCode, an AI game engine harness. \
         You have full access to the scene, asset workbench, PIE runtime, and test tools. \
         Work independently, call tools when they help, and finish with a concise report."
    );
    if let Some(slug) = slug {
        prompt.push_str("\n\nProject: ");
        prompt.push_str(&crate::rpc::project_digest(projects_root, slug));
    }
    prompt
}

/// Deepest agent a chain of `subagent_spawn` calls may create. Depth 0 is a
/// top-level agent (or a directly spawned graph node); a spawn that would put
/// the child deeper than this is refused before any model call.
pub const MAX_SUBAGENT_DEPTH: usize = 2;

/// The spawning agent's identity, threaded in from
/// `AgentManager::execute_tool_call`. It exists so a child can never run
/// wider than its parent (a supervised parent used to spawn full-access
/// children, silently escaping supervision) and so the child's approval
/// prompts surface on the session the user is actually watching.
pub struct SpawnParent {
    /// The parent's permission mode; the child inherits it verbatim.
    pub permission_mode: String,
    /// The parent's per-turn reasoning effort; children inherit it verbatim.
    pub reasoning_effort: Option<String>,
    /// Root ancestor session id — `agent.approval_request` events for the
    /// child (and its descendants) are emitted under this id.
    pub approval_session: String,
    /// The panel whose work this is, already resolved by the spawning agent
    /// (`ApprovalOwner::resolve`). `None` when the parent itself is
    /// unattended — a child of unattended work is unattended too, and must
    /// not invent an owner by naming itself.
    pub owner_session: Option<String>,
    /// The graph run the parent belongs to, inherited verbatim: a graph
    /// node's own subagent is still that run's work, and a cancelled run must
    /// take its grandchildren's prompts with it.
    pub owner_graph: Option<String>,
    /// The parent's own depth (0 = top level).
    pub depth: usize,
    /// The parent's ordered permission rules — inherited verbatim so a
    /// child can never dodge a `deny` by being spawned.
    pub permission_rules: Vec<crate::agent::PermissionRule>,
    pub workspace_root: Option<String>,
    /// The parent's model context window. A child runs the same model, so it
    /// must size compaction to the same window rather than falling back to the
    /// 128k assumption.
    pub context_length: Option<u32>,
}

/// Direct spawns — the `subagent_spawn` RPC and graph build/judge nodes —
/// keep their explicit full-access permission MODE at depth 0. They do NOT
/// skip the config's permission RULES: those are resolved from global config
/// (plus the named project's tightening rules) by
/// [`permission_rules_for_binding`]. Agent-initiated spawns must come through
/// [`spawn_subagent_for_parent`] instead, inheriting the parent's rules.
pub async fn spawn_subagent(state: &AppState, args: &Value) -> Result<Value> {
    spawn_subagent_with(state, args, None, None, false).await
}

/// Spawn on behalf of a connected panel: the same direct-spawn contract as
/// [`spawn_subagent`], plus the calling session recorded as the approval
/// owner.
///
/// Without this a panel that spawned a subagent could not tell that
/// subagent's approval prompts from another window's: the child asks under
/// its own fresh session id, which nothing on the wire tied back to the panel
/// that asked for it. `owner_session` is a Rust argument rather than an
/// argument key on purpose — a model drives `subagent_spawn`'s args, and must
/// not be able to address its prompts at somebody's panel.
pub(crate) async fn spawn_subagent_for_client(
    state: &AppState,
    args: &Value,
    owner_session: Option<&str>,
) -> Result<Value> {
    spawn_subagent_with(state, args, None, owner_session, false).await
}

/// Spawn a graph attempt into a session the engine already reserved.
///
/// The binding lives under a private object and is enabled by a Rust-only
/// flag. Public/direct `subagent_spawn` calls cannot smuggle it even if they
/// guess the key; ordinary `sessionId`/`approvalSession`/`workspaceRoot`
/// arguments are ignored too.
pub(crate) async fn spawn_graph_subagent(
    state: &AppState,
    args: &Value,
    session_id: &str,
    graph_id: &str,
    approval_session: Option<&str>,
    workspace_root: Option<&str>,
) -> Result<Value> {
    spawn_graph_subagent_with_effort(
        state,
        args,
        session_id,
        graph_id,
        approval_session,
        workspace_root,
        None,
    )
    .await
}

/// Spawn a graph attempt with the coordinator's request-scoped reasoning
/// effort. The value lives in the private binding so public subagent callers
/// cannot widen or otherwise alter a graph's trusted setting.
pub(crate) async fn spawn_graph_subagent_with_effort(
    state: &AppState,
    args: &Value,
    session_id: &str,
    graph_id: &str,
    approval_session: Option<&str>,
    workspace_root: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Result<Value> {
    let mut bound = args.clone();
    let object = bound
        .as_object_mut()
        .context("subagent arguments must be an object")?;
    object.insert(
        "_graphBinding".into(),
        json!({
        "sessionId": session_id,
        "graphId": graph_id,
        "approvalSession": approval_session,
        "workspaceRoot": workspace_root,
        "reasoningEffort": reasoning_effort,
        "finalResponseDrain": true,
        }),
    );
    // The graph's owner session is both the approval address and the owner:
    // a graph is planned by a session a human opened, and its nodes' prompts
    // belong to that panel. `spawn_subagent_with` derives the owner from the
    // binding, so an ownerless graph stays ownerless. The graph id rides in
    // the same private binding — it says which RUN the prompt came from,
    // which the owner session alone cannot (a panel's turns and its graph's
    // nodes are owned by, and addressed to, the same session).
    spawn_subagent_with(state, &bound, None, None, true).await
}

/// Role keys this spawn may be routed by, most specific first.
///
/// The engine can name a more specific key than the plan's role — a judge node
/// is spawned with role `critic` but should honour a `judge:` mapping — and it
/// passes that as `_modelRoleHint`. The hint is read only when this spawn also
/// carries the engine's private graph binding, so the same key in a model's own
/// `subagent_spawn` arguments is ignored: routing stays the user's choice.
fn model_role_candidates(engine_spawn: bool, args: &Value, role: &str) -> Vec<String> {
    let mut candidates = Vec::with_capacity(2);
    if engine_spawn {
        if let Some(hint) = args
            .get("_modelRoleHint")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|hint| !hint.is_empty())
        {
            candidates.push(hint.to_string());
        }
    }
    candidates.push(role.to_string());
    candidates
}

/// Permission rules a directly spawned agent runs under: the global list plus
/// tightening rules from its bound workspace (or the project's default base
/// when no session workspace is bound).
///
/// This exists because a direct spawn has no parent to inherit from. Before
/// it, `permission_rules: Vec::new()` meant every graph wave worker and every
/// `subagent_spawn` RPC ran with the user's `deny`/`ask` rules silently
/// disabled.
pub(crate) async fn permission_rules_for_binding(
    state: &AppState,
    slug: Option<&str>,
    workspace_root: Option<&str>,
) -> Vec<crate::agent::PermissionRule> {
    permission_rules_for_workspace(state, slug, workspace_root).await
}

async fn permission_rules_for_workspace(
    state: &AppState,
    slug: Option<&str>,
    workspace_root: Option<&str>,
) -> Vec<crate::agent::PermissionRule> {
    let global = { state.config.read().await.permissions.clone() };
    let base = workspace_root
        .map(str::trim)
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
        .filter(|root| root.is_dir())
        .or_else(|| slug.and_then(|slug| project_config_base(&state.projects_root, slug)));
    let merged = match base {
        Some(base) => crate::config::merge_permission_rules(
            &global,
            &crate::config::load_project_config(&base).permissions,
        ),
        None => global,
    };
    crate::config::agent_permission_rules(&merged)
}

/// Where a project's `.cali/config.yaml` lives: the attached workspace folder
/// when one is bound and still a directory, else the project's own folder.
/// Mirrors `project_open`'s base resolution so a rule file the user sees
/// applied to MCP servers is the same file that binds permissions.
fn project_config_base(projects_root: &Path, slug: &str) -> Option<PathBuf> {
    let project = store::read_project(projects_root, slug).ok()?;
    project
        .get("workspaceRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| store::project_dir(projects_root, slug).ok())
}

/// Spawn a subagent on behalf of a running agent: the child inherits the
/// parent's permission mode (never wider), routes approvals to the parent's
/// root session, and counts one level deeper against `MAX_SUBAGENT_DEPTH`.
pub async fn spawn_subagent_for_parent(
    state: &AppState,
    args: &Value,
    parent: SpawnParent,
) -> Result<Value> {
    spawn_subagent_with(state, args, Some(parent), None, false).await
}

async fn spawn_subagent_with(
    state: &AppState,
    args: &Value,
    parent: Option<SpawnParent>,
    client_owner: Option<&str>,
    allow_graph_binding: bool,
) -> Result<Value> {
    let depth = parent.as_ref().map(|p| p.depth + 1).unwrap_or(0);
    if depth > MAX_SUBAGENT_DEPTH {
        anyhow::bail!(
            "subagent depth cap reached ({MAX_SUBAGENT_DEPTH}): finish this task yourself instead of delegating further"
        );
    }
    let mut registered = state.tools.read().await.clone();
    registered.extend(state.mcp.tool_defs().await);
    let role = required_str(args, "role")?;
    let instructions = required_str(args, "instructions")?;
    let max_turns = args["maxTurns"]
        .as_u64()
        .map(|value| value as usize)
        .unwrap_or(crate::agent::DEFAULT_MAX_TURNS);
    let slug = args
        .get("projectSlug")
        .and_then(|v| v.as_str())
        .map(String::from);
    let mut system = subagent_system(
        &state.projects_root,
        role,
        args.get("system").and_then(Value::as_str),
        slug.as_deref(),
    );
    let disabled = { state.config.read().await.skills.disabled.clone() };
    system.push_str(&crate::skills::prompt_index(
        &state.projects_root,
        slug.as_deref(),
        &disabled,
    ));
    let permission_mode = parent
        .as_ref()
        .map(|p| p.permission_mode.clone())
        .unwrap_or_else(|| "full-access".into());
    let internal_binding = args
        .get("_graphBinding")
        .and_then(Value::as_object)
        .filter(|_| allow_graph_binding && parent.is_none());
    let permission_rules = match parent.as_ref() {
        Some(parent) => parent.permission_rules.clone(),
        None => {
            let bound_workspace = internal_binding
                .and_then(|binding| binding.get("workspaceRoot"))
                .and_then(Value::as_str);
            permission_rules_for_workspace(state, slug.as_deref(), bound_workspace).await
        }
    };
    let explicit_session = internal_binding
        .and_then(|binding| binding.get("sessionId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let explicit_approval_session = internal_binding
        .and_then(|binding| binding.get("approvalSession"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let explicit_workspace_root = internal_binding
        .and_then(|binding| binding.get("workspaceRoot"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let explicit_reasoning_effort = internal_binding
        .and_then(|binding| binding.get("reasoningEffort"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 32)
        .map(str::to_string);
    let final_response_drain = internal_binding
        .and_then(|binding| binding.get("finalResponseDrain"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // Whose panel this subagent's approval prompts belong to. An
    // agent-initiated spawn inherits the resolved owner of the agent that
    // asked for it; a direct spawn takes the calling panel's session (RPC) or
    // the graph owner from the private binding. None of those existing means
    // nobody is watching, and the child says so instead of naming itself.
    let approval_owner = crate::agent::ApprovalOwner::from_ancestor(match parent.as_ref() {
        Some(parent) => parent.owner_session.clone(),
        None => client_owner
            .map(str::to_string)
            .or_else(|| explicit_approval_session.clone()),
    });
    // Which run this work belongs to: inherited from the spawning agent, or
    // taken from the graph binding for a node the engine spawns itself. A
    // direct or client spawn belongs to no run and says so. Like the owner
    // session, it is never read from model-authored arguments — only from a
    // parent or from the private binding.
    let owner_graph = match parent.as_ref() {
        Some(parent) => parent.owner_graph.clone(),
        None => internal_binding
            .and_then(|binding| binding.get("graphId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|graph_id| !graph_id.is_empty())
            .map(str::to_string),
    };
    let options = crate::agent::AgentOptions {
        permission_mode: permission_mode.clone(),
        max_turns,
        // Inherited like the rest of the parent's turn shape: a subagent runs
        // the same model, so sizing its compaction to a different window would
        // make it compact at the wrong point.
        context_length: parent.as_ref().and_then(|parent| parent.context_length),
        final_response_drain,
        reasoning_effort: parent
            .as_ref()
            .and_then(|parent| parent.reasoning_effort.clone())
            .or(explicit_reasoning_effort),
        loop_id: None,
        system: Some(system),
        model_roles: model_role_candidates(internal_binding.is_some(), args, role),
        project_slug: slug,
        workspace_root: parent
            .as_ref()
            .and_then(|parent| parent.workspace_root.clone())
            .or(explicit_workspace_root),
        approval_session: parent
            .as_ref()
            .map(|p| p.approval_session.clone())
            .or(explicit_approval_session),
        approval_owner,
        owner_graph,
        subagent_depth: depth,
        permission_rules,
    };
    let result = Box::pin(state.agents.chat(
        state,
        &registered,
        explicit_session.as_deref(),
        &[json!({ "role": "user", "content": instructions })],
        options,
    ))
    .await?;
    if explicit_session
        .as_deref()
        .is_some_and(|expected| result["sessionId"].as_str() != Some(expected))
    {
        anyhow::bail!("subagent returned a different session than the reserved session");
    }
    Ok(json!({
        "role": role,
        "sessionId": result["sessionId"],
        "reply": result["reply"],
        "toolCalls": summarize_tool_calls(&result["toolCalls"]),
        "turns": result["turns"],
        "status": result["status"],
        "completed": result["completed"],
        "terminalReason": result["terminalReason"],
        "permissionMode": permission_mode,
        "depth": depth
    }))
}

/// Compact a subagent's tool-call log for the parent's context.
///
/// The raw log carries every call's full `arguments`, so a child that wrote a
/// file put that file's entire body into the PARENT's message history — where
/// it was re-sent on every following turn, having already been paid for once
/// inside the child. The parent needs to know what the child did, not to
/// replay its inputs. `chat`'s own return value keeps the full array; the
/// client renders it and never re-sends it to a model.
fn summarize_tool_calls(log: &Value) -> Value {
    let Some(calls) = log.as_array() else {
        return json!({ "total": 0 });
    };
    let mut counts: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for call in calls {
        let name = call["name"].as_str().unwrap_or("unknown");
        *counts.entry(name).or_default() += 1;
    }
    json!({ "total": calls.len(), "byTool": counts })
}

pub fn model_list(config: &crate::config::AppConfig) -> Result<Value> {
    Ok(json!({
        "active": { "provider": config.model.provider, "model": config.model.default, "baseUrl": config.model.base_url },
        "providers": config.providers
    }))
}

/// Adds a provider or extends an existing one from the Settings UI, so users
/// no longer hand-edit `~/.cali/config.yaml`.
///
/// Non-secret fields (id, label, base URL, model ids) persist into the config
/// file. API keys stay env-only, matching how `api_key()` resolves them: a key
/// passed here is applied to the running process (works immediately) and the
/// result reports which env var (`apiKeyEnv`) the user must export to survive
/// a core restart.
pub fn model_provider_upsert(
    config: &mut crate::config::AppConfig,
    id: &str,
    label: Option<&str>,
    base_url: Option<&str>,
    api_key: Option<&str>,
    models: &[String],
) -> Result<Value> {
    let id = id.trim();
    if id.is_empty() {
        anyhow::bail!("provider id must not be empty");
    }
    let api_key_env = match config.providers.iter_mut().find(|p| p.id == id) {
        Some(preset) => {
            if let Some(label) = label.map(str::trim).filter(|l| !l.is_empty()) {
                preset.label = label.to_string();
            }
            if let Some(url) = base_url.map(str::trim).filter(|u| !u.is_empty()) {
                preset.base_url = url.trim_end_matches('/').to_string();
            }
            for model in models {
                let model = model.trim();
                if !model.is_empty() && !preset.models.iter().any(|m| m == model) {
                    preset.models.push(model.to_string());
                }
            }
            preset.api_key_env.clone()
        }
        None => {
            let url = base_url
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .ok_or_else(|| anyhow::anyhow!("baseUrl is required for a new provider"))?;
            let env_id: String = id
                .to_uppercase()
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                .collect();
            let api_key_env = format!("CALI_{}_API_KEY", env_id);
            let mut deduped: Vec<String> = Vec::new();
            for model in models {
                let model = model.trim();
                if !model.is_empty() && !deduped.iter().any(|m| m == model) {
                    deduped.push(model.to_string());
                }
            }
            config.providers.push(crate::config::ProviderPreset {
                id: id.to_string(),
                label: label
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .unwrap_or(id)
                    .to_string(),
                base_url: url.trim_end_matches('/').to_string(),
                api_key_env: api_key_env.clone(),
                models: deduped,
            });
            api_key_env
        }
    };
    let mut key_applied = false;
    if let Some(key) = api_key.map(str::trim).filter(|k| !k.is_empty()) {
        std::env::set_var(&api_key_env, key);
        key_applied = true;
    }
    // Keep the active model block coherent if the edited provider is active.
    if config.model.provider == id {
        if let Some(preset) = config.providers.iter().find(|p| p.id == id) {
            config.model.base_url = preset.base_url.clone();
            config.model.api_key_env = preset.api_key_env.clone();
        }
    }
    crate::config::save(config)?;
    let mut result = model_list(config)?;
    result["apiKeyEnv"] = json!(api_key_env);
    result["keyApplied"] = json!(key_applied);
    Ok(result)
}

pub fn model_switch(
    config: &mut crate::config::AppConfig,
    provider: &str,
    model: &str,
) -> Result<Value> {
    let preset = config
        .providers
        .iter()
        .find(|p| p.id == provider)
        .ok_or_else(|| anyhow::anyhow!("unknown provider {}", provider))?;
    config.model.provider = preset.id.clone();
    config.model.default = model.to_string();
    config.model.base_url = preset.base_url.clone();
    config.model.api_key_env = preset.api_key_env.clone();
    crate::config::save(config)?;
    model_list(config)
}

/// A required string argument, or an error the model can act on.
///
/// The message is written for its actual reader. A validator dump like
/// "missing required string slug" tells a model that something is wrong but
/// not what to send, so the retry is a guess — and a guess costs another turn.
/// Naming what arrived is the part that distinguishes the three ways this
/// fails: absent, null, or the right key holding the wrong type (a number or
/// an object), which look identical from inside the model.
pub fn required_str<'a>(value: &'a Value, key: &'a str) -> Result<&'a str> {
    match value.get(key) {
        Some(Value::String(text)) => Ok(text),
        found => {
            let saw = match found {
                None => "it was not provided".to_string(),
                Some(Value::Null) => "it was null".to_string(),
                Some(other) => format!(
                    "it was {}: {}",
                    json_type_name(other),
                    clamp_for_error(&other.to_string())
                ),
            };
            anyhow::bail!(
                "the `{key}` argument must be a string, but {saw}. Call the tool again with \
                 `{key}` set to a string."
            )
        }
    }
}

/// Echo back enough of a bad value to identify it, and no more. The whole
/// point is a short, actionable message; quoting a 2MB argument back at the
/// model would cost more than the mistake did.
fn clamp_for_error(text: &str) -> String {
    const MAX: usize = 120;
    if text.chars().count() <= MAX {
        return text.to_string();
    }
    let kept: String = text.chars().take(MAX).collect();
    format!("{kept}…")
}

/// The JSON type name a model would recognise from its own schema.
fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

fn current_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn loop_report_result(
    root: &Path,
    slug: &str,
    loop_id: &str,
    report: crate::loop_report::LoopReport,
) -> Result<Value> {
    let project_dir = store::project_dir(root, slug)?;
    let paths = crate::loop_report::report_paths(root, slug, loop_id)?;
    let relative = |path: &Path| {
        path.strip_prefix(&project_dir)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string()
    };
    Ok(json!({
        "report": report,
        "projectRoot": project_dir.to_string_lossy(),
        "jsonPath": relative(&paths.json),
        "markdownPath": relative(&paths.markdown),
        "htmlPath": relative(&paths.html),
    }))
}

#[cfg(test)]
mod tests {

    use super::*;
    use crate::agent::AgentManager;
    use crate::config::{AppConfig, ModelConfig};
    use axum::extract::State;
    use axum::response::sse::{Event, Sse};
    use axum::routing::post;
    use axum::Router;
    use std::collections::HashMap;
    use std::convert::Infallible;
    use std::sync::Arc;

    /// Every registered tool must have a dispatch arm.
    ///
    /// A tool def with no arm is worse than a missing tool: it is advertised
    /// to the model in the schema, chosen, and then fails with "unknown core
    /// tool" at the moment it is needed. This caught `browser_search` reaching
    /// the agent before its arm existed.
    #[tokio::test]
    async fn every_core_tool_def_has_a_dispatch_arm() {
        let dir = tempfile::tempdir().unwrap();
        // Point the browser at a binary that does not exist. Every browser
        // tool then fails at launch in microseconds instead of starting a real
        // Chrome per tool — the error text is what this test reads anyway.
        std::env::set_var("CALI_CHROME", dir.path().join("no-such-chrome"));
        // Belt and braces: if that ever stops taking effect, a launched chrome
        // must not reach the real profile, where contending for the lock costs
        // this test the full 25s launch timeout instead of failing fast.
        std::env::set_var("CALI_BROWSER_PROFILE", dir.path().join("profile"));
        let state = mock_state("127.0.0.1:1".parse().unwrap());
        for def in core_tool_defs() {
            let outcome = execute_core_tool(&def, &json!({}), &state, dir.path(), None).await;
            if let Err(error) = outcome {
                assert!(
                    !error.to_string().contains("unknown core tool"),
                    "{} is registered but has no dispatch arm",
                    def.name
                );
            }
        }
    }

    /// The browser's surface, as the model sees it.
    #[test]
    fn browser_tools_are_registered_with_usable_schemas() {
        let defs = core_tool_defs();
        let browser: Vec<&ToolDef> = defs
            .iter()
            .filter(|def| def.name.starts_with("browser_"))
            .collect();
        assert_eq!(
            browser.len(),
            12,
            "browser surface changed; update the docs in AGENTS.md too"
        );
        for def in &browser {
            assert!(
                !def.description.is_empty() && def.description.len() > 60,
                "{} needs a description that says when to use it, not just what it is",
                def.name
            );
            assert_eq!(def.parameters["type"], "object", "{}", def.name);
            // A model reads the schema, not the source. Required arguments
            // that are not declared are the single most common reason a tool
            // is called with an empty object.
            assert!(def.parameters.get("properties").is_some(), "{}", def.name);
        }
        // The two the model reaches for first must not need a slug or any
        // other project context: research happens before a project exists.
        for name in ["browser_search", "browser_navigate"] {
            let def = browser.iter().find(|def| def.name == name).unwrap();
            let required = def.parameters["required"].as_array().unwrap();
            assert!(!required.iter().any(|value| value == "slug"), "{name}");
        }
    }

    async fn final_provider() -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        Sse::new(futures::stream::iter(vec![
            Ok(Event::default()
                .data(r#"{"choices":[{"delta":{"role":"assistant","content":"subagent done"}}]}"#)),
            Ok(Event::default().data("[DONE]")),
        ]))
    }

    async fn effort_provider(
        State(requests): State<Arc<std::sync::Mutex<Vec<Value>>>>,
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        requests.lock().unwrap().push(body);
        final_provider().await
    }

    fn mock_state(addr: std::net::SocketAddr) -> crate::AppState {
        let config = AppConfig {
            model: ModelConfig {
                default: "mock".into(),
                provider: "mock".into(),
                base_url: format!("http://{}/v1", addr),
                api_key_env: "CALI_MOCK_KEY".into(),
                temperature: 0.0,
                max_tokens: Some(64),
                roles: Default::default(),
            },
            providers: vec![],
            ..Default::default()
        };
        let (bus, _) = tokio::sync::broadcast::channel(32);
        let agents = AgentManager::new(bus.clone());
        crate::AppState {
            config: std::sync::Arc::new(tokio::sync::RwLock::new(config)),
            projects_root: tempfile::tempdir().unwrap().path().to_path_buf(),
            sessions_root: tempfile::tempdir().unwrap().path().to_path_buf(),
            agents,
            graphs: crate::graph::GraphManager::new(),
            bus: bus.clone(),
            workspaces: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::workspace::Registry::new(),
            )),
            dev_servers: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::devserver::Servers::new(),
            )),
            terminals: crate::terminal::Terminals::default(),
            browsers: crate::browser::Browsers::new(),
            shutdown: std::sync::Arc::new(tokio::sync::watch::channel(false).0),
            tools: std::sync::Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            editor_bridge: crate::editor_bridge::EditorBridge::new(bus.clone()),
            editor_attachment: std::sync::Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            mcp: std::sync::Arc::new(crate::mcp::McpManager::default()),
            asset_catalog: std::sync::Arc::new(tokio::sync::RwLock::new(Vec::new())),
        }
    }

    async fn mock_provider_addr() -> std::net::SocketAddr {
        let app = Router::new().route("/v1/chat/completions", post(final_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        addr
    }

    #[tokio::test]
    async fn subagent_spawn_runs_focused_agent() {
        let addr = mock_provider_addr().await;
        let state = mock_state(addr);
        let def = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "subagent_spawn")
            .unwrap();
        let result = execute_core_tool(
            &def,
            &json!({ "role": "tester", "instructions": "Run the scene tests.", "maxTurns": 3, "projectSlug": "starter" }),
            &state,
            &state.projects_root,
            None,
        )
        .await
        .unwrap();
        assert_eq!(result["role"], "tester");
        assert!(result["reply"].as_str().unwrap().contains("subagent done"));
        assert!(result["sessionId"]
            .as_str()
            .unwrap()
            .starts_with("session-"));
        // Direct spawns (RPC, graph nodes) keep the explicit legacy contract.
        assert_eq!(result["permissionMode"], "full-access");
        assert_eq!(result["depth"], 0);
    }

    #[tokio::test]
    async fn public_spawn_cannot_choose_internal_routing() {
        let addr = mock_provider_addr().await;
        let state = mock_state(addr);
        let result = spawn_subagent(
            &state,
            &json!({
                "role": "tester",
                "instructions": "report status",
                "sessionId": "session-attacker",
                "approvalSession": "session-foreign",
                "workspaceRoot": "/tmp/foreign-workspace",
                "_graphBinding": {
                    "sessionId": "session-attacker",
                    "approvalSession": "session-foreign",
                    "workspaceRoot": "/tmp/foreign-workspace"
                }
            }),
        )
        .await
        .unwrap();

        assert_ne!(result["sessionId"], "session-attacker");
        assert!(state
            .agents
            .sessions()
            .await
            .iter()
            .all(|session| session["id"] != "session-attacker"));
    }

    #[tokio::test]
    async fn graph_spawn_uses_the_reserved_session() {
        let addr = mock_provider_addr().await;
        let state = mock_state(addr);
        let session_id = state.agents.reserve_session().await.unwrap();
        let result = spawn_graph_subagent(
            &state,
            &json!({ "role": "tester", "instructions": "report status" }),
            &session_id,
            "graph-probe",
            Some("session-owner"),
            Some("/tmp/workspace"),
        )
        .await
        .unwrap();

        assert_eq!(result["sessionId"], session_id);
    }

    /// Stands in for the model: asks for one `browser_search`, then reports
    /// back whatever the tool returned so the test can read what the model
    /// would have seen.
    async fn searching_provider(
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let tool_result = body["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|message| message["role"] == "tool")
            .and_then(|message| message["content"].as_str())
            .map(str::to_string);
        match tool_result {
            Some(seen) => {
                let echoed = serde_json::to_string(&seen).unwrap();
                Sse::new(futures::stream::iter(vec![
                    Ok(Event::default()
                        .data(format!(r#"{{"choices":[{{"delta":{{"content":{echoed}}}}}]}}"#))),
                    Ok(Event::default().data("[DONE]")),
                ]))
            }
            None => Sse::new(futures::stream::iter(vec![
                Ok(Event::default().data(
                    r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-search","function":{"name":"browser_search","arguments":"{\"query\":\"low poly spaceship 3d model\",\"limit\":5}"}}]}}]}"#,
                )),
                Ok(Event::default()
                    .data(r#"{"choices":[{"finish_reason":"tool_calls","delta":{}}]}"#)),
                Ok(Event::default().data("[DONE]")),
            ])),
        }
    }

    /// The agent loop actually driving the browser, end to end.
    ///
    /// Everything else about the browser is verified by calling
    /// `execute_core_tool` directly, which proves the tool works but not that
    /// an agent turn can reach it: the schema has to survive registration, the
    /// call has to clear the approval policy, dispatch has to find an arm, and
    /// the result has to come back into the transcript as something a model
    /// can read. This covers that whole path with a scripted model, so the
    /// only thing left unproven is the model's own judgement.
    ///
    /// Ignored because it needs Chrome and the network. Run with:
    /// `cargo test browser_tool -- --ignored`
    #[tokio::test]
    #[ignore = "needs a real Chrome and network"]
    async fn an_agent_turn_can_search_the_web_and_read_the_results() {
        let app = Router::new().route("/v1/chat/completions", post(searching_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let state = mock_state(addr);
        let registered: HashMap<String, ToolDef> = core_tool_defs()
            .into_iter()
            .filter(|def| def.name == "browser_search")
            .map(|def| (def.name.clone(), def))
            .collect();
        assert_eq!(registered.len(), 1, "browser_search must be registered");

        let result = state
            .agents
            .chat(
                &state,
                &registered,
                None,
                &[json!({ "role": "user", "content": "find me a low poly spaceship model" })],
                crate::agent::AgentOptions {
                    // `auto` rather than `full-access`: this must also prove the
                    // browser is reachable without the user opting out of the
                    // approval flow entirely.
                    permission_mode: "auto".into(),
                    max_turns: 4,
                    ..Default::default()
                },
            )
            .await
            .expect("agent turn should complete");

        assert_eq!(result["status"], "completed");
        let calls = result["toolCalls"].as_array().unwrap();
        assert_eq!(calls.len(), 1, "expected one browser_search call");
        assert_eq!(calls[0]["name"], "browser_search");
        assert_eq!(calls[0]["status"], "done", "the tool call must not error");

        // The reply is the tool result echoed back, so this is literally what
        // the model received.
        let seen = result["reply"].as_str().unwrap();
        assert!(
            seen.contains("results"),
            "model saw no results field: {seen}"
        );
        assert!(seen.contains("http"), "model saw no usable urls: {seen}");
        state.browsers.shutdown().await;
    }

    async fn browser_call_provider(
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let has_tool = body["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|message| message["role"] == "tool");
        if has_tool {
            Sse::new(futures::stream::iter(vec![
                Ok(Event::default().data(r#"{"choices":[{"delta":{"content":"done"}}]}"#)),
                Ok(Event::default().data("[DONE]")),
            ]))
        } else {
            Sse::new(futures::stream::iter(vec![
                Ok(Event::default().data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-echo","function":{"name":"editor_echo","arguments":"{}"}}]}}]}"#)),
                Ok(Event::default().data(r#"{"choices":[{"finish_reason":"tool_calls","delta":{}}]}"#)),
                Ok(Event::default().data("[DONE]")),
            ]))
        }
    }

    #[tokio::test]
    async fn graph_spawn_routes_browser_tools_to_its_owner_binding() {
        let app = Router::new().route("/v1/chat/completions", post(browser_call_provider));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let state = mock_state(addr);
        state.tools.write().await.insert(
            "editor_echo".into(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object"}),
                kind: ToolKind::Browser,
                access: Access::Guarded,
            },
        );
        let owner = "session-owner";
        let workspace = "/tmp/graph-workspace";
        let session_id = state.agents.reserve_session().await.unwrap();
        let mut rx = state.bus.subscribe();
        let agents = state.agents.clone();
        let child_id = session_id.clone();
        let responder = tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                if event["type"] == "agent.tool_request" {
                    assert_eq!(event["sessionId"], child_id);
                    assert_eq!(event["targetSessionId"], owner);
                    assert_eq!(event["workspaceRoot"], workspace);
                    agents
                        .submit_tool_result(
                            event["sessionId"].as_str().unwrap(),
                            event["requestId"].as_str().unwrap(),
                            json!({ "ok": true }),
                        )
                        .await
                        .unwrap();
                    return;
                }
            }
        });

        let result = spawn_graph_subagent(
            &state,
            &json!({ "role": "tester", "instructions": "use the editor" }),
            &session_id,
            "graph-probe",
            Some(owner),
            Some(workspace),
        )
        .await
        .unwrap();
        responder.await.unwrap();
        assert_eq!(result["sessionId"], session_id);
    }

    #[tokio::test]
    async fn subagent_inherits_supervised_parent_mode() {
        // The bug this covers: a supervised parent spawned full-access
        // children, silently escaping supervision.
        let addr = mock_provider_addr().await;
        let state = mock_state(addr);
        let result = spawn_subagent_for_parent(
            &state,
            &json!({ "role": "helper", "instructions": "report status", "maxTurns": 2 }),
            SpawnParent {
                permission_mode: "supervised".into(),
                reasoning_effort: None,
                approval_session: "session-parent".into(),
                owner_session: None,
                owner_graph: None,
                depth: 0,
                permission_rules: Vec::new(),
                workspace_root: None,
                context_length: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result["permissionMode"], "supervised");
        assert_eq!(result["depth"], 1);
        assert!(result["reply"].as_str().unwrap().contains("subagent done"));

        // Depth 2 (a grandchild) is still within the cap.
        let grandchild = spawn_subagent_for_parent(
            &state,
            &json!({ "role": "helper", "instructions": "report status", "maxTurns": 2 }),
            SpawnParent {
                permission_mode: "auto".into(),
                reasoning_effort: None,
                approval_session: "session-parent".into(),
                owner_session: None,
                owner_graph: None,
                depth: 1,
                permission_rules: Vec::new(),
                workspace_root: None,
                context_length: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(grandchild["depth"], 2);
        assert_eq!(grandchild["permissionMode"], "auto");
    }

    #[tokio::test]
    async fn subagent_inherits_parent_reasoning_effort() {
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/v1/chat/completions", post(effort_provider))
            .with_state(requests.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let state = mock_state(addr);

        spawn_subagent_for_parent(
            &state,
            &json!({ "role": "helper", "instructions": "report status", "maxTurns": 2 }),
            SpawnParent {
                permission_mode: "auto".into(),
                reasoning_effort: Some("max".into()),
                approval_session: "session-parent".into(),
                owner_session: None,
                owner_graph: None,
                depth: 0,
                permission_rules: Vec::new(),
                workspace_root: None,
                context_length: None,
            },
        )
        .await
        .unwrap();

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["reasoning_effort"], "max");
    }

    /// The point of fanning out is specialists, and specialists are only
    /// distinct if their models can be. The role the spawner names is what
    /// selects one; anything unmapped keeps the user's picked model.
    #[tokio::test]
    async fn a_subagent_runs_the_model_its_role_is_routed_to() {
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/v1/chat/completions", post(effort_provider))
            .with_state(requests.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let state = mock_state(addr);
        {
            let mut config = state.config.write().await;
            config
                .model
                .roles
                .insert("coder".into(), "minimax-m3".into());
        }

        for role in ["coder", "artist"] {
            spawn_subagent(
                &state,
                &json!({ "role": role, "instructions": "report status", "maxTurns": 1 }),
            )
            .await
            .unwrap();
        }

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["model"], "minimax-m3");
        assert_eq!(requests[1]["model"], "mock");
    }

    #[test]
    fn only_an_engine_spawn_may_offer_a_more_specific_role_key() {
        let args = json!({ "role": "critic", "_modelRoleHint": "judge" });
        assert_eq!(
            model_role_candidates(true, &args, "critic"),
            vec!["judge".to_string(), "critic".to_string()]
        );
        // The same key in a model's own arguments is ignored: routing may only
        // be widened by the engine, never by the agent being spawned.
        assert_eq!(
            model_role_candidates(false, &args, "critic"),
            vec!["critic".to_string()]
        );
    }

    /// Role routing is a user setting, so the argument surface a model drives
    /// must not reach it — otherwise a subagent could name its own model and
    /// leave the provider the user chose.
    #[tokio::test]
    async fn a_model_authored_model_argument_cannot_reroute_a_spawn() {
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/v1/chat/completions", post(effort_provider))
            .with_state(requests.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let state = mock_state(addr);

        spawn_subagent(
            &state,
            &json!({
                "role": "coder",
                "instructions": "report status",
                "maxTurns": 1,
                "model": "gpt-5.6-luna",
                "provider": "codex-router",
                "baseUrl": "http://127.0.0.1:4100/v1",
            }),
        )
        .await
        .unwrap();

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1, "the spawn must still reach the mock");
        assert_eq!(requests[0]["model"], "mock");
    }

    #[tokio::test]
    async fn depth_three_subagent_spawn_is_refused() {
        // Depth check fires before any model call, so a dead base_url is fine.
        let state = mock_state("127.0.0.1:9".parse().unwrap());
        let err = spawn_subagent_for_parent(
            &state,
            &json!({ "role": "helper", "instructions": "go deeper" }),
            SpawnParent {
                permission_mode: "full-access".into(),
                reasoning_effort: None,
                approval_session: "session-root".into(),
                owner_session: None,
                owner_graph: None,
                depth: MAX_SUBAGENT_DEPTH,
                permission_rules: Vec::new(),
                workspace_root: None,
                context_length: None,
            },
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains("depth cap"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn subagent_default_prompt_carries_project_digest() {
        let root = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();

        // With a project slug the default prompt gains the compact digest —
        // the same context graph-spawned nodes get.
        let with_slug = subagent_system(root.path(), "coder", None, Some("demo"));
        assert!(with_slug.starts_with("You are a coder subagent"));
        assert!(
            with_slug.contains("Project: slug \"demo\""),
            "digest missing: {with_slug}"
        );
        assert!(with_slug.contains("entities"));

        // Without a slug the legacy prompt shape is unchanged.
        let without_slug = subagent_system(root.path(), "coder", None, None);
        assert!(without_slug.starts_with("You are a coder subagent"));
        assert!(!without_slug.contains("Project:"));

        // An explicit `system` is a full override — no digest appended.
        let overridden =
            subagent_system(root.path(), "coder", Some("Custom prompt."), Some("demo"));
        assert_eq!(overridden, "Custom prompt.");

        // A slug that does not resolve still yields a usable prompt.
        let missing = subagent_system(root.path(), "coder", None, Some("ghost"));
        assert!(missing.contains("not readable yet"));
    }

    #[test]
    fn model_provider_upsert_creates_and_extends_providers() {
        // Point config::save at a scratch file so the test never touches the
        // user's real ~/.cali/config.yaml.
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CALI_CONFIG", dir.path().join("config.yaml"));
        let mut config = AppConfig {
            providers: crate::config::default_providers(),
            ..Default::default()
        };

        // New provider: baseUrl required, env var derived from the id.
        let result = model_provider_upsert(
            &mut config,
            "my-router",
            Some("My Router"),
            Some("https://router.example.com/v1/"),
            Some("sk-test"),
            &["fast-model".into(), "fast-model".into(), "".into()],
        )
        .unwrap();
        assert_eq!(result["apiKeyEnv"], "CALI_MY_ROUTER_API_KEY");
        assert_eq!(result["keyApplied"], true);
        assert_eq!(std::env::var("CALI_MY_ROUTER_API_KEY").unwrap(), "sk-test");
        let preset = config
            .providers
            .iter()
            .find(|p| p.id == "my-router")
            .unwrap();
        assert_eq!(preset.base_url, "https://router.example.com/v1");
        assert_eq!(preset.models, vec!["fast-model".to_string()]);

        // Upsert on an existing provider appends models without duplicating.
        model_provider_upsert(
            &mut config,
            "my-router",
            None,
            None,
            None,
            &["fast-model".into(), "smart-model".into()],
        )
        .unwrap();
        let preset = config
            .providers
            .iter()
            .find(|p| p.id == "my-router")
            .unwrap();
        assert_eq!(
            preset.models,
            vec!["fast-model".to_string(), "smart-model".to_string()]
        );

        // A new provider without a base URL is rejected.
        assert!(model_provider_upsert(&mut config, "no-url", None, None, None, &[]).is_err());
        std::env::remove_var("CALI_MY_ROUTER_API_KEY");
        std::env::remove_var("CALI_CONFIG");
    }

    #[test]
    fn file_tools_target_the_projects_dir_when_no_folder_is_attached() {
        let root = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();

        let base = game_file_base(root.path(), "demo", None).unwrap();
        assert!(!base.is_workspace);
        assert_eq!(base.base, store::project_dir(root.path(), "demo").unwrap());
    }

    #[test]
    fn file_tools_follow_the_game_to_its_attached_folder() {
        // The bug this covers: an agent working on a real repo read from
        // ~/.cali/projects/<slug> and got "No such file or directory" for
        // every file in the game's actual folder.
        let root = tempfile::tempdir().unwrap();
        let game_folder = tempfile::tempdir().unwrap();
        std::fs::write(game_folder.path().join("README.md"), "# real game").unwrap();

        store::create_project(root.path(), "demo", "Demo").unwrap();
        store::set_workspace_root(
            root.path(),
            "demo",
            Some(game_folder.path().to_str().unwrap()),
        )
        .unwrap();

        let base = game_file_base(root.path(), "demo", None).unwrap();
        assert!(base.is_workspace);

        let (_, resolved) = resolve_game_file(root.path(), "demo", "README.md").unwrap();
        assert_eq!(std::fs::read_to_string(resolved).unwrap(), "# real game");
    }

    #[tokio::test]
    async fn session_workspace_override_wins_over_project_workspace() {
        let root = tempfile::tempdir().unwrap();
        let project_folder = tempfile::tempdir().unwrap();
        let session_folder = tempfile::tempdir().unwrap();
        std::fs::write(project_folder.path().join("which.txt"), "project").unwrap();
        std::fs::write(session_folder.path().join("which.txt"), "session-b").unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        store::set_workspace_root(root.path(), "demo", project_folder.path().to_str()).unwrap();
        let state = mock_state("127.0.0.1:9".parse().unwrap());
        let def = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "file_read")
            .unwrap();

        let result = execute_core_tool(
            &def,
            &json!({ "slug": "demo", "path": "which.txt" }),
            &state,
            root.path(),
            Some(session_folder.path()),
        )
        .await
        .unwrap();
        assert_eq!(result["content"], "session-b");
    }

    #[test]
    fn attached_folder_still_refuses_traversal_and_secrets() {
        let root = tempfile::tempdir().unwrap();
        let game_folder = tempfile::tempdir().unwrap();
        std::fs::write(game_folder.path().join(".env"), "SECRET=1").unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        store::set_workspace_root(
            root.path(),
            "demo",
            Some(game_folder.path().to_str().unwrap()),
        )
        .unwrap();

        assert!(resolve_game_file(root.path(), "demo", "../escape.txt").is_err());
        assert!(resolve_game_file(root.path(), "demo", "/etc/passwd").is_err());
        assert!(resolve_game_file(root.path(), "demo", ".env").is_err());
    }

    /// Root + attached game folder, ready for the file-surgery tools.
    fn game_with_workspace() -> (tempfile::TempDir, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        store::set_workspace_root(root.path(), "demo", Some(folder.path().to_str().unwrap()))
            .unwrap();
        (root, folder)
    }

    fn set_mtime(path: &Path, secs_after_epoch: u64) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs_after_epoch),
        ))
        .unwrap();
    }

    #[tokio::test]
    async fn tool_output_read_pages_a_spilled_result_and_refuses_to_escape() {
        // Through `execute_core_tool`, so this covers the arm the model
        // actually reaches — argument names included, which a direct call to
        // `spill::read` would not catch.
        let root = tempfile::tempdir().unwrap();
        let state = mock_state("127.0.0.1:9".parse().unwrap());
        let dir = crate::spill::dir_for(&state.sessions_root);
        let text: String = (0..5_000).map(|i| format!("row {i}\n")).collect();
        let spilled = crate::spill::write(&dir, "file_grep", &text).unwrap();

        let def = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "tool_output_read")
            .unwrap();

        let first = execute_core_tool(
            &def,
            &json!({ "outputId": spilled.id, "offset": 0, "limit": 2048 }),
            &state,
            root.path(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(first["totalBytes"], json!(text.len()));
        assert!(first["content"].as_str().unwrap().starts_with("row 0\n"));

        // Following nextOffset reaches the end the model was promised.
        let mut whole = String::new();
        let mut offset = 0u64;
        loop {
            let page = execute_core_tool(
                &def,
                &json!({ "outputId": spilled.id, "offset": offset }),
                &state,
                root.path(),
                None,
            )
            .await
            .unwrap();
            whole.push_str(page["content"].as_str().unwrap());
            match page["nextOffset"].as_u64() {
                Some(next) => offset = next,
                None => break,
            }
        }
        assert_eq!(whole, text);

        // The id is model-authored: it must never become a path.
        let escaped = execute_core_tool(
            &def,
            &json!({ "outputId": "../../config" }),
            &state,
            root.path(),
            None,
        )
        .await;
        assert!(
            escaped.is_err(),
            "an id must not resolve outside the spill dir"
        );
    }

    #[tokio::test]
    async fn an_edit_survives_a_formatting_difference_and_says_it_did() {
        let (root, folder) = game_with_workspace();
        // The file is indented with eight spaces and has a trailing space the
        // model will not reproduce — the ordinary near-miss that used to cost a
        // refusal, a re-read, and another turn.
        std::fs::write(
            folder.path().join("enemy.js"),
            "class Enemy {\n        step() {   \n            this.x += 1;\n        }\n}\n",
        )
        .unwrap();

        let result = apply_file_edit(
            root.path(),
            "demo",
            "enemy.js",
            "step() {\n    this.x += 1;\n}",
            "step() {\n    this.x += 2;\n}",
            false,
        )
        .await
        .unwrap();

        assert_eq!(result["written"], json!(true));
        // The result says the quote was not exact, so the model knows its
        // picture of the file is stale before it writes the next edit.
        assert_eq!(result["matchedBy"], json!("ignoring indentation"));
        assert!(result["note"].as_str().unwrap().contains("re-read"));

        let text = std::fs::read_to_string(folder.path().join("enemy.js")).unwrap();
        assert!(text.contains("this.x += 2;"), "{text}");
        assert!(!text.contains("this.x += 1;"), "{text}");
        // The surrounding class is untouched.
        assert!(text.starts_with("class Enemy {\n"), "{text}");
        assert!(text.ends_with("}\n"), "{text}");
    }

    #[tokio::test]
    async fn an_exact_edit_reports_no_fallback() {
        let (root, folder) = game_with_workspace();
        std::fs::write(folder.path().join("clean.js"), "const a = 1;\n").unwrap();
        let result = apply_file_edit(
            root.path(),
            "demo",
            "clean.js",
            "const a = 1;",
            "const a = 2;",
            false,
        )
        .await
        .unwrap();
        // No note, no matchedBy: nothing happened worth telling the model.
        assert!(result.get("matchedBy").is_none(), "{result}");
        assert!(result.get("note").is_none(), "{result}");
    }

    #[tokio::test]
    async fn a_whole_file_write_refuses_to_clobber_a_change_it_never_saw() {
        // The shape this exists for: the agent reads a file, does other work,
        // and writes it back — while the user, a `git pull`, or a second agent
        // changed it in between. `file_write` replaces everything, so that
        // change disappears with nobody noticing.
        let root = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        store::set_workspace_root(root.path(), "demo", folder.path().to_str()).unwrap();
        let state = mock_state("127.0.0.1:9".parse().unwrap());
        let target = folder.path().join("shared.js");
        std::fs::write(&target, "export const speed = 1;\n").unwrap();

        let read = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "file_read")
            .unwrap();
        let write = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "file_write")
            .unwrap();

        // The agent looks at the file.
        execute_core_tool(
            &read,
            &json!({ "slug": "demo", "path": "shared.js" }),
            &state,
            root.path(),
            None,
        )
        .await
        .unwrap();

        // Somebody else changes it.
        std::fs::write(&target, "export const speed = 99; // hand-tuned\n").unwrap();

        let refused = execute_core_tool(
            &write,
            &json!({ "slug": "demo", "path": "shared.js", "content": "export const speed = 2;\n" }),
            &state,
            root.path(),
            None,
        )
        .await
        .expect_err("overwriting an unseen change must be refused");
        let message = refused.to_string();
        assert!(
            message.contains("changed since you last read it"),
            "{message}"
        );
        assert!(
            message.contains("file_edit"),
            "the way forward is named: {message}"
        );
        // The other change is still there.
        assert!(std::fs::read_to_string(&target)
            .unwrap()
            .contains("hand-tuned"));

        // Reading again is all it takes to proceed.
        execute_core_tool(
            &read,
            &json!({ "slug": "demo", "path": "shared.js" }),
            &state,
            root.path(),
            None,
        )
        .await
        .unwrap();
        execute_core_tool(
            &write,
            &json!({ "slug": "demo", "path": "shared.js", "content": "export const speed = 2;\n" }),
            &state,
            root.path(),
            None,
        )
        .await
        .expect("a re-read clears the staleness");
        assert!(std::fs::read_to_string(&target)
            .unwrap()
            .contains("speed = 2"));
    }

    #[tokio::test]
    async fn writing_a_brand_new_file_is_never_refused() {
        // Nothing to protect: an unread file has no stale mental model, and
        // refusing here would block the ordinary case of creating one.
        let root = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        store::set_workspace_root(root.path(), "demo", folder.path().to_str()).unwrap();
        let state = mock_state("127.0.0.1:9".parse().unwrap());
        let write = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "file_write")
            .unwrap();
        execute_core_tool(
            &write,
            &json!({ "slug": "demo", "path": "brand-new.js", "content": "const a = 1;\n" }),
            &state,
            root.path(),
            None,
        )
        .await
        .expect("creating a file must not be refused");
    }

    #[test]
    fn a_bad_argument_tells_the_model_what_to_send() {
        // The reader is a model deciding what to do next, not a developer
        // reading a log. "missing required string slug" says something is
        // wrong without saying what to send, so the retry is a guess.
        let err = required_str(&json!({}), "slug").unwrap_err().to_string();
        assert!(err.contains("`slug`"), "{err}");
        assert!(err.contains("must be a string"), "{err}");
        assert!(err.contains("not provided"), "{err}");
        assert!(err.contains("Call the tool again"), "{err}");
    }

    #[test]
    fn the_three_ways_it_fails_are_distinguishable() {
        // Absent, null, and wrong-type look identical from inside the model
        // unless the error separates them.
        let absent = required_str(&json!({}), "path").unwrap_err().to_string();
        let null = required_str(&json!({ "path": null }), "path")
            .unwrap_err()
            .to_string();
        let wrong = required_str(&json!({ "path": 7 }), "path")
            .unwrap_err()
            .to_string();
        assert!(absent.contains("not provided"), "{absent}");
        assert!(null.contains("null"), "{null}");
        assert!(wrong.contains("a number"), "{wrong}");
        assert!(wrong.contains('7'), "the value itself helps: {wrong}");
        assert_ne!(absent, null);
        assert_ne!(null, wrong);
    }

    #[test]
    fn a_huge_wrong_argument_is_not_quoted_back_whole() {
        // Echoing a 2MB argument back would cost more than the mistake did.
        let big = json!({ "content": "x".repeat(50_000) });
        let err = required_str(&big, "missing").unwrap_err().to_string();
        assert!(err.len() < 400, "error was {} chars", err.len());

        let wrong_type = json!({ "path": vec!["y".repeat(50_000)] });
        let err = required_str(&wrong_type, "path").unwrap_err().to_string();
        assert!(err.len() < 400, "error was {} chars", err.len());
        assert!(err.contains('…'), "truncation must be visible: {err}");
    }

    #[test]
    fn a_valid_string_argument_still_just_works() {
        assert_eq!(
            required_str(&json!({ "slug": "demo" }), "slug").unwrap(),
            "demo"
        );
        // Empty is a valid string; rejecting it is a per-tool decision, not
        // this function's.
        assert_eq!(required_str(&json!({ "slug": "" }), "slug").unwrap(), "");
    }

    #[tokio::test]
    async fn an_edit_cannot_be_made_blind() {
        // Claude Code enforces read-before-edit in the harness. We get the same
        // guarantee structurally instead: `file_edit` requires exact text that
        // matches exactly once, and you cannot quote a file you have not read.
        // This test exists so that property is not weakened by accident — the
        // replacer ladder in particular must not start guessing at near misses
        // for text that was never in the file.
        let (root, folder) = game_with_workspace();
        std::fs::write(
            folder.path().join("world.js"),
            "const gravity = 9.8;\nconst drag = 0.1;\n",
        )
        .unwrap();

        // Invented text is refused, and the message says what to do.
        let error = apply_file_edit(
            root.path(),
            "demo",
            "world.js",
            "const gravity = 10;",
            "const gravity = 1;",
            false,
        )
        .await
        .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("not found"), "{message}");
        assert!(message.contains("read the file"), "{message}");

        // The file is untouched by a refused edit.
        assert_eq!(
            std::fs::read_to_string(folder.path().join("world.js")).unwrap(),
            "const gravity = 9.8;\nconst drag = 0.1;\n"
        );
    }

    #[tokio::test]
    async fn the_file_write_tool_arm_carries_diagnostics_too() {
        // Through `execute_core_tool`, so this proves the tool arm's wiring
        // rather than only the helper underneath it. Note the client's
        // `file_write` RPC is a separate path and deliberately unchanged: this
        // is the result the *model* reads.
        let root = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        store::set_workspace_root(root.path(), "demo", folder.path().to_str()).unwrap();
        let state = mock_state("127.0.0.1:9".parse().unwrap());
        let def = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "file_write")
            .unwrap();

        let broken = execute_core_tool(
            &def,
            &json!({ "slug": "demo", "path": "boot.js", "content": "function go( {\n" }),
            &state,
            root.path(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(broken["written"], json!(true));
        assert!(broken["diagnostics"].is_string(), "{broken}");

        // An ES module written to a plain `.js` must not be flagged: the
        // extension is not a defect in the file.
        let esm = execute_core_tool(
            &def,
            &json!({
                "slug": "demo",
                "path": "level.js",
                "content": "import { Mesh } from 'three';\nexport const make = () => new Mesh();\n"
            }),
            &state,
            root.path(),
            None,
        )
        .await
        .unwrap();
        assert!(esm.get("diagnostics").is_none(), "false positive: {esm}");
    }

    #[tokio::test]
    async fn an_edit_that_breaks_the_file_says_so_in_its_own_result() {
        let (root, folder) = game_with_workspace();
        std::fs::write(
            folder.path().join("player.js"),
            "export function jump() {\n  return 1;\n}\n",
        )
        .unwrap();

        // Healthy edits stay quiet — a diagnostic on correct code is worse
        // than none, because the model will "fix" it.
        let clean = apply_file_edit(
            root.path(),
            "demo",
            "player.js",
            "return 1;",
            "return 2;",
            false,
        )
        .await
        .unwrap();
        assert_eq!(clean["written"], json!(true));
        assert!(clean.get("diagnostics").is_none(), "{clean}");

        // Breaking it is reported in the same result, not left for the next
        // build-and-play round trip to discover.
        let broken = apply_file_edit(
            root.path(),
            "demo",
            "player.js",
            "export function jump() {",
            "export function jump( {",
            false,
        )
        .await
        .unwrap();
        // The write still happened; the result must not claim otherwise.
        assert_eq!(broken["written"], json!(true));
        assert!(
            broken["diagnostics"].is_string(),
            "a file that no longer parses must say so: {broken}"
        );
    }

    #[tokio::test]
    async fn file_edit_enforces_unique_match() {
        let (root, folder) = game_with_workspace();
        std::fs::write(
            folder.path().join("main.js"),
            "let x = 1;\nlet x = 1;\nconst done = true;\n",
        )
        .unwrap();

        // Ambiguous old_string is refused, telling the model how to fix it.
        let err = apply_file_edit(
            root.path(),
            "demo",
            "main.js",
            "let x = 1;",
            "let x = 2;",
            false,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("matches 2 times"), "{err}");

        // Text that is not in the file at all is refused.
        let err = apply_file_edit(
            root.path(),
            "demo",
            "main.js",
            "let y = 9;",
            "let y = 8;",
            false,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("not found"), "{err}");

        // Empty old_string and no-op edits are refused.
        assert!(
            apply_file_edit(root.path(), "demo", "main.js", "", "x", false)
                .await
                .is_err()
        );
        assert!(
            apply_file_edit(root.path(), "demo", "main.js", "let", "let", false)
                .await
                .is_err()
        );

        // A unique match replaces exactly once and leaves the rest alone.
        let result = apply_file_edit(
            root.path(),
            "demo",
            "main.js",
            "const done = true;",
            "const done = false;",
            false,
        )
        .await
        .unwrap();
        assert_eq!(result["replacements"], 1);
        let text = std::fs::read_to_string(folder.path().join("main.js")).unwrap();
        assert_eq!(text, "let x = 1;\nlet x = 1;\nconst done = false;\n");
    }

    #[tokio::test]
    async fn file_edit_replace_all_replaces_every_occurrence() {
        let (root, folder) = game_with_workspace();
        std::fs::write(folder.path().join("a.txt"), "old old old").unwrap();
        let result = apply_file_edit(root.path(), "demo", "a.txt", "old", "new", true)
            .await
            .unwrap();
        assert_eq!(result["replacements"], 3);
        assert_eq!(
            std::fs::read_to_string(folder.path().join("a.txt")).unwrap(),
            "new new new"
        );
    }

    /// Two `file_edit` calls the model emitted in the same turn, patching two
    /// spots in one file. `agent.rs` runs a turn's calls concurrently, so this
    /// used to be a lost update: both read the original text, both wrote a
    /// full copy, both answered `"written": true`, and the second write erased
    /// the first edit with nothing in the transcript to show for it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_file_edits_on_one_file_both_survive() {
        let (root, folder) = game_with_workspace();
        // Megabytes of filler so the read-modify-write is slow enough that an
        // unsynchronized pair really does interleave rather than happening to
        // finish in turn.
        let filler: String = (0..60_000)
            .map(|n| format!("// filler line {n}\n"))
            .collect();
        std::fs::write(
            folder.path().join("world.rs"),
            format!("const ALPHA: u32 = 1;\n{filler}const BETA: u32 = 2;\n"),
        )
        .unwrap();

        let edit = |old: &'static str, new: &'static str| {
            let root = root.path().to_path_buf();
            tokio::spawn(async move {
                run_tool(
                    &root,
                    "file_edit",
                    json!({
                        "slug": "demo",
                        "path": "world.rs",
                        "old_string": old,
                        "new_string": new
                    }),
                )
                .await
            })
        };
        let alpha = edit("const ALPHA: u32 = 1;", "const ALPHA: u32 = 111;");
        let beta = edit("const BETA: u32 = 2;", "const BETA: u32 = 222;");
        let (alpha, beta) = (alpha.await.unwrap(), beta.await.unwrap());
        assert_eq!(alpha.unwrap()["replacements"], 1);
        assert_eq!(beta.unwrap()["replacements"], 1);

        // Both reported success, so both must be on disk.
        let text = std::fs::read_to_string(folder.path().join("world.rs")).unwrap();
        assert!(
            text.contains("const ALPHA: u32 = 111;"),
            "alpha edit was lost"
        );
        assert!(
            text.contains("const BETA: u32 = 222;"),
            "beta edit was lost"
        );
        assert!(!text.contains("const ALPHA: u32 = 1;\n"));
        assert!(!text.contains("const BETA: u32 = 2;\n"));
    }

    #[tokio::test]
    async fn file_edit_refuses_traversal_and_secrets() {
        let (root, folder) = game_with_workspace();
        std::fs::write(folder.path().join(".env"), "SECRET=1").unwrap();
        assert!(
            apply_file_edit(root.path(), "demo", "../escape.txt", "a", "b", false)
                .await
                .is_err()
        );
        assert!(
            apply_file_edit(root.path(), "demo", "/etc/passwd", "a", "b", false)
                .await
                .is_err()
        );
        assert!(
            apply_file_edit(root.path(), "demo", ".env", "SECRET", "LEAKED", false)
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(folder.path().join(".env")).unwrap(),
            "SECRET=1"
        );
    }

    #[test]
    fn file_grep_caps_results_and_respects_skip_rules() {
        let (_root, folder) = game_with_workspace();
        std::fs::write(folder.path().join("a.txt"), "hit 1\nmiss\nhit 2\nhit 3\n").unwrap();
        std::fs::write(folder.path().join("b.txt"), "hit 4\nhit 5\n").unwrap();
        std::fs::create_dir_all(folder.path().join("node_modules")).unwrap();
        std::fs::write(folder.path().join("node_modules/skip.txt"), "hit hidden\n").unwrap();
        std::fs::write(folder.path().join(".hidden.txt"), "hit hidden\n").unwrap();
        std::fs::write(folder.path().join("blob.bin"), b"hit\x00binary\n").unwrap();
        std::fs::write(folder.path().join("server.pem"), "hit secret\n").unwrap();

        // Uncapped: exactly the five visible matches, none from skip dirs,
        // dotfiles, binaries, or secret-pattern files.
        let all = grep_game_files(folder.path(), "", "hit", GREP_MAX_MATCHES).unwrap();
        assert_eq!(all["matchCount"], 5);
        assert_eq!(all["truncated"], false);
        for row in all["matches"].as_array().unwrap() {
            let path = row["path"].as_str().unwrap();
            assert!(path == "a.txt" || path == "b.txt", "leaked {path}");
        }

        // max_results truncates and says so.
        let capped = grep_game_files(folder.path(), "", "hit", 3).unwrap();
        assert_eq!(capped["matchCount"], 3);
        assert_eq!(capped["truncated"], true);

        // Newest file's matches sort first.
        set_mtime(&folder.path().join("a.txt"), 1_000);
        set_mtime(&folder.path().join("b.txt"), 2_000);
        let sorted = grep_game_files(folder.path(), "", "hit", GREP_MAX_MATCHES).unwrap();
        assert_eq!(sorted["matches"][0]["path"], "b.txt");
        assert_eq!(sorted["matches"][0]["line"], 1);

        // Invalid regex is a clean error, not a panic.
        assert!(grep_game_files(folder.path(), "", "(", 10).is_err());
    }

    #[tokio::test]
    async fn file_grep_dispatch_refuses_traversal_scope() {
        let addr: std::net::SocketAddr = "127.0.0.1:9".parse().unwrap();
        let state = mock_state(addr);
        let root = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        std::fs::write(folder.path().join("code.rs"), "fn main() {}\n").unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        store::set_workspace_root(root.path(), "demo", Some(folder.path().to_str().unwrap()))
            .unwrap();
        let def = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "file_grep")
            .unwrap();

        // A path that escapes the workspace is refused before any search.
        let err = execute_core_tool(
            &def,
            &json!({ "slug": "demo", "pattern": "fn", "path": "../" }),
            &state,
            root.path(),
            None,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("escapes"), "{err}");

        // The happy path works through the dispatcher.
        let result = execute_core_tool(
            &def,
            &json!({ "slug": "demo", "pattern": "fn main" }),
            &state,
            root.path(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(result["matchCount"], 1);
        assert_eq!(result["matches"][0]["path"], "code.rs");
    }

    #[test]
    fn file_glob_sorts_by_mtime_and_caps_results() {
        let (_root, folder) = game_with_workspace();
        for (name, secs) in [("old.rs", 100u64), ("mid.rs", 200), ("new.rs", 300)] {
            let path = folder.path().join(name);
            std::fs::write(&path, "x").unwrap();
            set_mtime(&path, secs);
        }
        std::fs::create_dir_all(folder.path().join("src")).unwrap();
        std::fs::write(folder.path().join("src/deep.rs"), "x").unwrap();

        // A bare `*` does not cross directories; newest file first.
        let flat = glob_game_files(folder.path(), "*.rs").unwrap();
        assert_eq!(flat["count"], 3);
        assert_eq!(flat["truncated"], false);
        let files: Vec<&str> = flat["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(files, vec!["new.rs", "mid.rs", "old.rs"]);

        // `**` recurses.
        let deep = glob_game_files(folder.path(), "**/*.rs").unwrap();
        assert_eq!(deep["count"], 4);

        // The 500-result cap truncates and says so.
        for i in 0..510 {
            std::fs::write(folder.path().join(format!("cap-{i:03}.txt")), "x").unwrap();
        }
        let capped = glob_game_files(folder.path(), "cap-*.txt").unwrap();
        assert_eq!(capped["count"], 500);
        assert_eq!(capped["truncated"], true);

        // Invalid glob is a clean error.
        assert!(glob_game_files(folder.path(), "a{").is_err());
    }

    #[test]
    fn core_tool_names_are_reserved_and_unique() {
        // A browser tool registered under a core name emitted two functions
        // with the same name in the provider's tools array, which 400s every
        // agent_chat in every session until the core process restarts.
        let names: Vec<String> = core_tool_defs().into_iter().map(|t| t.name).collect();
        let unique: std::collections::HashSet<&String> = names.iter().collect();
        assert_eq!(
            names.len(),
            unique.len(),
            "core tool names must be unique: {names:?}"
        );
        for reserved in [
            "file_write",
            "file_edit",
            "file_grep",
            "file_glob",
            "model_switch",
            "subagent_spawn",
            "project_revert",
            "video_contact_sheet",
            // The only way to reach a spilled result: without it in the model's
            // tool list, an oversized result's `outputId` is a handle to
            // nothing.
            "tool_output_read",
        ] {
            assert!(
                names.iter().any(|n| n == reserved),
                "{reserved} must be a core tool"
            );
        }
    }

    #[test]
    fn graph_plan_schema_matches_the_validated_node_contract() {
        let graph = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "graph_plan")
            .expect("graph_plan tool");
        let nodes = &graph.parameters["properties"]["nodes"];
        let node = &nodes["items"];
        assert_eq!(nodes["minItems"], 1);
        assert_eq!(nodes["maxItems"], 24);
        assert_eq!(
            node["properties"]["kind"]["enum"],
            json!(["build", "judge"])
        );
        assert_eq!(node["properties"]["role"]["pattern"], "^[a-z0-9-]{1,48}$");
        assert_eq!(node["properties"]["acceptance"]["items"]["type"], "string");
        assert_eq!(node["properties"]["deps"]["items"]["type"], "string");
        assert_eq!(node["additionalProperties"], false);
    }

    #[test]
    fn orchestration_tool_schemas_expose_runtime_safety_contracts() {
        let defs = core_tool_defs();
        let spawn = defs
            .iter()
            .find(|tool| tool.name == "subagent_spawn")
            .expect("subagent_spawn tool");
        let spawn_contract = format!(
            "{} {}",
            spawn.description, spawn.parameters["properties"]["instructions"]
        );
        for required in [
            "state.find/state.scene as frozen snapshots",
            "state.patch for cross-entity transforms",
            "full finite {x,y,z} vectors",
            "runtime material mutation",
            "await non-tautological assertions",
            "positive expectation messages",
        ] {
            assert!(
                spawn_contract.contains(required),
                "subagent_spawn omitted {required:?}: {spawn_contract}"
            );
        }

        let graph = defs
            .iter()
            .find(|tool| tool.name == "graph_plan")
            .expect("graph_plan tool");
        let properties = &graph.parameters["properties"]["nodes"]["items"]["properties"];
        let instructions = properties["instructions"]["description"]
            .as_str()
            .expect("instructions description");
        let acceptance = properties["acceptance"]["description"]
            .as_str()
            .expect("acceptance description");
        assert!(instructions.contains("state.find/state.scene are frozen snapshots"));
        assert!(instructions.contains("state.patch for cross-entity transforms"));
        assert!(instructions.contains("full finite {x,y,z} vectors"));
        assert!(instructions.contains("runtime material mutation"));
        assert!(acceptance.contains("awaited, non-tautological assertions"));
        assert!(acceptance.contains("positive expectation messages"));
    }

    /// Dispatch a core tool the way the agent loop does. No provider is
    /// contacted by the file tools, so a dead address is fine.
    async fn run_tool(root: &Path, name: &str, args: Value) -> Result<Value> {
        let state = mock_state("127.0.0.1:9".parse().unwrap());
        let def = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == name)
            .unwrap_or_else(|| panic!("{name} is not a core tool"));
        execute_core_tool(&def, &args, &state, root, None).await
    }

    /// End-to-end dispatch: a tool call with snake_case iteration fields
    /// (the shape the strict live coordinator sent) must persist the
    /// iteration through the same `execute_core_tool` path the agent loop
    /// uses. The test pins both the schema/runtime mismatch (the dispatch
    /// renames the keys) and the persisted iteration count.
    #[tokio::test]
    async fn loop_report_iteration_dispatch_accepts_snake_case_payload() {
        let root = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        // Start the loop so `loop_report_iteration` has a target to append.
        run_tool(
            root.path(),
            "loop_report_start",
            json!({
                "slug": "demo",
                "loopId": "loop-coord",
                "objective": "Dispatch path regression",
                "startedAtMs": 1_000
            }),
        )
        .await
        .unwrap();

        let result = run_tool(
            root.path(),
            "loop_report_iteration",
            json!({
                "slug": "demo",
                "loopId": "loop-coord",
                "iteration": {
                    "started_at_ms": 2_000,
                    "completed_at_ms": 3_000,
                    "outcome": "needs-work",
                    "summary": "Coordinator-style payload",
                    "agents": [],
                    "checks": [],
                    "changed_files": [],
                    "evidence": [],
                    "scores": [],
                    "punch_list": [],
                    "next_iteration_memory": {
                        "observations": [],
                        "decisions": [],
                        "risks": ["iteration 2 needs another pass"],
                        "next_actions": ["add evidence"]
                    }
                }
            }),
        )
        .await
        .unwrap();
        assert_eq!(result["report"]["totals"]["iterations"], 1);
        assert_eq!(
            result["report"]["iterations"][0]["summary"],
            "Coordinator-style payload"
        );

        // An empty `iteration` object surfaces a field-named error so the
        // model can self-correct instead of seeing an opaque failure.
        let error = run_tool(
            root.path(),
            "loop_report_iteration",
            json!({
                "slug": "demo",
                "loopId": "loop-coord",
                "iteration": {}
            }),
        )
        .await
        .unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains("invalid loop iteration"),
            "expected the dispatch error to prefix `invalid loop iteration`, got: {message}",
        );
        assert!(
            message.contains("startedAtMs")
                || message.contains("completedAtMs")
                || message.contains("outcome")
                || message.contains("summary"),
            "expected a field-named error inside the dispatch failure, got: {message}",
        );
    }

    /// A tool call that asks to terminalise a report with no iterations,
    /// no agent data, and no passing checks must fail closed. The AgentPanel
    /// path that succeeds after `validateLoopGraphCompletion` is the only
    /// expected completion caller; a model short-circuit is not.
    #[tokio::test]
    async fn loop_report_update_completed_rejects_a_generic_fallback() {
        let root = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        run_tool(
            root.path(),
            "loop_report_start",
            json!({
                "slug": "demo",
                "loopId": "loop-generic",
                "objective": "Generically completed loop",
                "reference": "Geometry Wars 3",
                "startedAtMs": 1_000
            }),
        )
        .await
        .unwrap();

        let error = run_tool(
            root.path(),
            "loop_report_update",
            json!({
                "slug": "demo",
                "loopId": "loop-generic",
                "update": {
                    "status": "completed",
                    "completedAtMs": 9_000,
                    "recordedAtMs": 9_000,
                    "summary": "Model claimed DONE without evidence."
                }
            }),
        )
        .await
        .unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains("requires at least 2 iterations"),
            "expected the readiness gate to fire on iteration count, got: {message}",
        );
    }
    #[tokio::test]
    async fn image3d_mesh_uses_the_exact_raw_source_hash() {
        use base64::Engine;
        use image::{Rgb, RgbImage};

        let root = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        let mut image = RgbImage::from_pixel(128, 128, Rgb([12, 12, 12]));
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            if (24..104).contains(&x) && (24..104).contains(&y) {
                *pixel = Rgb([235, 235, 235]);
            }
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let bytes = cursor.into_inner();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);

        let result = run_tool(
            root.path(),
            "image3d_mesh",
            json!({
                "slug": "demo",
                "name": "Crate",
                "image": encoded
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            result["asset"]["sourceHash"],
            crate::assets::sha256_bytes(&bytes)
        );

        let review = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "image3d_review")
            .expect("image3d_review is an agent core tool");
        assert_eq!(
            review.parameters,
            json!({
                "type": "object",
                "properties": {
                    "slug": {"type": "string"},
                    "assetId": {"type": "string", "description": "generated image-to-3D asset to review"},
                    "image": {"type": "string", "description": "base64 or data URI screenshot of the reconstruction"},
                    "passId": {"type": "string", "description": "build pass being reviewed, e.g. blockout"}
                },
                "required": ["slug", "assetId", "image", "passId"]
            })
        );
    }

    #[tokio::test]
    async fn image3d_mesh_inline_source_survives_review_with_decoys() {
        use base64::Engine;
        use image::{Rgb, RgbImage};

        let root = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        let mut image = RgbImage::from_pixel(128, 128, Rgb([12, 12, 12]));
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            if (24..104).contains(&x) && (24..104).contains(&y) {
                *pixel = Rgb([235, 235, 235]);
            }
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let bytes = cursor.into_inner();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);

        let generated = run_tool(
            root.path(),
            "image3d_mesh",
            json!({
                "slug": "demo",
                "name": "Crate",
                "image": encoded
            }),
        )
        .await
        .unwrap();
        let asset_id = generated["assetId"].as_str().unwrap();
        let project_dir = store::project_dir(root.path(), "demo").unwrap();
        let source_dir = project_dir.join("assets").join("sources");
        // These decoys exercise both the direct id-shaped candidate and the
        // directory scan; only the content-hash source may satisfy review.
        std::fs::write(source_dir.join(format!("{asset_id}.png")), b"wrong-source").unwrap();
        std::fs::write(source_dir.join("000-decoy.png"), b"another-wrong-source").unwrap();

        let reviewed = run_tool(
            root.path(),
            "image3d_review",
            json!({
                "slug": "demo",
                "assetId": asset_id,
                "image": encoded,
                "passId": "blockout"
            }),
        )
        .await
        .unwrap();
        assert_eq!(reviewed["review"]["metrics"]["structureGate"], true);
        // A configured vision provider may conservatively request another
        // blockout pass even when the deterministic gate succeeds. This
        // regression is about exact source durability and decoy rejection,
        // so do not make it depend on ambient provider configuration.
        assert!(matches!(
            reviewed["next"].as_str(),
            Some("blockout" | "structural-pass")
        ));
        let expected_hash = crate::assets::sha256_bytes(&bytes);
        assert_eq!(
            crate::assets::sha256_file(&source_dir.join(format!("{expected_hash}.png"))).unwrap(),
            expected_hash
        );
    }

    #[tokio::test]
    async fn video_contact_sheet_tool_persists_project_evidence() {
        use base64::Engine;
        use image::{Rgb, RgbImage};

        let root = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        let frame = |red: u8| {
            let image = RgbImage::from_pixel(16, 16, Rgb([red, 20, 30]));
            let mut cursor = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgb8(image)
                .write_to(&mut cursor, image::ImageFormat::Png)
                .unwrap();
            base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
        };

        let result = run_tool(
            root.path(),
            "video_contact_sheet",
            json!({
                "slug": "demo",
                "label": "walk-iteration-1",
                "frames": [
                    {"image": frame(10), "timestampSeconds": 0.0, "frameNumber": 1},
                    {"image": frame(200), "timestampSeconds": 0.25, "frameNumber": 2}
                ]
            }),
        )
        .await
        .unwrap();

        assert_eq!(result["frames"], 2);
        let project = store::project_dir(root.path(), "demo").unwrap();
        assert!(project.join(result["pngPath"].as_str().unwrap()).exists());
        assert!(project
            .join(result["manifestPath"].as_str().unwrap())
            .exists());
    }

    #[tokio::test]
    async fn capture_persist_tool_roundtrips_a_real_png_through_rpc_dispatch() {
        use base64::Engine;
        use image::{Rgb, RgbImage};

        let root = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        let image = RgbImage::from_pixel(16, 16, Rgb([10, 200, 30]));
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
        );

        let result = run_tool(
            root.path(),
            "capture_persist",
            json!({
                "slug": "demo",
                "path": "reports/walk/frame-001.png",
                "dataUrl": data_url,
            }),
        )
        .await
        .unwrap();

        let project = store::project_dir(root.path(), "demo").unwrap();
        let written = project.join(result["path"].as_str().unwrap());
        assert!(written.is_file(), "frame was not written to disk");
        assert_eq!(result["mime"], "image/png");
        assert_eq!(
            crate::assets::sha256_bytes(&std::fs::read(&written).unwrap()),
            result["sha256"].as_str().unwrap(),
        );
    }

    #[tokio::test]
    async fn capture_persist_tool_rejects_non_image_data_url_via_rpc_dispatch() {
        // instead of silently writing garbage. A worker would otherwise see
        // "wrote 0 bytes" and assume the path is fine.
        let root = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        let err = run_tool(
            root.path(),
            "capture_persist",
            json!({
                "slug": "demo",
                "path": "frame.png",
                "dataUrl": "data:image/png;base64,!!!not-base64!!!",
            }),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("base64"));
    }

    #[tokio::test]
    async fn capture_persist_tool_rejects_traversal_via_rpc_dispatch() {
        use base64::Engine;
        use image::{Rgb, RgbImage};

        let root = tempfile::tempdir().unwrap();
        store::create_project(root.path(), "demo", "Demo").unwrap();
        let image = RgbImage::from_pixel(4, 4, Rgb([1, 2, 3]));
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
        );
        let err = run_tool(
            root.path(),
            "capture_persist",
            json!({
                "slug": "demo",
                "path": "../escape.png",
                "dataUrl": url,
            }),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("escapes"));
    }

    #[tokio::test]
    async fn file_read_windows_a_large_file_and_hands_back_a_resume_offset() {
        // A lockfile used to arrive whole and then be re-sent to the model on
        // every following turn until compaction.
        let (root, folder) = game_with_workspace();
        let body: String = (1..=5_000).map(|n| format!("dep-{n}: 1.0.0\n")).collect();
        std::fs::write(folder.path().join("lock.yaml"), &body).unwrap();

        let first = run_tool(
            root.path(),
            "file_read",
            json!({ "slug": "demo", "path": "lock.yaml" }),
        )
        .await
        .unwrap();
        assert_eq!(first["startLine"], 1);
        assert_eq!(first["endLine"], 2_000);
        assert_eq!(first["truncated"], true);
        let notice = first["notice"].as_str().unwrap();
        assert!(notice.contains("offset=2001"), "notice was: {notice}");

        // Following the offset the tool computed lands exactly where it left
        // off — the model never does the pagination arithmetic itself.
        let second = run_tool(
            root.path(),
            "file_read",
            json!({ "slug": "demo", "path": "lock.yaml", "offset": 2_001 }),
        )
        .await
        .unwrap();
        assert!(second["content"]
            .as_str()
            .unwrap()
            .starts_with("dep-2001: 1.0.0\n"));
    }

    #[tokio::test]
    async fn file_read_repairs_a_filename_the_model_cannot_see_is_wrong() {
        // Finder rewrites ' as ’. The two render identically, so the model
        // retypes the path faithfully and would loop on "not found" forever.
        let (root, folder) = game_with_workspace();
        std::fs::write(folder.path().join("Ziwen\u{2019}s notes.md"), "hello\n").unwrap();

        let result = run_tool(
            root.path(),
            "file_read",
            json!({ "slug": "demo", "path": "Ziwen's notes.md" }),
        )
        .await
        .unwrap();
        assert_eq!(result["content"], "hello");
        // The repair is announced: a silent one would leave the model typing
        // the spelling that does not exist.
        assert!(result["notice"]
            .as_str()
            .unwrap()
            .contains("render identically"));
    }

    #[tokio::test]
    async fn file_read_names_the_near_miss_instead_of_just_failing() {
        let (root, folder) = game_with_workspace();
        std::fs::write(folder.path().join("AGENTS.md"), "x").unwrap();

        let err = run_tool(
            root.path(),
            "file_read",
            json!({ "slug": "demo", "path": "AGENT.md" }),
        )
        .await
        .unwrap_err();
        // Substring matching finds nothing here; the bounded edit distance is
        // what turns a dead end into a one-turn recovery.
        assert!(err.to_string().contains("AGENTS.md"), "{err}");
    }

    #[tokio::test]
    async fn did_you_mean_never_names_a_file_the_resolver_would_refuse() {
        // "rsa" matches no secret pattern, so it used to reach the suggestion
        // pass and answer with "id_rsa" — confirming the exact name and the
        // existence of a file file_read is hard-refused from opening.
        let (root, folder) = game_with_workspace();
        for secret in ["id_rsa", "server.pem", "release.keystore"] {
            std::fs::write(folder.path().join(secret), "SECRET").unwrap();
        }
        std::fs::write(folder.path().join("server.ts"), "ok").unwrap();

        // Each probe is a near miss for exactly one refused file. The error
        // echoes the requested path back, so the leak to check for is the
        // file's real name appearing where the caller did not already have it.
        for (probe, refused) in [
            ("rsa", "id_rsa"),
            ("id_rs", "id_rsa"),
            ("keystore", "release.keystore"),
        ] {
            let err = run_tool(
                root.path(),
                "file_read",
                json!({ "slug": "demo", "path": probe }),
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(
                !err.contains(refused),
                "{probe:?} leaked {refused:?}: {err}"
            );
            assert!(
                !err.contains("Did you mean"),
                "{probe:?} had only refused neighbours, so it must not suggest at all: {err}"
            );
        }

        // Readable neighbours are still suggested — the filter must suppress
        // the refused name without turning the feature off. "server.pe" is
        // within edit distance of both server.pem (refused) and server.ts
        // (readable), so exactly one of them may appear.
        let err = run_tool(
            root.path(),
            "file_read",
            json!({ "slug": "demo", "path": "server.pe" }),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("server.ts"), "{err}");
        assert!(!err.contains("server.pem"), "{err}");
    }

    #[tokio::test]
    async fn file_read_repairs_argument_names_and_numeric_strings() {
        let (root, folder) = game_with_workspace();
        std::fs::write(folder.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();

        let result = run_tool(
            root.path(),
            "file_read",
            json!({ "slug": "demo", "filePath": "a.txt", "offset": "2", "limit": "1" }),
        )
        .await
        .unwrap();
        assert_eq!(result["content"], "two");

        // But a value that only looks numeric is refused, never read as 2 —
        // a silently wrong window is worse than an error.
        assert!(run_tool(
            root.path(),
            "file_read",
            json!({ "slug": "demo", "path": "a.txt", "offset": "2abc" }),
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn file_read_reports_non_text_instead_of_spilling_it() {
        let (root, folder) = game_with_workspace();
        std::fs::write(folder.path().join("blob.dat"), [0u8, 1, 2, 3, 0]).unwrap();

        let result = run_tool(
            root.path(),
            "file_read",
            json!({ "slug": "demo", "path": "blob.dat" }),
        )
        .await
        .unwrap();
        assert_eq!(result["encoding"], "binary");
        assert!(result["content"].is_null());
    }

    #[test]
    fn a_subagents_tool_log_reaches_the_parent_as_counts_not_payloads() {
        // A child that wrote a 2MB file used to put that whole body into the
        // parent's context via `arguments`, where it was re-sent every turn.
        let log = json!([
            { "name": "file_read", "arguments": { "path": "a.rs" }, "id": "1" },
            { "name": "file_write", "arguments": { "content": "x".repeat(2_000_000) }, "id": "2" },
            { "name": "file_read", "arguments": { "path": "b.rs" }, "id": "3" },
        ]);
        let summary = summarize_tool_calls(&log);
        assert_eq!(summary["total"], 3);
        assert_eq!(summary["byTool"]["file_read"], 2);
        assert_eq!(summary["byTool"]["file_write"], 1);
        assert!(
            summary.to_string().len() < 200,
            "summary was {} bytes",
            summary.to_string().len()
        );
        assert_eq!(summarize_tool_calls(&json!(null))["total"], 0);
    }

    #[tokio::test]
    async fn file_list_caps_a_huge_directory_and_says_how_to_narrow_it() {
        let (root, folder) = game_with_workspace();
        let sprites = folder.path().join("sprites");
        std::fs::create_dir(&sprites).unwrap();
        for n in 0..1_200 {
            std::fs::write(sprites.join(format!("sprite-{n:05}.png")), "x").unwrap();
        }

        let result = run_tool(
            root.path(),
            "file_list",
            json!({ "slug": "demo", "path": "sprites" }),
        )
        .await
        .unwrap();
        assert_eq!(result["count"], 1_200);
        assert_eq!(result["truncated"], true);
        assert_eq!(
            result["entries"].as_array().unwrap().len(),
            LIST_MAX_ENTRIES
        );
        assert!(result["notice"].as_str().unwrap().contains("file_glob"));

        // Sorting before the cut is what makes it deterministic and useful.
        assert_eq!(result["entries"][0]["name"], "sprite-00000.png");

        // A folder inside the cap is unchanged, notice included.
        let small = run_tool(root.path(), "file_list", json!({ "slug": "demo" }))
            .await
            .unwrap();
        assert!(small["truncated"].is_null());
        assert!(small["notice"].is_null());
    }

    #[test]
    fn writes_into_the_repository_history_are_refused() {
        // The working tree is the agent's to rewrite; `.git` is what makes a
        // bad run undoable, so it is the one thing inside the workspace that
        // stays read-only.
        let base = Path::new("/tmp/game");
        assert!(reject_protected_write(base, Path::new("/tmp/game/src/main.ts")).is_ok());
        assert!(reject_protected_write(base, Path::new("/tmp/game/.gitignore")).is_ok());

        for blocked in [
            "/tmp/game/.git/config",
            "/tmp/game/.git/objects/ab/cdef",
            "/tmp/game/nested/.git/HEAD",
            "/tmp/game/.wt/branch/file.ts",
        ] {
            let error = reject_protected_write(base, Path::new(blocked))
                .expect_err(&format!("{blocked} should be refused"));
            assert!(
                error.to_string().contains("refusing to write inside"),
                "unhelpful error for {blocked}: {error}"
            );
        }
    }

    #[tokio::test]
    async fn file_write_refuses_an_unbounded_write() {
        // file_edit and the workspace path both already refused this; the
        // agent's file_write was the one way around it.
        let (root, folder) = game_with_workspace();
        let huge = "x".repeat(EDIT_MAX_WRITE_BYTES + 1);
        let err = run_tool(
            root.path(),
            "file_write",
            json!({ "slug": "demo", "path": "big.txt", "content": huge }),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("refusing to write"), "{err}");
        assert!(!folder.path().join("big.txt").exists());
    }

    #[tokio::test]
    async fn agent_file_write_activity_is_atomic_bounded_and_not_public() {
        let (root, folder) = game_with_workspace();
        std::fs::write(folder.path().join("main.js"), "before\n").unwrap();
        let def = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "file_write")
            .unwrap();
        let args = json!({
            "slug": "demo",
            "path": "main.js",
            "content": "after\n"
        });

        // Public direct calls preserve the normal tool contract.
        let public = execute_core_tool(
            &def,
            &args,
            &mock_state("127.0.0.1:9".parse().unwrap()),
            root.path(),
            None,
        )
        .await
        .unwrap();
        assert!(public.get(INTERNAL_ACTIVITY_KEY).is_none());

        // Agent calls opt into the out-of-band activity payload while holding
        // the same path lock as the write itself.
        // Fixture, not a scenario: this direct write stands in for the file's
        // current state as core already knows it. Without saying so, the
        // staleness guard on `file_write` correctly refuses — it cannot tell a
        // test's setup from a user editing the file behind the agent's back,
        // and refusing the latter is the whole point.
        let staged = folder.path().join("main.js");
        std::fs::write(&staged, "before\n").unwrap();
        crate::staleness::remember(&staged);
        let internal = execute_core_tool_with_activity(
            &def,
            &args,
            &mock_state("127.0.0.1:9".parse().unwrap()),
            root.path(),
            None,
            true,
        )
        .await
        .unwrap();
        let mut sanitized = internal.clone();
        let activity = take_internal_activity(&mut sanitized).expect("activity metadata");
        assert!(sanitized.get(INTERNAL_ACTIVITY_KEY).is_none());
        assert_eq!(activity["operation"], "write");
        assert_eq!(activity["path"], "main.js");
        assert_eq!(activity["before"], "before\n");
        assert_eq!(activity["after"], "after\n");
        assert_eq!(activity["beforeBytes"], 7);
        assert_eq!(activity["afterBytes"], 6);
        assert_eq!(activity["truncated"], false);
    }

    #[tokio::test]
    async fn agent_file_read_activity_names_the_openable_path() {
        let (root, folder) = game_with_workspace();
        std::fs::write(folder.path().join("main.js"), "const ready = true;\n").unwrap();
        let def = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "file_read")
            .unwrap();
        let result = execute_core_tool_with_activity(
            &def,
            &json!({ "slug": "demo", "path": "main.js" }),
            &mock_state("127.0.0.1:9".parse().unwrap()),
            root.path(),
            None,
            true,
        )
        .await
        .unwrap();
        let mut sanitized = result;
        let activity = take_internal_activity(&mut sanitized).expect("read activity metadata");
        assert_eq!(activity, json!({ "operation": "read", "path": "main.js" }));
        assert_eq!(sanitized["content"], "const ready = true;");
    }

    #[tokio::test]
    async fn agent_file_edit_activity_keeps_bounded_replacement_snippets() {
        let (root, folder) = game_with_workspace();
        let prefix = "x".repeat(ACTIVITY_TEXT_MAX_BYTES + 128);
        let old = "const score = 1;";
        let new = "const score = 2;";
        std::fs::write(folder.path().join("game.js"), format!("{prefix}\n{old}\n")).unwrap();
        let def = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "file_edit")
            .unwrap();
        let result = execute_core_tool_with_activity(
            &def,
            &json!({
                "slug": "demo",
                "path": "game.js",
                "old_string": old,
                "new_string": new
            }),
            &mock_state("127.0.0.1:9".parse().unwrap()),
            root.path(),
            None,
            true,
        )
        .await
        .unwrap();
        let mut sanitized = result.clone();
        let activity = take_internal_activity(&mut sanitized).expect("activity metadata");
        assert_eq!(activity["operation"], "edit");
        assert_eq!(activity["replacements"], 1);
        assert_eq!(activity["beforeSnippet"], old);
        assert_eq!(activity["afterSnippet"], new);
        assert_eq!(
            activity["before"].as_str().unwrap().len(),
            ACTIVITY_TEXT_MAX_BYTES
        );
        assert_eq!(
            activity["after"].as_str().unwrap().len(),
            ACTIVITY_TEXT_MAX_BYTES
        );
        assert_eq!(
            activity["beforeBytes"],
            (prefix.len() + 1 + old.len() + 1) as u64
        );
        assert_eq!(
            activity["afterBytes"],
            (prefix.len() + 1 + new.len() + 1) as u64
        );
        assert_eq!(activity["truncated"], true);
    }

    // -----------------------------------------------------------------------
    // Approval ownership: the core pins.
    //
    // These are the assertions no client test can make. The panel is a
    // projection of `ownerSession` / `ownerGraph` / `targetClientId`; if core
    // stops stamping them, every window silently shows nothing and every node
    // parks — and the client suite stays green throughout.
    // -----------------------------------------------------------------------

    /// A provider that delegates before it reaches the gated tool: the agent
    /// spawns a subagent, and the SUBAGENT is what asks. That grandchild's
    /// session belongs to no `graph.updated` snapshot, which is the whole
    /// point of the case.
    async fn delegating_call_provider(
        axum::Json(body): axum::Json<Value>,
    ) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
        let messages: Vec<&Value> = body["messages"].as_array().into_iter().flatten().collect();
        if messages.iter().any(|message| message["role"] == "tool") {
            return Sse::new(futures::stream::iter(vec![
                Ok(Event::default().data(r#"{"choices":[{"delta":{"content":"done"}}]}"#)),
                Ok(Event::default().data("[DONE]")),
            ]));
        }
        let delegating = messages.iter().any(|message| {
            message["content"]
                .as_str()
                .is_some_and(|content| content.contains("delegate to a worker"))
        });
        let call = if delegating {
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-spawn","function":{"name":"subagent_spawn","arguments":"{\"role\":\"worker\",\"instructions\":\"use the editor\",\"maxTurns\":2}"}}]}}]}"#
        } else {
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-echo","function":{"name":"editor_echo","arguments":"{}"}}]}}]}"#
        };
        Sse::new(futures::stream::iter(vec![
            Ok(Event::default().data(call)),
            Ok(Event::default().data(r#"{"choices":[{"finish_reason":"tool_calls","delta":{}}]}"#)),
            Ok(Event::default().data("[DONE]")),
        ]))
    }

    /// A state that asks before `editor_echo`, wired to a provider that calls
    /// it once. Direct spawns run at full access, so a config `ask` rule is
    /// what makes them prompt at all — the same path a user's own config takes.
    /// Every prompt is recorded, then answered from the event's own
    /// `targetClientId`, which is the only caller core accepts.
    async fn approval_probe_state(recorded: Arc<std::sync::Mutex<Vec<Value>>>) -> crate::AppState {
        approval_probe_state_on(
            recorded,
            Router::new().route("/v1/chat/completions", post(browser_call_provider)),
        )
        .await
    }

    async fn delegating_approval_probe_state(
        recorded: Arc<std::sync::Mutex<Vec<Value>>>,
    ) -> crate::AppState {
        let state = approval_probe_state_on(
            recorded,
            Router::new().route("/v1/chat/completions", post(delegating_call_provider)),
        )
        .await;
        let spawn = core_tool_defs()
            .into_iter()
            .find(|tool| tool.name == "subagent_spawn")
            .expect("subagent_spawn is a core tool");
        state
            .tools
            .write()
            .await
            .insert("subagent_spawn".into(), spawn);
        state
    }

    /// The window every probe session is attached to.
    const PROBE_CLIENT: &str = "window-probe";

    async fn attach_probe_window(state: &crate::AppState, session_id: &str) {
        state.agents.ensure_session(session_id).await.unwrap();
        state.editor_attachment.write().await.insert(
            session_id.to_string(),
            crate::editor_bridge::EditorAttachment {
                client_id: PROBE_CLIENT.into(),
                session_id: session_id.to_string(),
                project_slug: "demo".into(),
                workspace_root: "/tmp/demo".into(),
            },
        );
    }

    async fn approval_probe_state_on(
        recorded: Arc<std::sync::Mutex<Vec<Value>>>,
        app: Router,
    ) -> crate::AppState {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let state = mock_state(addr);
        state.config.write().await.permissions = vec![crate::config::PermissionRule {
            pattern: "editor_echo".into(),
            action: crate::config::PermissionAction::Ask,
        }];
        state.tools.write().await.insert(
            "editor_echo".into(),
            ToolDef {
                name: "editor_echo".into(),
                description: "Echo".into(),
                parameters: json!({"type":"object"}),
                kind: ToolKind::Browser,
                access: Access::Guarded,
            },
        );
        let mut rx = state.bus.subscribe();
        let agents = state.agents.clone();
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                let sid = event["sessionId"].as_str().unwrap_or_default().to_string();
                let rid = event["requestId"].as_str().unwrap_or_default().to_string();
                match event["type"].as_str() {
                    Some("agent.approval_request") => {
                        recorded.lock().unwrap().push(event.clone());
                        match event["targetClientId"].as_str() {
                            // The addressed window answers. Any other caller —
                            // including this probe with no client id — is
                            // refused by `respond`, which is the point.
                            Some(client) => {
                                let _ = agents.approvals().respond(&rid, Some(client), true).await;
                            }
                            // Unaddressed: answerable by nobody, so it would
                            // park for core's full 300s timer. The probe plays
                            // that timer's part instead of costing every run
                            // five minutes. The assertion under test is on the
                            // recorded event, not on how it ends.
                            None => {
                                let _ = agents.approvals().cancel_by_session(&sid).await;
                            }
                        }
                    }
                    Some("agent.tool_request") => {
                        let _ = agents
                            .submit_tool_result(&sid, &rid, json!({ "ok": true }))
                            .await;
                    }
                    _ => {}
                }
            }
        });
        state
    }

    fn gated_approval(recorded: &Arc<std::sync::Mutex<Vec<Value>>>) -> Value {
        let events = recorded.lock().unwrap().clone();
        let approval = events
            .iter()
            .find(|event| event["tool"] == "editor_echo")
            .cloned()
            .expect("the gated tool raised no approval request");
        // Always on the wire, even when there is no owner to name: a client
        // that has to ask "was the field there?" is back to guessing.
        for field in ["ownerSession", "ownerGraph", "targetClientId"] {
            assert!(
                approval.get(field).is_some(),
                "{field} missing from {approval}"
            );
        }
        approval
    }

    #[tokio::test]
    async fn client_spawn_approvals_carry_the_calling_panels_session() {
        // A panel spawns a subagent directly, so the child asks under a
        // session id that panel never opened. The request says whose work it
        // is, and core addresses it at that panel's window.
        let recorded: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
        let state = approval_probe_state(recorded.clone()).await;
        attach_probe_window(&state, "session-panel").await;
        let result = spawn_subagent_for_client(
            &state,
            &json!({ "role": "tester", "instructions": "use the editor", "maxTurns": 3 }),
            Some("session-panel"),
        )
        .await
        .unwrap();
        let child = result["sessionId"].as_str().unwrap().to_string();

        let approval = gated_approval(&recorded);
        assert_eq!(approval["sessionId"], json!(child));
        assert_eq!(approval["ownerSession"], json!("session-panel"));
        assert_eq!(approval["targetClientId"], json!(PROBE_CLIENT));
        // Not a graph's work, so no run is named.
        assert_eq!(approval["ownerGraph"], Value::Null);
    }

    #[tokio::test]
    async fn unattended_spawn_names_no_owner_and_no_window() {
        // Nothing identifies a watcher here, so the request must say so rather
        // than name the child's own session — a value some panel might one day
        // match. This is the "not mine" case for every window, and with no
        // address it is answerable by nobody.
        let recorded: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
        let state = approval_probe_state(recorded.clone()).await;
        spawn_subagent(
            &state,
            &json!({ "role": "tester", "instructions": "use the editor", "maxTurns": 3 }),
        )
        .await
        .unwrap();

        let approval = gated_approval(&recorded);
        assert_eq!(approval["ownerSession"], Value::Null);
        assert_eq!(approval["targetClientId"], Value::Null);
    }

    #[tokio::test]
    async fn owner_cannot_be_smuggled_through_tool_arguments() {
        // `subagent_spawn` arguments are model-authored. If the owner could be
        // set there, a model could aim its own approval prompts at somebody's
        // open window; the owner is a Rust argument for that reason, and args
        // naming one change nothing.
        let recorded: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
        let state = approval_probe_state(recorded.clone()).await;
        attach_probe_window(&state, "session-victim").await;
        spawn_subagent(
            &state,
            &json!({
                "role": "tester",
                "instructions": "use the editor",
                "maxTurns": 3,
                "ownerSession": "session-victim"
            }),
        )
        .await
        .unwrap();

        let approval = gated_approval(&recorded);
        assert_eq!(approval["ownerSession"], Value::Null);
        assert_eq!(approval["targetClientId"], Value::Null);
    }

    #[tokio::test]
    async fn graph_node_approvals_carry_the_graph_owner_session() {
        let recorded: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
        let state = approval_probe_state(recorded.clone()).await;
        let owner = "session-graph-owner";
        attach_probe_window(&state, owner).await;
        let session_id = state.agents.reserve_session().await.unwrap();
        spawn_graph_subagent(
            &state,
            &json!({ "role": "tester", "instructions": "use the editor" }),
            &session_id,
            "graph-probe",
            Some(owner),
            None,
        )
        .await
        .unwrap();

        let approval = gated_approval(&recorded);
        // A graph node addresses its answer to the owner session and belongs
        // to it; the node's own session is named separately.
        assert_eq!(approval["sessionId"], json!(owner));
        assert_eq!(approval["ownerSession"], json!(owner));
        assert_eq!(approval["subagentSessionId"], json!(session_id));
        // …and it names the run. Address and owner are both the panel's own
        // session here — identical to one of its ordinary turns — so the run
        // is the only thing that says this prompt is the graph's.
        assert_eq!(approval["ownerGraph"], json!("graph-probe"));
        assert_eq!(approval["targetClientId"], json!(PROBE_CLIENT));
    }

    /// Defect 1's core half. A node spawns its own subagent, and the
    /// grandchild raises the prompt. Its session appears in no
    /// `graph.updated` snapshot, because snapshots carry node sessions and
    /// nothing below them — so a panel matching sessions-it-has-seen could not
    /// place it, and let the user's turn claim it instead. The run and the
    /// owner travel down the spawn chain, so nothing has to have been
    /// observed first.
    #[tokio::test]
    async fn a_graph_node_subagent_approval_routes_like_its_graph() {
        let recorded: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
        let state = delegating_approval_probe_state(recorded.clone()).await;
        let owner = "session-graph-owner";
        attach_probe_window(&state, owner).await;
        let node_session = state.agents.reserve_session().await.unwrap();
        spawn_graph_subagent(
            &state,
            &json!({ "role": "tester", "instructions": "delegate to a worker", "maxTurns": 3 }),
            &node_session,
            "graph-probe",
            Some(owner),
            None,
        )
        .await
        .unwrap();

        let approval = gated_approval(&recorded);
        assert_eq!(approval["ownerGraph"], json!("graph-probe"));
        assert_eq!(approval["ownerSession"], json!(owner));
        assert_eq!(approval["sessionId"], json!(owner));
        // The grandchild is addressed at the graph owner's window, which is
        // what lets the panel render a card for a session it has never seen.
        assert_eq!(approval["targetClientId"], json!(PROBE_CLIENT));
        let asking = approval["subagentSessionId"].as_str().unwrap();
        // The grandchild, not the node: nothing the panel could have seen.
        assert_ne!(asking, node_session);
        assert_ne!(asking, owner);
    }

    #[tokio::test]
    async fn a_graph_run_cannot_be_claimed_through_tool_arguments() {
        // If a run could be named in model-authored arguments, an unattended
        // agent could dress its own prompts up as a graph node's and have
        // somebody's open panel answer them.
        let recorded: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
        let state = approval_probe_state(recorded.clone()).await;
        attach_probe_window(&state, "session-victim").await;
        spawn_subagent(
            &state,
            &json!({
                "role": "tester",
                "instructions": "use the editor",
                "maxTurns": 3,
                "graphId": "graph-probe",
                "_graphBinding": { "graphId": "graph-probe", "approvalSession": "session-victim" }
            }),
        )
        .await
        .unwrap();

        let approval = gated_approval(&recorded);
        assert_eq!(approval["ownerGraph"], Value::Null);
        assert_eq!(approval["ownerSession"], Value::Null);
        assert_eq!(approval["targetClientId"], Value::Null);
    }
}
