//! Oversized tool results, kept whole on disk instead of thrown away.
//!
//! A tool result over the cap used to come back as "here is the first half,
//! narrow your call". That is a dead end when the tail is the part that
//! mattered: the model cannot narrow a call whose output it has not seen, so it
//! guesses, re-runs the same tool with a different limit, and pays for the
//! prefix again. opencode's `tool/truncate.ts` answers this by writing the full
//! output to a file and returning a preview plus a handle.
//!
//! The handle has to be *reachable*, which is the part that does not port
//! directly. opencode's read tool takes absolute paths; ours is confined to the
//! project or the attached workspace on purpose, so a path under `~/.cali`
//! would be a pointer the model is structurally unable to follow. Hence the
//! paired `tool_output_read` tool: it reads nothing but this directory, by id,
//! and pages by line.
//!
//! Spilled output is disposable. It is written outside the project so it never
//! shows up in the user's repository or a checkpoint, and swept on write so a
//! long run cannot accumulate it forever.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Bytes returned by one `tool_output_read` page when the caller names no limit.
const DEFAULT_PAGE_BYTES: usize = 32 * 1024;
/// Hard cap per page, so paging can never re-create the problem it solves.
const MAX_PAGE_BYTES: usize = 48 * 1024;
/// Spilled files older than this are swept. Long enough to survive a
/// multi-day `/loop`, short enough that the directory does not grow forever.
const MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;

/// Where spilled output lives, derived from the sessions directory so it sits
/// beside the rest of core's state (`~/.cali/tool-output`) and, in tests,
/// inside the temporary root rather than the real home.
pub fn dir_for(sessions_root: &Path) -> PathBuf {
    sessions_root
        .parent()
        .unwrap_or(sessions_root)
        .join("tool-output")
}

fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn path_for(dir: &Path, id: &str) -> Result<PathBuf> {
    // The id is model-supplied, so it is validated as a bare name rather than
    // joined blindly: `../../config.yaml` must never resolve.
    if !is_valid_id(id) {
        anyhow::bail!("invalid tool output id");
    }
    Ok(dir.join(format!("{id}.txt")))
}

/// Whether a file last written at `modified` is past its keep-age.
///
/// Split out from [`sweep`] so the rule is testable without backdating a file's
/// mtime, which std cannot do. A clock that has moved backwards yields `Err`
/// from `duration_since` and is treated as "not stale" — deleting on a clock
/// anomaly would throw away output the run still needs.
fn is_stale(modified: std::time::SystemTime, now: std::time::SystemTime) -> bool {
    now.duration_since(modified)
        .is_ok_and(|age| age.as_secs() > MAX_AGE_SECS)
}

/// Delete spilled files past their age. Best effort — a sweep failure must
/// never fail the tool call that triggered it.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.filter_map(std::result::Result::ok) {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if is_stale(modified, now) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// What a spill produced, for the notice the model reads.
pub struct Spilled {
    pub id: String,
}

/// Write `text` whole and return its handle. `None` when it could not be
/// written — the caller then falls back to a plain truncated preview, because
/// losing the tail is bad but failing the tool call outright is worse.
pub fn write(dir: &Path, tool: &str, text: &str) -> Option<Spilled> {
    if std::fs::create_dir_all(dir).is_err() {
        return None;
    }
    sweep(dir);
    let id = format!(
        "{}-{}",
        tool.chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .take(32)
            .collect::<String>(),
        uuid::Uuid::new_v4().simple()
    );
    let path = path_for(dir, &id).ok()?;
    std::fs::write(&path, text).ok()?;
    Some(Spilled { id })
}

/// Read one page of a spilled result, addressed by byte offset.
///
/// Bytes rather than lines, which is the correction that matters here: what is
/// spilled is the tool result's JSON, and a newline inside a JSON string is
/// escaped rather than real. A 40,000-line grep serializes to *one* line, so
/// line paging returned the first page and then reported nothing further —
/// leaving exactly the tail this module exists to preserve unreachable.
pub fn read(dir: &Path, id: &str, offset: usize, limit: Option<usize>) -> Result<Value> {
    let path = path_for(dir, id)?;
    let text = std::fs::read_to_string(&path).with_context(|| {
        format!("tool output {id} is no longer available; re-run the tool that produced it")
    })?;
    let bytes = text.as_bytes();
    let total = bytes.len();
    let limit = limit.unwrap_or(DEFAULT_PAGE_BYTES).clamp(1, MAX_PAGE_BYTES);

    // An offset past the end is an empty final page, not an error: a caller
    // paging to the end should stop, not have its turn fail.
    let start = floor_char_boundary(&text, offset.min(total));
    let end = floor_char_boundary(&text, (start + limit).min(total));
    let content = &text[start..end];

    Ok(json!({
        "id": id,
        "content": content,
        "offset": start,
        "nextOffset": if end < total { Some(end) } else { None },
        "returnedBytes": end - start,
        "totalBytes": total,
    }))
}

/// Largest index `<= at` that starts a UTF-8 character.
///
/// Slicing mid-character panics, and the index the model sends back is one we
/// handed it — but `offset` is model-authored and need not be.
fn floor_char_boundary(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while at > 0 && !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tool-output");
        (root, path)
    }

    /// Walk every page and reassemble, the way a caller actually uses this.
    fn read_all(dir: &Path, id: &str, limit: Option<usize>) -> String {
        let mut out = String::new();
        let mut offset = 0usize;
        loop {
            let page = read(dir, id, offset, limit).unwrap();
            out.push_str(page["content"].as_str().unwrap());
            match page["nextOffset"].as_u64() {
                Some(next) => offset = next as usize,
                None => break,
            }
        }
        out
    }

    #[test]
    fn spilled_output_comes_back_whole_across_pages() {
        let (_root, dir) = dir();
        let text: String = (0..1000).map(|i| format!("line {i}\n")).collect();
        let spilled = write(&dir, "file_grep", &text).expect("spill must succeed");

        let first = read(&dir, &spilled.id, 0, Some(1024)).unwrap();
        assert_eq!(first["totalBytes"], json!(text.len()));
        assert_eq!(first["offset"], json!(0));
        assert!(first["content"].as_str().unwrap().starts_with("line 0\n"));

        // Nothing is lost or duplicated across the walk.
        assert_eq!(read_all(&dir, &spilled.id, Some(1024)), text);
    }

    #[test]
    fn one_enormous_line_is_still_fully_reachable() {
        let (_root, dir) = dir();
        // What a spilled tool result actually looks like: JSON, where the
        // newlines inside a string are escaped rather than real. Line-based
        // paging saw one line here and stranded everything past the first page.
        let text = format!("{{\"matches\":\"{}TAIL\"}}", "hit\\n".repeat(30_000));
        let spilled = write(&dir, "file_grep", &text).unwrap();

        let first = read(&dir, &spilled.id, 0, None).unwrap();
        assert!(
            first["nextOffset"].as_u64().is_some(),
            "a single-line result must still page"
        );
        let whole = read_all(&dir, &spilled.id, None);
        assert_eq!(whole, text);
        assert!(whole.ends_with("TAIL\"}"), "the tail must survive the walk");
    }

    #[test]
    fn a_page_is_bounded_however_it_is_asked_for() {
        let (_root, dir) = dir();
        let text = "x".repeat(MAX_PAGE_BYTES * 4);
        let spilled = write(&dir, "file_read", &text).unwrap();
        // An over-large limit is clamped rather than honoured, so paging can
        // never re-create the oversized result this module exists to avoid.
        let page = read(&dir, &spilled.id, 0, Some(10_000_000)).unwrap();
        assert!(page["content"].as_str().unwrap().len() <= MAX_PAGE_BYTES);
        assert!(page["nextOffset"].as_u64().is_some());
    }

    #[test]
    fn paging_never_splits_a_character() {
        let (_root, dir) = dir();
        // Multi-byte throughout, so almost every byte offset lands mid-character.
        let text = "\u{65e5}\u{672c}\u{8a9e}\u{306e}\u{30c6}\u{30ad}\u{30b9}\u{30c8}".repeat(4_000);
        let spilled = write(&dir, "file_read", &text).unwrap();
        // Reassembles exactly — a mid-character slice would panic or corrupt.
        assert_eq!(read_all(&dir, &spilled.id, Some(1_001)), text);

        // A model-authored offset that is not on a boundary is floored, not
        // rejected and not panicked on.
        let page = read(&dir, &spilled.id, 1, Some(64)).unwrap();
        assert_eq!(page["offset"], json!(0));
    }

    #[test]
    fn an_offset_past_the_end_is_an_empty_last_page() {
        let (_root, dir) = dir();
        let spilled = write(&dir, "file_read", "short").unwrap();
        let page = read(&dir, &spilled.id, 9_999, None).unwrap();
        assert_eq!(page["content"], json!(""));
        assert_eq!(page["nextOffset"], json!(null));
    }

    #[test]
    fn an_id_cannot_escape_the_spill_directory() {
        let (_root, dir) = dir();
        std::fs::create_dir_all(&dir).unwrap();
        // The id reaches this function from a model-authored tool call.
        for hostile in ["../config", "..", "a/b", "/etc/passwd", ""] {
            assert!(
                read(&dir, hostile, 0, None).is_err(),
                "{hostile} must be refused"
            );
        }
    }

    #[test]
    fn a_missing_id_says_what_to_do_instead_of_panicking() {
        let (_root, dir) = dir();
        std::fs::create_dir_all(&dir).unwrap();
        let error = read(&dir, "file_grep-deadbeef", 0, None).unwrap_err();
        assert!(format!("{error:#}").contains("re-run the tool"));
    }

    #[test]
    fn staleness_is_measured_in_days_not_minutes() {
        let now = std::time::SystemTime::now();
        let day = std::time::Duration::from_secs(24 * 60 * 60);
        // A multi-day `/loop` must not have its own spilled output swept out
        // from under it.
        assert!(!is_stale(now, now));
        assert!(!is_stale(now - day * 6, now));
        assert!(is_stale(now - day * 8, now));
        // A clock that jumped backwards must not trigger deletion.
        assert!(!is_stale(now + day, now));
    }

    #[test]
    fn a_sweep_keeps_fresh_spills() {
        let (_root, dir) = dir();
        let keep = write(&dir, "file_grep", "recent\n").unwrap();
        // Any write triggers the sweep; nothing here is old enough to go.
        write(&dir, "file_glob", "trigger\n").unwrap();
        assert!(read(&dir, &keep.id, 0, None).is_ok(), "fresh spill kept");
    }

    #[test]
    fn the_spill_directory_sits_outside_the_project() {
        // Never inside the game or the attached repo: spilled output must not
        // reach the user's repository or a checkpoint.
        let sessions = Path::new("/home/u/.cali/sessions");
        assert_eq!(dir_for(sessions), Path::new("/home/u/.cali/tool-output"));
    }
}
