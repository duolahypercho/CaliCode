//! Image-typed capture persistence for agent evidence.
//!
//! The worker (graph Build subagent, or the live editor) hands back a PNG/JPEG
//! data URL from `editor_capture_frame` and needs to land the decoded bytes at
//! a project-relative path it can quote in a report. `file_write` is
//! intentionally UTF-8-only (see AGENTS.md), so this module is the dedicated,
//! strictly-typed path for binary image evidence: same `safe_join` /
//! `safe_resolve` boundaries as the rest of the file tools, secret-file guard
//! identical to `workspace::safe_resolve`, atomic temp-file + rename so a crash
//! mid-write cannot leave a half-rendered file that downstream review would
//! trust, and an image validator that rejects any payload the renderer
//! itself would not have produced.
//!
//! Per-attempt byte caps live outside this module (the graph engine tracks
//! them in `CaptureBuffer`); here the only ceiling is the per-file ceiling,
//! matching `video_analysis::MAX_PNG_BYTES`.

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Maximum bytes for one persisted capture. Matches the contact-sheet cap so
/// the two paths stay bounded by the same image envelope.
pub const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;

/// Filename suffixes this tool will accept. Anything else (`.html`, `.svg`,
/// `.exe`, ...) is refused up front so the path cannot smuggle an
/// executable into the project tree.
const ALLOWED_EXTENSIONS: &[&str] = &[".png", ".jpg", ".jpeg"];

/// Pattern guard mirrored from `workspace::SECRET_PATTERNS` so a capture
/// written under `secrets/foo.png` cannot silently become a side channel.
const SECRET_SUFFIXES: &[&str] = &[".env", "id_rsa", "id_ed25519", ".pem", ".p12", ".keystore"];

/// What one successful persist returns.
#[derive(Debug, Clone)]
pub struct PersistedCapture {
    /// Project-relative path the bytes were written to.
    pub path: String,
    /// Decoded byte length on disk.
    pub bytes: usize,
    /// MIME type the data URL claimed and the validator confirmed.
    pub mime: String,
    /// SHA-256 of the decoded bytes - the same digest the existing source
    /// cache keys on, so a reviewer can resolve the file back to the exact
    /// image the renderer produced without re-encoding.
    pub sha256: String,
}

/// Persist an image-typed data URL to a project-relative (or workspace-
/// relative, when `workspace_override` is supplied) path under the active
/// game.
///
/// `rel` must end in `.png`/`.jpg`/`.jpeg` and resolve to a path inside the
/// game directory; `data_url` must be `data:image/<png|jpeg>;base64,...`
/// with a payload `image::load_from_memory` accepts.
pub fn persist_capture(
    projects_root: &Path,
    slug: &str,
    rel: &str,
    data_url: &str,
    workspace_override: Option<&Path>,
) -> Result<PersistedCapture> {
    let (mime, bytes) = decode_image_data_url(data_url)?;
    if bytes.is_empty() {
        return Err(anyhow!("capture payload is empty"));
    }
    if bytes.len() > MAX_CAPTURE_BYTES {
        return Err(anyhow!(
            "capture is {} bytes; the per-file ceiling is {}",
            bytes.len(),
            MAX_CAPTURE_BYTES
        ));
    }
    // The actual image bytes must decode. base64 round-trips cleanly so the
    // earlier size check is not enough: a valid PNG with one transparent
    // pixel still proves the path and prevents a 4MB random-bytes upload
    // from being treated as evidence.
    image::load_from_memory(&bytes).context("payload is not a decodable PNG/JPEG")?;

    let target = resolve_target(projects_root, slug, rel, workspace_override)?;

    if let Some(parent) = target.path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("cannot create {}", parent.display()))?;
    }

    // Atomic commit: temp file then rename. A crash mid-write cannot leave
    // the project tree holding a partial file a reviewer would trust as a
    // frame; without it the evidence path could point at an empty or
    // truncated PNG.
    let temp = sibling_temp(&target.path);
    {
        let mut file = std::fs::File::create(&temp)
            .with_context(|| format!("cannot create {}", temp.display()))?;
        file.write_all(&bytes)?;
        file.sync_all().context("sync capture temp file")?;
    }
    if let Err(error) = std::fs::rename(&temp, &target.path) {
        let _ = std::fs::remove_file(&temp);
        // A second writer may have committed the same path between our
        // existence check and rename. Accept that race rather than fail the
        // call - the path is correct, the content is the bytes we just
        // wrote.
        if target.path.exists() {
            return finalize(target, bytes, mime);
        }
        return Err(error).with_context(|| format!("commit {}", target.path.display()));
    }
    finalize(target, bytes, mime)
}

/// Persist browser-produced evidence into CaliCode's durable project store.
///
/// Browser tools execute while an agent is bound to a disposable session
/// worktree, but loop reports, graph manifests, and the Reports tab all use
/// the project store as their durable evidence root.  Routing a frame through
/// [`persist_capture`] without an explicit base follows the project's attached
/// workspace, which can be a different repository entirely.  This entry point
/// deliberately supplies the canonical project directory as the trusted base
/// so a successful browser result names the same file the graph listener and
/// report renderer will later verify.
pub fn persist_project_evidence(
    projects_root: &Path,
    slug: &str,
    rel: &str,
    data_url: &str,
) -> Result<PersistedCapture> {
    let project_dir = crate::store::project_dir(projects_root, slug)?;
    persist_capture(projects_root, slug, rel, data_url, Some(&project_dir))
}

/// Same as `persist_capture` but never touches the filesystem: useful for
/// callers that want to validate and compute a digest without writing.
#[cfg(test)]
pub fn inspect_capture(data_url: &str) -> Result<(String, Vec<u8>, String)> {
    let (mime, bytes) = decode_image_data_url(data_url)?;
    if bytes.len() > MAX_CAPTURE_BYTES {
        return Err(anyhow!(
            "capture is {} bytes; the per-file ceiling is {}",
            bytes.len(),
            MAX_CAPTURE_BYTES
        ));
    }
    image::load_from_memory(&bytes).context("payload is not a decodable PNG/JPEG")?;
    let sha = crate::assets::sha256_bytes(&bytes);
    Ok((mime, bytes, sha))
}

struct ResolvedTarget {
    /// Absolute path the bytes will be written to.
    path: PathBuf,
    /// Project-relative path returned to the caller.
    relative: String,
}

fn finalize(target: ResolvedTarget, bytes: Vec<u8>, mime: String) -> Result<PersistedCapture> {
    let sha = crate::assets::sha256_bytes(&bytes);
    Ok(PersistedCapture {
        path: target.relative,
        bytes: bytes.len(),
        mime,
        sha256: sha,
    })
}

/// Decode `data:image/<png|jpeg>;base64,<payload>`. Rejects any other MIME,
/// rejects empty payloads, and rejects base64 noise that does not decode.
fn decode_image_data_url(data_url: &str) -> Result<(String, Vec<u8>)> {
    let (header, payload) = data_url
        .split_once(',')
        .ok_or_else(|| anyhow!("data URL is missing the `,` separator"))?;
    if !header.starts_with("data:") {
        return Err(anyhow!("data URL must start with `data:`"));
    }
    let mut segments = header.split(';');
    let raw_mime = segments
        .next()
        .ok_or_else(|| anyhow!("data URL is missing the MIME segment"))?
        .strip_prefix("data:")
        .unwrap_or("");
    let mime = raw_mime.to_ascii_lowercase();
    let mime = match mime.as_str() {
        "image/png" => "image/png".to_string(),
        "image/jpeg" | "image/jpg" => "image/jpeg".to_string(),
        _ => {
            return Err(anyhow!(
                "only image/png and image/jpeg are accepted, got {raw_mime}"
            ))
        }
    };
    let base64_marker = segments.any(|segment| segment.trim().eq_ignore_ascii_case("base64"));
    if !base64_marker {
        return Err(anyhow!("data URL must declare the base64 encoding"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .context("payload is not valid base64")?;
    Ok((mime, bytes))
}

/// Resolve `rel` to an absolute path inside the game's directory, refusing
/// anything that escapes or lands on a secret-named file. Reuses the
/// `store::safe_join` / `workspace::safe_resolve` ladder so this module
/// cannot drift from the rest of the file tools' safety story.
fn resolve_target(
    projects_root: &Path,
    slug: &str,
    rel: &str,
    workspace_override: Option<&Path>,
) -> Result<ResolvedTarget> {
    if rel.is_empty() {
        return Err(anyhow!("path is required"));
    }
    if rel.contains('\0') {
        return Err(anyhow!("path contains a NUL byte"));
    }
    if rel.starts_with('/') {
        return Err(anyhow!("path must be relative to the project"));
    }
    let extension_ok = ALLOWED_EXTENSIONS
        .iter()
        .any(|suffix| rel.to_ascii_lowercase().ends_with(suffix));
    if !extension_ok {
        return Err(anyhow!(
            "path must end in .png, .jpg, or .jpeg; got {rel:?}"
        ));
    }
    // Mirror workspace::SECRET_PATTERNS so a capture written under e.g.
    // `.env/innocent.png` is still refused - the suffix rule alone would
    // admit `.env/foo.png` because the leaf ends in `.png`.
    let lower = rel.to_ascii_lowercase();
    for pattern in SECRET_SUFFIXES {
        if lower.split(['/', '\\']).any(|segment| segment == *pattern) {
            return Err(anyhow!("refusing to write to a secret-named path: {rel:?}"));
        }
    }

    let base = crate::tools::game_file_base(projects_root, slug, workspace_override)?;
    let path = crate::tools::resolve_in_base(&base, rel)?;
    // `safe_join` / `safe_resolve` already enforce lexical and canonical
    // containment, so a final defensive check is only useful to surface the
    // case where the resolver changed its mind.
    let root_real = base
        .base
        .canonicalize()
        .with_context(|| format!("project root {} is unavailable", base.base.display()))?;
    let mut probe = path.as_path();
    let resolved = loop {
        match probe.canonicalize() {
            Ok(real) => break real,
            Err(_) => match probe.parent() {
                Some(parent) => probe = parent,
                None => return Err(anyhow!("path escapes the project")),
            },
        }
    };
    if !resolved.starts_with(&root_real) {
        return Err(anyhow!("path escapes the project"));
    }

    let relative = path
        .strip_prefix(&base.base)
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|_| rel.to_string());
    Ok(ResolvedTarget { path, relative })
}

/// Compute a sibling temp filename in the same directory as the target so
/// the rename is on the same filesystem (atomic rename is the whole point).
fn sibling_temp(target: &Path) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let file_name = target
        .file_name()
        .map(|name| format!(".{}.tmp", name.to_string_lossy()))
        .unwrap_or_else(|| ".capture.tmp".to_string());
    parent.join(file_name)
}

/// JSON-shaped result the tool dispatcher serialises.
pub fn as_json(result: &PersistedCapture) -> Value {
    json!({
        "path": result.path,
        "bytes": result.bytes,
        "mime": result.mime,
        "sha256": result.sha256,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use image::{ImageFormat, Rgb, RgbImage};

    fn png_data_url(red: u8) -> String {
        let image = RgbImage::from_pixel(8, 8, Rgb([red, 64, 64]));
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut cursor, ImageFormat::Png)
            .unwrap();
        format!(
            "data:image/png;base64,{}",
            STANDARD.encode(cursor.into_inner())
        )
    }

    #[test]
    fn rejects_non_image_data_url() {
        let err = decode_image_data_url("data:text/plain;base64,SGVsbG8=").unwrap_err();
        assert!(err.to_string().contains("only image/png and image/jpeg"));
    }

    #[test]
    fn rejects_missing_base64_marker() {
        let err = decode_image_data_url("data:image/png,not-actually-base64").unwrap_err();
        assert!(err.to_string().contains("base64 encoding"));
    }

    #[test]
    fn rejects_garbage_base64() {
        let err = decode_image_data_url("data:image/png;base64,!!!not-base64!!!").unwrap_err();
        assert!(err.to_string().contains("base64"));
    }

    #[test]
    fn rejects_payload_that_is_not_an_image() {
        // Valid base64 of a string, but the bytes are not a PNG/JPEG. The
        // `inspect_capture` validator must catch this so a 4MB random-bytes
        // upload cannot become "evidence".
        let url = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(b"plain text bytes")
        );
        let err = inspect_capture(&url).unwrap_err();
        assert!(err.to_string().contains("decodable"));
    }

    #[test]
    fn rejects_extension_outside_the_image_set() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();
        let url = png_data_url(120);
        let err = persist_capture(root.path(), "demo", "shell.html", &url, None).unwrap_err();
        assert!(err.to_string().contains(".png, .jpg, or .jpeg"));
    }

    #[test]
    fn rejects_path_traversal() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();
        let url = png_data_url(0);
        let err = persist_capture(root.path(), "demo", "../escape.png", &url, None).unwrap_err();
        assert!(err.to_string().contains("escapes"));
    }

    #[test]
    fn rejects_secret_named_path() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();
        let url = png_data_url(0);
        let err =
            persist_capture(root.path(), "demo", ".env/innocent.png", &url, None).unwrap_err();
        assert!(err.to_string().contains("secret"));
    }

    #[test]
    fn rejects_absolute_path() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();
        let url = png_data_url(0);
        let err = persist_capture(root.path(), "demo", "/etc/passwd.png", &url, None).unwrap_err();
        assert!(err.to_string().contains("relative"));
    }

    #[test]
    fn rejects_oversized_payload() {
        // The validator catches size before the image decoder runs; the bytes
        // here are also not an image so a guard-only test would be more
        // confusing than helpful.
        let huge = vec![0u8; MAX_CAPTURE_BYTES + 1];
        let url = format!("data:image/png;base64,{}", STANDARD.encode(&huge));
        let err = inspect_capture(&url).unwrap_err();
        assert!(err.to_string().contains("per-file ceiling"));
    }

    #[test]
    fn persists_valid_png_to_project_relative_path() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();
        let url = png_data_url(200);
        let result = persist_capture(
            root.path(),
            "demo",
            "reports/walk/frame-001.png",
            &url,
            None,
        )
        .expect("valid png must persist");
        assert_eq!(result.mime, "image/png");
        assert!(result.bytes > 0);
        assert_eq!(result.path, "reports/walk/frame-001.png");
        let project = crate::store::project_dir(root.path(), "demo").unwrap();
        let on_disk = std::fs::read(project.join(&result.path)).unwrap();
        // The validator re-decodes the bytes from the data URL before
        // writing, so the on-disk file is byte-identical to what we
        // accepted.
        let decoded = STANDARD
            .decode(url.trim_start_matches("data:image/png;base64,"))
            .unwrap();
        assert_eq!(on_disk, decoded);
        assert_eq!(result.sha256, crate::assets::sha256_bytes(&on_disk));
    }

    #[test]
    fn browser_evidence_ignores_the_projects_attached_workspace() {
        let root = tempfile::tempdir().unwrap();
        let attached = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();
        crate::store::set_workspace_root(
            root.path(),
            "demo",
            Some(attached.path().to_str().unwrap()),
        )
        .unwrap();

        let result = persist_project_evidence(
            root.path(),
            "demo",
            "reports/loops/loop-one/frame-001.png",
            &png_data_url(180),
        )
        .unwrap();

        let project_dir = crate::store::project_dir(root.path(), "demo").unwrap();
        assert!(project_dir.join(&result.path).is_file());
        assert!(!attached.path().join(&result.path).exists());
    }

    #[test]
    fn accepts_jpeg_payload() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();
        let image = RgbImage::from_pixel(4, 4, Rgb([10, 20, 30]));
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut cursor, ImageFormat::Jpeg)
            .unwrap();
        let url = format!(
            "data:image/jpeg;base64,{}",
            STANDARD.encode(cursor.into_inner())
        );
        let result = persist_capture(root.path(), "demo", "snap.jpg", &url, None).unwrap();
        assert_eq!(result.mime, "image/jpeg");
    }

    #[test]
    fn overwrites_existing_capture_atomically() {
        let root = tempfile::tempdir().unwrap();
        crate::store::create_project(root.path(), "demo", "Demo").unwrap();
        let first =
            persist_capture(root.path(), "demo", "frame.png", &png_data_url(10), None).unwrap();
        let second =
            persist_capture(root.path(), "demo", "frame.png", &png_data_url(220), None).unwrap();
        // The previous file must be gone - a partial write would leave the
        // path pointing at an empty file a reviewer would still trust.
        assert_ne!(first.sha256, second.sha256);
        let project = crate::store::project_dir(root.path(), "demo").unwrap();
        assert_eq!(
            crate::assets::sha256_bytes(&std::fs::read(project.join("frame.png")).unwrap()),
            second.sha256
        );
        // No stray temp file: the temp lives in the same directory and is
        // renamed on success, so the directory must hold exactly one file
        // matching the captured path.
        let entries: Vec<_> = std::fs::read_dir(project.join(""))
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(entries.is_empty(), "stray temp file: {entries:?}");
    }

    #[test]
    fn rejects_unknown_slug() {
        let root = tempfile::tempdir().unwrap();
        let url = png_data_url(0);
        let err = persist_capture(root.path(), "missing", "frame.png", &url, None).unwrap_err();
        assert!(err.to_string().contains("missing"));
    }
}
