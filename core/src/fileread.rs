//! Windowed file reads.
//!
//! `file_read` is the most-called tool in any agent session — every edit is
//! preceded by one, every grep hit becomes one. Its result is pushed into the
//! message history (`agent.rs`) and re-sent to the model on *every subsequent
//! turn*, so a byte returned here is not paid for once, it is paid for by
//! every turn that follows until compaction. That makes this module a token
//! budget, not a convenience wrapper around `read_to_string`.
//!
//! Three ceilings, because a file can be pathological in three independent
//! ways and each ceiling misses two of them:
//!
//! * `DEFAULT_LINE_LIMIT` bounds a file with *many* lines (a lockfile).
//! * `MAX_WINDOW_BYTES` bounds a file whose lines are *wide* rather than many
//!   (a log, a data dump).
//! * `MAX_LINE_CHARS` bounds a *single* line — the minified bundle that sits
//!   comfortably inside the line window and, on its own, eats the whole byte
//!   budget, returning one unusable mega-string that displaced everything the
//!   model actually needed.
//!
//! And one rule about failure: a read that returns nothing is
//! indistinguishable, from inside the model, from a broken tool, so it
//! retries — widening, re-listing, re-reading — and burns three turns learning
//! what one sentence could have told it. Every dead end here therefore names
//! its own recovery in `notice`, with the pagination arithmetic already done,
//! and none of them are errors: an empty file is a fact about the world, not a
//! failure worth apologising for.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

/// Lines returned when the caller does not ask for a window.
pub const DEFAULT_LINE_LIMIT: usize = 2_000;
/// Ceiling on an explicit `limit`, so one call cannot be talked into buffering
/// an unbounded number of (possibly empty) lines.
const MAX_LINE_LIMIT: usize = 5_000;
/// Total content bytes one read may return.
const MAX_WINDOW_BYTES: usize = 128 * 1024;
/// Characters of any single line. A minified bundle is one line of 900KB;
/// without this it passes the line window trivially and eats the byte budget.
const MAX_LINE_CHARS: usize = 2_000;
/// Bytes retained per line before clamping. Four bytes per char is the UTF-8
/// worst case, so a line that survives this still has `MAX_LINE_CHARS` to give.
const LINE_RETAIN_BYTES: usize = MAX_LINE_CHARS * 4;
/// Streaming chunk. Nothing before the requested window is ever accumulated,
/// so a 400MB line sitting *above* your offset costs a scan, not memory.
const CHUNK_BYTES: usize = 64 * 1024;
/// Bytes sniffed to classify a file as binary/image/pdf.
const PROBE_BYTES: usize = 8_192;

/// Why the window stopped filling. Each maps to a different recovery sentence.
#[derive(Debug, PartialEq)]
enum Stop {
    /// The file ended. `total_lines` is therefore exact.
    Eof,
    /// `limit` lines were taken and bytes remain after them.
    LineLimit,
    /// Adding the next line would have blown `MAX_WINDOW_BYTES`.
    ByteLimit,
}

struct Window {
    lines: Vec<String>,
    /// Content bytes accumulated (including the newlines that join lines).
    bytes: usize,
    /// 1-indexed line the window starts at; equals the requested offset.
    start_line: usize,
    /// 1-indexed last line included, or `start_line - 1` when nothing matched.
    end_line: usize,
    /// Known only when the read reached EOF. Deliberately absent otherwise:
    /// counting the rest of the file to report a total would undo the whole
    /// point of stopping early.
    total_lines: Option<usize>,
    stop: Stop,
    /// Any line was clamped by `MAX_LINE_CHARS`.
    clamped: bool,
}

/// Read a window of `path` as text, or describe why it is not text.
///
/// `offset` is a 1-indexed line number; `limit` a line count. Both are
/// clamped rather than rejected — a caller asking for line 0 means line 1, and
/// a silently wrong window is worse than a corrected one.
pub fn read_window(path: &Path, rel: &str, offset: usize, limit: usize) -> Result<Value> {
    let offset = offset.max(1);
    let limit = limit.clamp(1, MAX_LINE_LIMIT);

    let meta = std::fs::symlink_metadata(path).with_context(|| format!("cannot stat {rel}"))?;

    if meta.is_dir() {
        return Ok(notice_only(
            rel,
            format!("{rel} is a directory. Use file_list to see what is in it."),
        ));
    }
    // A character device (/dev/zero, /dev/urandom), fifo, or socket has no
    // end; reading one is a hang the tool shipped itself. `safe_resolve`
    // already refuses symlinks that leave the workspace, so this catches the
    // node planted *inside* it.
    if !meta.is_file() {
        return Ok(notice_only(
            rel,
            format!("{rel} is not a regular file, so it has no readable contents."),
        ));
    }
    let size = meta.len();
    if size == 0 {
        return Ok(notice_only(rel, format!("{rel} is empty (0 bytes).")));
    }

    let mut file = std::fs::File::open(path).with_context(|| format!("cannot open {rel}"))?;
    let mut probe = vec![0u8; PROBE_BYTES.min(size as usize)];
    let probed = file.read(&mut probe)?;
    probe.truncate(probed);

    if let Some(kind) = classify_binary(&probe, rel) {
        return Ok(binary_notice(path, rel, size, kind));
    }

    file.seek(SeekFrom::Start(0))?;
    let window = stream_window(file, offset, limit)?;
    Ok(describe(rel, size, offset, limit, window))
}

/// What a non-text file is, for the notice. Detection sniffs magic bytes
/// rather than the extension: garbage in a `.png` must not be announced as an
/// image, and a real PNG named `.txt` must not be spilled into the context as
/// mojibake.
enum Binary {
    Image(&'static str),
    Pdf,
    Opaque,
}

fn classify_binary(probe: &[u8], rel: &str) -> Option<Binary> {
    if probe.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(Binary::Image("PNG"));
    }
    if probe.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(Binary::Image("JPEG"));
    }
    if probe.starts_with(b"GIF87a") || probe.starts_with(b"GIF89a") {
        return Some(Binary::Image("GIF"));
    }
    if probe.len() >= 12 && probe.starts_with(b"RIFF") && &probe[8..12] == b"WEBP" {
        return Some(Binary::Image("WebP"));
    }
    if probe.starts_with(b"%PDF") {
        return Some(Binary::Pdf);
    }
    // SVG is XML: the model can read and edit it, so it is text no matter how
    // it is classified elsewhere.
    if rel.to_ascii_lowercase().ends_with(".svg") {
        return None;
    }
    // A NUL byte in the head is the classic binary tell.
    if probe.contains(&0) {
        return Some(Binary::Opaque);
    }
    None
}

fn binary_notice(path: &Path, rel: &str, size: u64, kind: Binary) -> Value {
    let human = human_bytes(size);
    let notice = match kind {
        Binary::Image(format) => {
            // Dimensions come from the header alone, so this costs a few bytes
            // of I/O and tells the model whether the image is even worth
            // pulling in.
            let dims = image::image_dimensions(path)
                .map(|(w, h)| format!(", {w}x{h}"))
                .unwrap_or_default();
            format!(
                "{rel} is a {format} image{dims} ({human}), not text. Use asset_import_file to \
                 bring it into the project, or image3d_mesh to turn it into geometry."
            )
        }
        Binary::Pdf => format!(
            "{rel} is a PDF ({human}), not text. Extract it first with \
             `pdftotext {rel} -` and read the output."
        ),
        Binary::Opaque => format!(
            "{rel} is a binary file ({human}), so it has no text to show. \
             Use file_grep if you are looking for a string inside it."
        ),
    };
    json!({
        "path": rel,
        "encoding": "binary",
        "bytes": size,
        "notice": notice,
    })
}

fn notice_only(rel: &str, notice: String) -> Value {
    json!({ "path": rel, "content": "", "notice": notice })
}

/// Stream `file`, retaining only the requested window.
///
/// Lines before `offset` are counted and discarded without ever being held, so
/// the cost of a deep offset is a scan rather than a buffer. Within the window
/// each line is capped at `LINE_RETAIN_BYTES` as it accumulates, which is what
/// keeps a single 400MB line from being materialised just to be clamped
/// afterwards.
fn stream_window(file: std::fs::File, offset: usize, limit: usize) -> Result<Window> {
    let mut reader = std::io::BufReader::new(file);
    let mut chunk = vec![0u8; CHUNK_BYTES];

    let mut lines: Vec<String> = Vec::new();
    let mut bytes = 0usize;
    let mut clamped = false;

    // State for the line currently being accumulated.
    let mut line_no = 0usize; // number of COMPLETED lines so far
    let mut retained: Vec<u8> = Vec::new();
    let mut line_bytes = 0usize; // true length, including what we refused to keep
    let mut line_started = false; // any byte (even zero-length before a '\n')
    let mut first_line = true;

    let stop: Stop;
    let mut total_lines = None;
    // Set once the window is full and the current chunk had nothing left after
    // it. We cannot answer "is there more file?" from that position — the
    // answer does not exist yet — so we defer to the next read instead of
    // guessing. Guessing is wrong roughly half the time and costs a turn every
    // time it fires.
    let mut probing_for_more = false;

    'outer: loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            if probing_for_more {
                // The window filled exactly at the end of the file. Nothing
                // remains, so this is a complete read, not a truncated one.
                total_lines = Some(line_no);
                stop = Stop::Eof;
                break;
            }
            // A trailing line with no final newline still counts.
            if line_started {
                line_no += 1;
                if line_no >= offset && lines.len() < limit {
                    match push_line(&mut lines, &mut bytes, &retained, line_bytes, first_line) {
                        Some(was_clamped) => clamped |= was_clamped,
                        None => {
                            // The budget ran out on the very last line. The
                            // file did end, so the total is still exact even
                            // though the window is short of it.
                            total_lines = Some(line_no);
                            stop = Stop::ByteLimit;
                            break;
                        }
                    }
                }
            }
            total_lines = Some(line_no);
            stop = Stop::Eof;
            break;
        }
        if probing_for_more {
            // Any byte at all past a full window means the file continues.
            stop = Stop::LineLimit;
            break;
        }

        let mut slice = &chunk[..read];
        while let Some(nl) = slice.iter().position(|&b| b == b'\n') {
            retain(&mut retained, &mut line_bytes, &slice[..nl]);
            slice = &slice[nl + 1..];

            line_no += 1;
            if line_no >= offset {
                match push_line(&mut lines, &mut bytes, &retained, line_bytes, first_line) {
                    Some(was_clamped) => clamped |= was_clamped,
                    // The refused line is deliberately not counted into the
                    // window: `end_line` is derived from what was actually
                    // shown, so the resume offset lands ON it.
                    None => {
                        stop = Stop::ByteLimit;
                        break 'outer;
                    }
                }
                first_line = false;
            }
            retained.clear();
            line_bytes = 0;
            line_started = false;

            if lines.len() >= limit {
                if !slice.is_empty() {
                    stop = Stop::LineLimit;
                    break 'outer;
                }
                probing_for_more = true;
                continue 'outer;
            }
        }
        if !slice.is_empty() {
            retain(&mut retained, &mut line_bytes, slice);
            line_started = true;
        }
    }

    let start_line = offset;
    let end_line = if lines.is_empty() {
        offset.saturating_sub(1)
    } else {
        offset + lines.len() - 1
    };
    Ok(Window {
        lines,
        bytes,
        start_line,
        end_line,
        total_lines,
        stop,
        clamped,
    })
}

/// Append `data` to the current line, keeping at most `LINE_RETAIN_BYTES` of
/// it while still counting the true length so the clamp notice can be honest.
fn retain(retained: &mut Vec<u8>, line_bytes: &mut usize, data: &[u8]) {
    *line_bytes += data.len();
    let room = LINE_RETAIN_BYTES.saturating_sub(retained.len());
    if room > 0 {
        retained.extend_from_slice(&data[..room.min(data.len())]);
    }
}

/// Push one completed line into the window.
///
/// Returns `Some(clamped)` on success, or `None` when the byte budget is
/// exhausted — in which case the line was NOT added and the caller must resume
/// *at* it. The window is never left empty by the budget: a single line always
/// gets through, which the per-line clamp makes safe (it can only be ~8KB).
fn push_line(
    lines: &mut Vec<String>,
    bytes: &mut usize,
    retained: &[u8],
    line_bytes: usize,
    first_line: bool,
) -> Option<bool> {
    let (text, clamped) = render_line(retained, line_bytes, first_line);
    // +1 for the newline that will join this line to the previous one.
    let cost = text.len() + usize::from(!lines.is_empty());
    if !lines.is_empty() && *bytes + cost > MAX_WINDOW_BYTES {
        return None;
    }
    *bytes += cost;
    lines.push(text);
    Some(clamped)
}

/// Turn one line's retained bytes into display text: BOM stripped (first line
/// only), CRLF normalised to LF, clamped to `MAX_LINE_CHARS`.
fn render_line(retained: &[u8], line_bytes: usize, first_line: bool) -> (String, bool) {
    let mut raw = retained;
    if first_line {
        if let Some(rest) = raw.strip_prefix(b"\xEF\xBB\xBF") {
            raw = rest;
        }
    }
    if raw.last() == Some(&b'\r') {
        raw = &raw[..raw.len() - 1];
    }
    let dropped_bytes = line_bytes.saturating_sub(retained.len());
    let text = String::from_utf8_lossy(utf8_prefix(raw, raw.len()));

    let char_count = text.chars().count();
    if char_count <= MAX_LINE_CHARS && dropped_bytes == 0 {
        return (text.into_owned(), false);
    }
    let kept: String = text.chars().take(MAX_LINE_CHARS).collect();
    let dropped_here: usize = text
        .chars()
        .skip(MAX_LINE_CHARS)
        .map(char::len_utf8)
        .sum::<usize>()
        + dropped_bytes;
    (
        format!("{kept} …[line clamped, {dropped_here} more bytes]"),
        true,
    )
}

/// Longest prefix of `bytes` no longer than `max` that ends on a UTF-8
/// character boundary. Cutting a codepoint in half turns a clean truncation
/// into a replacement-character smear the model has to reason around.
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

/// Assemble the result, attaching a recovery sentence whenever the read was
/// anything other than "here is the whole file".
///
/// A clean, complete read carries no notice at all — the commonest case must
/// not pay for the rare ones.
fn describe(rel: &str, size: u64, offset: usize, limit: usize, window: Window) -> Value {
    let content = window.lines.join("\n");
    let mut result = json!({
        "path": rel,
        "content": content,
        "startLine": window.start_line,
        "endLine": window.end_line,
        "bytes": window.bytes,
    });

    let complete_from_start = window.stop == Stop::Eof && offset == 1;
    if let Some(total) = window.total_lines {
        result["totalLines"] = json!(total);
    }
    result["truncated"] = json!(!complete_from_start || window.clamped);

    let mut notices: Vec<String> = Vec::new();

    // Offset past the end. This is the one case worth the full scan's line
    // count, because the count is exactly what the model needs to retry.
    if window.lines.is_empty() {
        if let Some(total) = window.total_lines {
            notices.push(format!(
                "{rel} has {total} line{}; offset {offset} is past the end. \
                 Retry with a smaller offset.",
                if total == 1 { "" } else { "s" }
            ));
        }
    }

    match window.stop {
        Stop::Eof => {}
        Stop::LineLimit => notices.push(format!(
            "Showing lines {}-{} ({} line window); the file continues. \
             Continue with offset={}.",
            window.start_line,
            window.end_line,
            limit,
            window.end_line + 1
        )),
        // Resume AT the first line the budget refused, not after it: an
        // off-by-one in a resume hint is a silently corrupted read, which is
        // the one failure here worse than a wasted turn.
        Stop::ByteLimit => notices.push(format!(
            "Showing lines {}-{}; the {}KB read budget stopped it there and the file \
             continues. Continue with offset={}.",
            window.start_line,
            window.end_line,
            MAX_WINDOW_BYTES / 1024,
            window.end_line + 1
        )),
    }

    if window.clamped {
        notices.push(format!(
            "Long lines were clamped to {MAX_LINE_CHARS} characters. \
             Use file_grep to search inside them."
        ));
    }

    if !notices.is_empty() {
        result["notice"] = json!(notices.join(" "));
    }
    let _ = size;
    result
}

fn human_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    match bytes {
        b if b >= MB => format!("{:.1} MB", b as f64 / MB as f64),
        b if b >= KB => format!("{:.1} KB", b as f64 / KB as f64),
        b => format!("{b} bytes"),
    }
}

// ---------------------------------------------------------------------------
// Path repair
// ---------------------------------------------------------------------------

/// U+202F NARROW NO-BREAK SPACE. macOS puts one before AM/PM in screenshot
/// filenames.
const NARROW_NBSP: char = '\u{202F}';
/// U+00A0 NO-BREAK SPACE, the other invisible impostor.
const NBSP: char = '\u{00A0}';

/// Spellings to try for `rel`, most likely first, before reporting it missing.
///
/// macOS stores filenames NFD-decomposed while every model types NFC; Finder
/// rewrites `'` as `’`; screenshots carry a narrow no-break space. Each of
/// these renders *identically* in a terminal, so the model reads the path off
/// the screen, retypes it faithfully, gets "not found", and no amount of
/// reasoning recovers — the difference is not in the glyphs. When a failure is
/// invisible to the model, retrying is the tool's job.
///
/// Callers MUST re-resolve every candidate through the same boundary check as
/// the original: a repair that quietly becomes an escape hatch is worse than
/// the missing file.
pub fn spelling_candidates(rel: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |value: String| {
        if !value.is_empty() && !out.contains(&value) {
            out.push(value);
        }
    };
    push(rel.to_string());
    push(rel.nfc().collect());
    push(rel.nfd().collect());

    let widened: String = rel
        .chars()
        .map(|c| {
            if c == NARROW_NBSP || c == NBSP {
                ' '
            } else {
                c
            }
        })
        .collect();
    push(widened.clone());
    push(widened.nfc().collect());

    let narrowed: String = rel
        .chars()
        .map(|c| if c == ' ' { NARROW_NBSP } else { c })
        .collect();
    push(narrowed);

    let straightened: String = rel
        .chars()
        .map(|c| match c {
            '\u{2019}' => '\'',
            '\u{201C}' | '\u{201D}' => '"',
            _ => c,
        })
        .collect();
    push(straightened.clone());
    push(straightened.nfd().collect());

    let curled: String = rel
        .chars()
        .map(|c| if c == '\'' { '\u{2019}' } else { c })
        .collect();
    push(curled);

    out
}

/// Names in `dir` close enough to `name` to be what the caller meant.
///
/// Substring matching alone misses `AGENT.md` → `AGENTS.md`, which is why the
/// bounded edit distance is here too; edit distance alone misses
/// `main` → `main.rs`, which is why the substring pass stays.
pub fn did_you_mean(dir: &Path, name: &str) -> Vec<String> {
    // No real filename is this long, and the substring scan below is O(n·m)
    // against every entry in the directory — a megabyte-long name would buy
    // the caller a second of CPU per failed read.
    if name.len() > MAX_PATH_BYTES {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let needle = name.to_lowercase();
    let mut scored: Vec<(usize, String)> = Vec::new();
    for entry in entries.flatten().take(4_000) {
        let candidate = entry.file_name().to_string_lossy().to_string();
        if candidate.starts_with('.') {
            continue;
        }
        let lower = candidate.to_lowercase();
        if lower == needle {
            scored.push((0, candidate));
            continue;
        }
        if lower.contains(&needle) || needle.contains(&lower) {
            scored.push((1, candidate));
            continue;
        }
        if let Some(distance) = bounded_edit_distance(&lower, &needle, 2) {
            scored.push((2 + distance, candidate));
        }
    }
    scored.sort();
    scored.into_iter().take(3).map(|(_, name)| name).collect()
}

/// Levenshtein distance, or `None` once it is known to exceed `max`.
fn bounded_edit_distance(a: &str, b: &str, max: usize) -> Option<usize> {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > max {
        return None;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut current = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        current[0] = i + 1;
        let mut row_best = current[0];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            current[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(current[j] + 1);
            row_best = row_best.min(current[j + 1]);
        }
        if row_best > max {
            return None;
        }
        std::mem::swap(&mut prev, &mut current);
    }
    let distance = prev[b.len()];
    (distance <= max).then_some(distance)
}

// ---------------------------------------------------------------------------
// Argument repair
// ---------------------------------------------------------------------------

/// Names other harnesses use for the path argument. An open model that has
/// seen a dozen tool schemas will reach for one of these; bouncing the call
/// costs a turn to teach it something the tool already knows.
const PATH_ALIASES: &[&str] = &[
    "path",
    "file_path",
    "filePath",
    "absolutePath",
    "absolute_path",
    "target_file",
    "filename",
    "file",
];

/// Longest path argument accepted. `PATH_MAX` is 1024 on macOS and 4096 on
/// Linux, so nothing openable is anywhere near this; the cap exists to stop a
/// multi-megabyte string from reaching the repair and suggestion passes, which
/// scan it against every candidate spelling and every directory entry.
const MAX_PATH_BYTES: usize = 4_096;

/// The path argument under whichever name the caller used.
pub fn arg_path(args: &Value) -> Result<&str> {
    for key in PATH_ALIASES {
        if let Some(value) = args.get(*key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.len() > MAX_PATH_BYTES {
                anyhow::bail!(
                    "path is {} bytes; no file path is longer than {MAX_PATH_BYTES}",
                    trimmed.len()
                );
            }
            return Ok(trimmed);
        }
    }
    anyhow::bail!("missing required string path")
}

/// A whole-number argument, repaired where the intent is unambiguous.
///
/// `"2000"` coerces; `"2abc"` is refused rather than silently read as 2, and a
/// fractional offset is refused rather than floored — a silently wrong window
/// is worse than an error, because the model has no way to notice it.
pub fn arg_count(args: &Value, key: &str, default: usize) -> Result<usize> {
    let Some(value) = args.get(key) else {
        return Ok(default);
    };
    match value {
        Value::Null => Ok(default),
        Value::Number(number) => {
            if let Some(unsigned) = number.as_u64() {
                return Ok(unsigned as usize);
            }
            if let Some(float) = number.as_f64() {
                if float.fract() != 0.0 {
                    anyhow::bail!("{key} must be a whole number, got {float}");
                }
                if float < 0.0 {
                    anyhow::bail!("{key} must not be negative");
                }
                return Ok(float as usize);
            }
            anyhow::bail!("{key} must be a whole number")
        }
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Ok(default);
            }
            trimmed
                .parse::<usize>()
                .map_err(|_| anyhow::anyhow!("{key} must be a whole number, got {trimmed:?}"))
        }
        other => anyhow::bail!("{key} must be a whole number, got {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    fn read(path: &Path, offset: usize, limit: usize) -> Value {
        read_window(path, "f.txt", offset, limit).unwrap()
    }

    #[test]
    fn a_small_file_reads_whole_and_carries_no_notice() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "f.txt", "one\ntwo\nthree\n");
        let result = read(&path, 1, DEFAULT_LINE_LIMIT);
        assert_eq!(result["content"], "one\ntwo\nthree");
        assert_eq!(result["startLine"], 1);
        assert_eq!(result["endLine"], 3);
        assert_eq!(result["totalLines"], 3);
        assert_eq!(result["truncated"], false);
        // The common case must not pay for the rare ones.
        assert!(result["notice"].is_null(), "clean read carries no notice");
    }

    #[test]
    fn a_file_without_a_trailing_newline_keeps_its_last_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "f.txt", "one\ntwo");
        let result = read(&path, 1, DEFAULT_LINE_LIMIT);
        assert_eq!(result["content"], "one\ntwo");
        assert_eq!(result["totalLines"], 2);
    }

    #[test]
    fn the_line_window_bounds_a_long_file_and_names_the_resume_offset() {
        let dir = tempfile::tempdir().unwrap();
        let body: String = (1..=5_000).map(|n| format!("line {n}\n")).collect();
        let path = write(dir.path(), "f.txt", &body);

        let result = read(&path, 1, 2_000);
        assert_eq!(result["startLine"], 1);
        assert_eq!(result["endLine"], 2_000);
        assert_eq!(result["truncated"], true);
        // No totalLines: counting the rest would undo stopping early.
        assert!(result["totalLines"].is_null());
        let notice = result["notice"].as_str().unwrap();
        assert!(notice.contains("offset=2001"), "notice was: {notice}");
        assert!(!notice.starts_with("Error"), "a fact, not a failure");

        // The offset the notice handed back resumes exactly where it stopped.
        let next = read(&path, 2_001, 2_000);
        assert!(next["content"].as_str().unwrap().starts_with("line 2001\n"));
    }

    #[test]
    fn the_byte_budget_bounds_a_file_whose_lines_are_wide() {
        let dir = tempfile::tempdir().unwrap();
        // 1,000 lines x 900 chars ≈ 900KB, well inside the 2,000-line window
        // and well past the 128KB budget.
        let wide = "w".repeat(900);
        let body: String = (0..1_000).map(|_| format!("{wide}\n")).collect();
        let path = write(dir.path(), "f.txt", &body);

        let result = read(&path, 1, DEFAULT_LINE_LIMIT);
        let bytes = result["bytes"].as_u64().unwrap();
        assert!(bytes <= MAX_WINDOW_BYTES as u64, "returned {bytes} bytes");
        let notice = result["notice"].as_str().unwrap();
        assert!(notice.contains("128KB read budget"), "notice was: {notice}");

        // The resume offset must point at the first line NOT shown — an
        // off-by-one here is a silently corrupted read.
        let end = result["endLine"].as_u64().unwrap() as usize;
        let resumed = read(&path, end + 1, DEFAULT_LINE_LIMIT);
        assert_eq!(resumed["startLine"], end as u64 + 1);
        assert!(!resumed["content"].as_str().unwrap().is_empty());
    }

    #[test]
    fn the_per_line_clamp_catches_the_minified_bundle() {
        let dir = tempfile::tempdir().unwrap();
        // One line of 900KB: it passes the line window trivially, and without
        // the third ceiling it would eat the entire byte budget on its own.
        let path = write(dir.path(), "f.txt", &format!("{}\n", "m".repeat(900_000)));

        let result = read(&path, 1, DEFAULT_LINE_LIMIT);
        let content = result["content"].as_str().unwrap();
        assert!(
            content.len() < 16_000,
            "one minified line returned {} bytes",
            content.len()
        );
        assert!(content.contains("line clamped"));
        assert_eq!(result["truncated"], true);
        assert!(result["notice"]
            .as_str()
            .unwrap()
            .contains("clamped to 2000 characters"));
    }

    #[test]
    fn a_huge_line_above_the_window_is_never_accumulated() {
        let dir = tempfile::tempdir().unwrap();
        // 8MB on line 1; the window starts at line 2. Streaming means this
        // costs a scan, not 8MB of buffer.
        let mut body = "x".repeat(8 * 1024 * 1024);
        body.push_str("\nwanted\n");
        let path = write(dir.path(), "f.txt", &body);

        let result = read(&path, 2, 10);
        assert_eq!(result["content"], "wanted");
        assert_eq!(result["startLine"], 2);
    }

    #[test]
    fn an_offset_past_the_end_reports_the_real_line_count() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "f.txt", "one\ntwo\n");
        let result = read(&path, 99, 10);
        assert_eq!(result["content"], "");
        let notice = result["notice"].as_str().unwrap();
        assert!(notice.contains("has 2 lines"), "notice was: {notice}");
        assert!(notice.contains("smaller offset"));
    }

    #[test]
    fn an_empty_file_says_so_instead_of_returning_silence() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "f.txt", "");
        let result = read(&path, 1, 10);
        assert_eq!(result["content"], "");
        assert!(result["notice"].as_str().unwrap().contains("is empty"));
    }

    #[test]
    fn a_window_ending_exactly_at_eof_is_not_reported_as_truncated() {
        // The chunk-boundary bug: at the moment the line limit is hit, the
        // answer to "is there more file?" does not exist yet. Guessing "yes"
        // is a lie about half the time and costs a turn every time.
        let dir = tempfile::tempdir().unwrap();
        let body: String = (1..=100).map(|n| format!("line {n}\n")).collect();
        let path = write(dir.path(), "f.txt", &body);

        let result = read(&path, 1, 100);
        assert_eq!(result["endLine"], 100);
        assert_eq!(result["totalLines"], 100);
        assert_eq!(result["truncated"], false);
        assert!(result["notice"].is_null(), "nothing remains to report");

        // One line short, and the file genuinely does continue.
        let short = read(&path, 1, 99);
        assert_eq!(short["truncated"], true);
        assert!(short["notice"].as_str().unwrap().contains("offset=100"));
    }

    #[test]
    fn window_ending_at_a_chunk_boundary_still_decides_correctly() {
        // Force the fill to land exactly on the 64KB chunk edge.
        let dir = tempfile::tempdir().unwrap();
        let line = "y".repeat(63); // 64 bytes with the newline
        let lines = CHUNK_BYTES / 64;
        let exact: String = (0..lines).map(|_| format!("{line}\n")).collect();
        let path = write(dir.path(), "f.txt", &exact);
        let result = read(&path, 1, lines);
        assert_eq!(result["truncated"], false, "file ended at the boundary");

        let mut more = exact.clone();
        more.push_str("after\n");
        let path = write(dir.path(), "g.txt", &more);
        let result = read_window(&path, "g.txt", 1, lines).unwrap();
        assert_eq!(
            result["truncated"], true,
            "file continued past the boundary"
        );
    }

    #[test]
    fn crlf_and_bom_are_normalised_away() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "f.txt", "\u{feff}one\r\ntwo\r\n");
        let result = read(&path, 1, 10);
        assert_eq!(result["content"], "one\ntwo");
    }

    #[test]
    fn multibyte_text_is_never_cut_mid_codepoint() {
        let dir = tempfile::tempdir().unwrap();
        // 3 bytes per char, so the retain cap lands mid-codepoint unless the
        // prefix is trimmed to a boundary.
        let path = write(dir.path(), "f.txt", &format!("{}\n", "漢".repeat(60_000)));
        let result = read(&path, 1, 10);
        let content = result["content"].as_str().unwrap();
        assert!(!content.contains('\u{fffd}'), "codepoint was split");
        assert!(content.contains("line clamped"));
    }

    #[test]
    fn binary_reports_its_kind_instead_of_spilling_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob.bin");
        std::fs::write(&path, [0u8, 1, 2, 3, 0, 9]).unwrap();
        let result = read_window(&path, "blob.bin", 1, 10).unwrap();
        assert_eq!(result["encoding"], "binary");
        assert!(result["content"].is_null());
        assert!(result["notice"].as_str().unwrap().contains("binary file"));
    }

    #[test]
    fn format_detection_sniffs_magic_bytes_not_the_extension() {
        let dir = tempfile::tempdir().unwrap();
        // A real PNG header behind a .txt name must not be spilled as text...
        let png = dir.path().join("lie.txt");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\nrest").unwrap();
        let result = read_window(&png, "lie.txt", 1, 10).unwrap();
        assert!(result["notice"].as_str().unwrap().contains("PNG image"));

        // ...and text behind a .png name must not be announced as an image.
        let text = dir.path().join("lie.png");
        std::fs::write(&text, b"just words\n").unwrap();
        let result = read_window(&text, "lie.png", 1, 10).unwrap();
        assert_eq!(result["content"], "just words");
    }

    #[test]
    fn svg_is_text_because_the_model_can_edit_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "icon.svg", "<svg viewBox=\"0 0 1 1\"/>\n");
        let result = read_window(&path, "icon.svg", 1, 10).unwrap();
        assert_eq!(result["content"], "<svg viewBox=\"0 0 1 1\"/>");
    }

    #[test]
    fn pdf_gets_an_extraction_hint_rather_than_a_refusal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.pdf");
        std::fs::write(&path, b"%PDF-1.7\n\x00binary").unwrap();
        let result = read_window(&path, "doc.pdf", 1, 10).unwrap();
        assert!(result["notice"].as_str().unwrap().contains("pdftotext"));
    }

    #[test]
    fn a_directory_is_redirected_not_errored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        let result = read_window(&dir.path().join("src"), "src", 1, 10).unwrap();
        assert!(result["notice"].as_str().unwrap().contains("file_list"));
    }

    #[cfg(unix)]
    #[test]
    fn a_character_device_is_refused_before_it_can_hang_the_agent() {
        // A read tool that blocks forever on /dev/zero is a denial of service
        // you shipped yourself.
        let result = read_window(Path::new("/dev/zero"), "zero", 1, 10).unwrap();
        assert!(result["notice"]
            .as_str()
            .unwrap()
            .contains("not a regular file"));
    }

    #[test]
    fn spelling_candidates_cover_the_invisible_macos_traps() {
        let narrow = format!("Screenshot 3.04{NARROW_NBSP}PM.png");
        let candidates = spelling_candidates(&narrow);
        assert!(candidates.contains(&"Screenshot 3.04 PM.png".to_string()));

        let curly = "Ziwen\u{2019}s notes.md";
        assert!(spelling_candidates(curly).contains(&"Ziwen's notes.md".to_string()));

        // NFC input must offer the NFD spelling APFS actually stores.
        let nfc = "café/menu.txt";
        let nfd: String = nfc.nfd().collect();
        assert!(spelling_candidates(nfc).contains(&nfd));

        // The original is always tried first, and nothing is duplicated.
        let plain = spelling_candidates("src/main.rs");
        assert_eq!(plain[0], "src/main.rs");
        assert_eq!(plain.len(), 1, "ascii path needs no repairs: {plain:?}");
    }

    #[test]
    fn did_you_mean_catches_what_substring_matching_misses() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "x").unwrap();
        std::fs::write(dir.path().join("README.md"), "x").unwrap();
        // Substring matching finds nothing for AGENT.md -> AGENTS.md; the
        // bounded edit distance is what closes that gap.
        let hits = did_you_mean(dir.path(), "AGENT.md");
        assert_eq!(hits.first().map(String::as_str), Some("AGENTS.md"));

        // ...and edit distance alone would miss main -> main.rs.
        std::fs::write(dir.path().join("main.rs"), "x").unwrap();
        assert!(did_you_mean(dir.path(), "main").contains(&"main.rs".to_string()));

        assert!(did_you_mean(dir.path(), "totally-unrelated-xyz").is_empty());
    }

    #[test]
    fn path_argument_aliases_are_repaired() {
        assert_eq!(arg_path(&json!({"path": "a.txt"})).unwrap(), "a.txt");
        assert_eq!(arg_path(&json!({"filePath": "b.txt"})).unwrap(), "b.txt");
        assert_eq!(arg_path(&json!({"target_file": "c.txt"})).unwrap(), "c.txt");
        assert!(arg_path(&json!({"nope": "d.txt"})).is_err());
        assert!(arg_path(&json!({"path": "   "})).is_err());

        // An absurdly long path is refused before it reaches the repair and
        // suggestion passes, which scan it against every candidate spelling
        // and every directory entry.
        let huge = "x".repeat(MAX_PATH_BYTES + 1);
        assert!(arg_path(&json!({ "path": huge })).is_err());
        assert!(did_you_mean(Path::new("."), &huge).is_empty());
    }

    #[test]
    fn numeric_arguments_coerce_but_never_silently_mislead() {
        assert_eq!(arg_count(&json!({}), "offset", 1).unwrap(), 1);
        assert_eq!(arg_count(&json!({"offset": 42}), "offset", 1).unwrap(), 42);
        assert_eq!(
            arg_count(&json!({"offset": "42"}), "offset", 1).unwrap(),
            42
        );
        assert_eq!(arg_count(&json!({"offset": null}), "offset", 7).unwrap(), 7);
        // "2abc" must never be read as 2, and 1.5 must never be floored to 1:
        // a silently wrong window is worse than an error.
        assert!(arg_count(&json!({"offset": "2abc"}), "offset", 1).is_err());
        assert!(arg_count(&json!({"offset": 1.5}), "offset", 1).is_err());
        assert!(arg_count(&json!({"offset": -3}), "offset", 1).is_err());
    }

    /// Page through `path` by following only the offsets the tool itself
    /// hands back, exactly as a model would, and return every line seen.
    fn page_through(path: &Path, limit: usize) -> Vec<String> {
        let mut seen: Vec<String> = Vec::new();
        let mut offset = 1usize;
        for _ in 0..10_000 {
            let result = read_window(path, "f.txt", offset, limit).unwrap();
            let start = result["startLine"].as_u64().unwrap() as usize;
            let end = result["endLine"].as_u64().unwrap() as usize;
            if end < start {
                break; // past the end
            }
            assert_eq!(start, offset, "window did not start where asked");
            let content = result["content"].as_str().unwrap();
            let lines: Vec<&str> = content.split('\n').collect();
            assert_eq!(
                lines.len(),
                end - start + 1,
                "endLine disagrees with the lines returned"
            );
            seen.extend(lines.iter().map(|line| line.to_string()));

            let Some(notice) = result["notice"].as_str() else {
                break;
            };
            let Some(marker) = notice.find("offset=") else {
                break;
            };
            let resume: usize = notice[marker + 7..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .unwrap();
            // The one invariant that makes paging safe: resume at the first
            // line NOT shown. Off by one either way silently duplicates or
            // drops content.
            assert_eq!(
                resume,
                end + 1,
                "resume offset must follow the last line shown"
            );
            offset = resume;
        }
        seen
    }

    #[test]
    fn paging_by_the_tools_own_offsets_reconstructs_the_file_exactly() {
        // The strongest check available: whatever the ceilings do, following
        // the offsets the tool computed must reproduce every line of the file
        // in order, with no gap and no duplicate.
        let dir = tempfile::tempdir().unwrap();
        let shapes: Vec<(&str, String)> = vec![
            ("plain", (1..=250).map(|n| format!("line {n}\n")).collect()),
            (
                "no trailing newline",
                (1..=250).map(|n| format!("line {n}\n")).collect::<String>() + "last",
            ),
            (
                "empty lines",
                (1..=250)
                    .map(|n| {
                        if n % 3 == 0 {
                            "\n".into()
                        } else {
                            format!("l{n}\n")
                        }
                    })
                    .collect(),
            ),
            ("crlf", (1..=250).map(|n| format!("line {n}\r\n")).collect()),
            (
                "multibyte",
                (1..=250).map(|n| format!("行 {n} ← line\n")).collect(),
            ),
            (
                "wide lines",
                (1..=250)
                    .map(|n| format!("{}{n}\n", "w".repeat(700)))
                    .collect(),
            ),
            (
                "one huge line",
                format!("{}\n{}", "m".repeat(300_000), "after\n"),
            ),
            ("single line", "only\n".into()),
            ("single line no newline", "only".into()),
        ];

        for (name, body) in shapes {
            let path = write(dir.path(), "f.txt", &body);
            // Expected lines, with CRLF normalised the way the reader does.
            let mut expected: Vec<&str> = body.split('\n').collect();
            if body.ends_with('\n') {
                expected.pop(); // trailing newline does not start a new line
            }
            let expected: Vec<String> = expected
                .iter()
                .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
                .collect();

            for limit in [1, 2, 7, 60, 250, 5_000] {
                let seen = page_through(&path, limit);
                assert_eq!(
                    seen.len(),
                    expected.len(),
                    "{name} at limit {limit}: saw {} lines, file has {}",
                    seen.len(),
                    expected.len()
                );
                for (index, (got, want)) in seen.iter().zip(&expected).enumerate() {
                    if let Some(head) = got
                        .split(" …[line clamped")
                        .next()
                        .filter(|_| got.contains("[line clamped"))
                    {
                        assert!(
                            want.starts_with(head),
                            "{name} line {index}: clamped text is not a prefix of the real line"
                        );
                    } else {
                        assert_eq!(got, want, "{name} at limit {limit}, line {index}");
                    }
                }
            }
        }
    }

    #[test]
    fn total_lines_is_only_reported_when_it_is_the_truth() {
        // A wrong total is a lie the model acts on, so it must appear only
        // where the read actually reached the end of the file.
        let dir = tempfile::tempdir().unwrap();
        let body: String = (1..=500).map(|n| format!("line {n}\n")).collect();
        let path = write(dir.path(), "f.txt", &body);

        for (offset, limit) in [(1, 500), (1, 5_000), (200, 5_000), (500, 1), (501, 10)] {
            let result = read(&path, offset, limit);
            if let Some(total) = result["totalLines"].as_u64() {
                assert_eq!(total, 500, "offset {offset} limit {limit} reported {total}");
            }
        }
        // Stopping short must not claim a total at all.
        assert!(read(&path, 1, 100)["totalLines"].is_null());
        assert!(read(&path, 1, 499)["totalLines"].is_null());
    }

    #[test]
    fn an_absurd_limit_is_clamped_rather_than_honoured() {
        let dir = tempfile::tempdir().unwrap();
        let body: String = (1..=20).map(|n| format!("l{n}\n")).collect();
        let path = write(dir.path(), "f.txt", &body);
        let result = read(&path, 1, 10_000_000);
        assert_eq!(result["totalLines"], 20);
        // offset 0 means line 1, not a panic.
        assert_eq!(read(&path, 0, 5)["startLine"], 1);

        // An offset at the top of the range must not overflow the arithmetic
        // in `describe`; debug builds panic on overflow rather than wrap.
        let extreme = read(&path, usize::MAX, 10);
        assert_eq!(extreme["content"], "");
        assert_eq!(extreme["totalLines"], 20);
        assert_eq!(
            arg_count(&json!({ "o": "18446744073709551615" }), "o", 1).unwrap(),
            usize::MAX
        );
    }
}
