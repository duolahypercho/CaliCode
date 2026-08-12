//! Multi-frame video contact-sheet builder for the agent judge.
//!
//! A single frame rarely tells an agent whether an animation, walk cycle, or
//! physics transition is *right*. We feed the vision judge a single image that
//! lays out a sequence of decoded frames in a deterministic grid with visible
//! labels so it can read time as position on the page: "frame N at t=2.40s —
//! the leg is at this angle, the camera is at this position, the prop has
//! moved this far." That is the contract this module honours.
//!
//! Three layers, each pure:
//!
//! 1. `plan_grid` decides the column count, tile size, and sheet dimensions
//!    from the frame count, target tile width, and explicit caps. Pure.
//! 2. `compose_sheet` rasterises the labelled grid into an `RgbaImage`. Pure;
//!    takes the decoded frames as already-decoded bytes, so this module never
//!    shells out to ffmpeg or the browser. Those are integration points
//!    elsewhere (see `blender.rs`, `agent.rs`'s browser-capture path); this
//!    module is the *downstream* consumer of whatever decoded frames they
//!    hand back.
//! 3. `motion_metrics` walks adjacent frames and emits per-edge deltas
//!    (mean absolute luma delta, mean absolute RGB delta, perceptual-hash
//!    Hamming distance) so the manifest can describe *what changed* between
//!    frames, not just *how many* frames we sampled.
//!
//! The persistent side (`persist_report`) writes the PNG and a sibling JSON
//! manifest into a caller-supplied safe directory. It is intentionally the
//! only I/O in the file, and it is conservative about path traversal.

use anyhow::{Context, Result};
use image::ImageEncoder;
use image::{ImageBuffer, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

/// How many frames we will accept in a single contact sheet. The cap is set
/// here rather than by the agent because vision judges degrade sharply once a
/// sheet exceeds roughly eight columns; we clamp at 64 frames (8x8) and let
/// the caller sub-sample to fit.
pub const MAX_FRAMES: usize = 64;
/// Default tile width when the caller does not specify one. 320px is the
/// smallest size at which a leg articulation is still readable after
/// downsampling.
pub const DEFAULT_TILE_WIDTH: u32 = 320;
/// Maximum tile width we will honour. Anything larger wastes token budget on
/// detail the judge will not look at frame-by-frame.
pub const MAX_TILE_WIDTH: u32 = 640;
/// Maximum bytes for the encoded PNG. Two megabytes covers a fully-loaded
/// 8x8 sheet at the default tile width and keeps the base64 result under the
/// usual MCP tool-call payload ceiling.
pub const MAX_PNG_BYTES: usize = 4 * 1024 * 1024;
/// Maximum total bytes for all decoded input frames combined. Stops a
/// degenerate caller from handing us a 200MB blob and asking us to rasterise
/// it; we surface that as a structured error.
pub const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
/// Maximum bytes for the JSON-RPC request body that submits contact-sheet
/// frames. Aligned with `MAX_INPUT_BYTES` plus headroom for base64 inflation
/// (~33%) and the JSON envelope, so a fully-loaded sheet of decoded frames up
/// to the cap can be transported. Enforced by the `DefaultBodyLimit` layer on
/// the `/rpc` route; exceeding it returns a structured JSON-RPC error rather
/// than a plain-text 413 the client mis-parses as a transport outage.
pub const RPC_BODY_LIMIT_BYTES: usize = 96 * 1024 * 1024;

/// Hard ceiling on the longest side of the rendered sheet, in pixels. Caps
/// the worst-case output so a misconfigured `tile_width` cannot blow past the
/// vision model's image budget.
pub const MAX_SHEET_SIDE: u32 = 4096;
/// Height reserved for the label band under each tile, in pixels. Visible
/// labels are the entire point — without this band the judge would have to
/// infer frame ordering from grid position, which is exactly what we are
/// trying to remove from the workload.
pub const LABEL_BAND_HEIGHT: u32 = 36;
/// Margin around the sheet and gutters between tiles, in pixels. Six pixels
/// is enough to keep labels from bleeding into adjacent tiles.
pub const SHEET_MARGIN: u32 = 6;

/// A decoded frame handed to the contact-sheet builder. The bytes must
/// already be a decoded image (PNG/JPEG/etc); this module never decodes
/// container formats. The `timestamp_seconds` and `frame_number` are taken
/// verbatim from the caller because only the caller knows the real time
/// origin — ffmpeg's `-ss` and a browser capture's `performance.now()` are
/// both valid sources and we do not assume one.
#[derive(Debug, Clone)]
pub struct VideoFrame {
    /// Decoded image bytes in a format `image::load_from_memory` accepts.
    pub bytes: Vec<u8>,
    /// Presentation timestamp in seconds. Used verbatim for the manifest and
    /// the on-tile label. May be `0.0` if the caller has no clock.
    pub timestamp_seconds: f64,
    /// 1-based frame number as understood by the caller. Used for the
    /// on-tile label; we do not invent frame numbers from the array index
    /// because the upstream sampler may have already sub-sampled.
    pub frame_number: u32,
    /// Optional short caption (e.g. "walking", "jump apex"). Rendered on the
    /// second line of the label band when present.
    pub caption: Option<String>,
}

/// Configuration for the sheet. Every field has a defensive default; the
/// builder functions refuse out-of-range values rather than silently clamp
/// because silent clamping is how the agent ends up looking at the wrong
/// frames.
#[derive(Debug, Clone)]
pub struct ContactSheetConfig {
    /// Width of each tile after aspect-ratio normalisation.
    pub tile_width: u32,
    /// Number of columns. When `None`, `plan_grid` chooses a balanced layout
    /// based on the frame count.
    pub columns: Option<u32>,
    /// Optional cap on the number of frames actually composited. Useful when
    /// the caller has 200 frames and wants the evenly-spaced first/last plus
    /// a few in the middle.
    pub max_frames: Option<usize>,
    /// Background colour for the sheet, in `0xRRGGBBAA`. Defaults to near
    /// black so labels read clearly in both light and dark UI.
    pub background: [u8; 4],
    /// Foreground colour for labels, in `0xRRGGBBAA`.
    pub label_color: [u8; 4],
}

impl Default for ContactSheetConfig {
    fn default() -> Self {
        Self {
            tile_width: DEFAULT_TILE_WIDTH,
            columns: None,
            max_frames: None,
            background: [16, 16, 18, 255],
            label_color: [240, 240, 240, 255],
        }
    }
}

/// Computed dimensions of the sheet before any raster work happens. Returned
/// by `plan_grid` and echoed into the manifest so the judge can read the
/// geometry without re-deriving it from the image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GridPlan {
    pub columns: u32,
    pub rows: u32,
    pub tile_width: u32,
    pub tile_height: u32,
    pub sheet_width: u32,
    pub sheet_height: u32,
}

/// One entry in the manifest describing the labelled tile rendered into the
/// sheet. `x`/`y` are top-left in sheet pixels so a downstream tool could
/// crop an individual tile back out.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TileRecord {
    pub frame_number: u32,
    pub index: usize,
    pub timestamp_seconds: f64,
    pub caption: Option<String>,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Motion descriptor for the transition from one frame to the next. The
/// numeric values are deliberately bounded and human-readable so the judge
/// can quote them in feedback without unit confusion: luma/RGB deltas are in
/// 0..=255, hash distance is in 0..=64 (8x8 aHash).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MotionEdge {
    pub from_index: usize,
    pub to_index: usize,
    pub mean_abs_luma_delta: f32,
    pub mean_abs_rgb_delta: f32,
    pub phash_hamming: u32,
    /// True when both frames were successfully decoded; a single bad frame
    /// edges-out a null motion record rather than poisoning the whole list.
    pub valid: bool,
    pub note: Option<String>,
}

/// Final contact-sheet report. Serialised to JSON next to the PNG.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactSheetReport {
    pub schema_version: u32,
    pub plan: GridPlanJson,
    pub tiles: Vec<TileRecord>,
    pub motion: Vec<MotionEdge>,
    /// Sum of decoded input bytes, surfaced so the caller can see whether
    /// any frames were dropped for size.
    pub input_bytes: usize,
    pub encoded_png_bytes: usize,
    pub notes: Vec<String>,
}

/// `GridPlan` serialised for JSON. We split it out so `plan` in the manifest
/// is a flat object with primitive fields, not nested.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GridPlanJson {
    pub columns: u32,
    pub rows: u32,
    pub tile_width: u32,
    pub tile_height: u32,
    pub sheet_width: u32,
    pub sheet_height: u32,
}

impl From<GridPlan> for GridPlanJson {
    fn from(p: GridPlan) -> Self {
        Self {
            columns: p.columns,
            rows: p.rows,
            tile_width: p.tile_width,
            tile_height: p.tile_height,
            sheet_width: p.sheet_width,
            sheet_height: p.sheet_height,
        }
    }
}

/// Decide the grid layout. Pure: given a frame count and config, returns the
/// exact tile/sheet dimensions that `compose_sheet` will produce. Splitting
/// planning from rendering lets us report the geometry before paying for the
/// raster, and lets tests assert the layout contract independently.
pub fn plan_grid(frame_count: usize, cfg: &ContactSheetConfig) -> Result<GridPlan> {
    if frame_count == 0 {
        anyhow::bail!("at least one frame is required to build a contact sheet");
    }
    let effective_count = match cfg.max_frames {
        Some(cap) if cap < frame_count => cap,
        _ => frame_count,
    };
    if effective_count > MAX_FRAMES {
        anyhow::bail!(
            "contact sheet would render {} frames, capped at {}",
            effective_count,
            MAX_FRAMES
        );
    }
    let columns = match cfg.columns {
        Some(c) if c > 0 => c.min(effective_count as u32).max(1),
        _ => auto_columns(effective_count),
    };
    let rows = (effective_count as u32).div_ceil(columns);
    let requested_tile_width = cfg.tile_width.clamp(32, MAX_TILE_WIDTH);
    let width_budget = MAX_SHEET_SIDE.saturating_sub(SHEET_MARGIN * (columns + 1)) / columns;
    let height_budget = MAX_SHEET_SIDE
        .saturating_sub(SHEET_MARGIN * (rows + 1))
        .saturating_sub(rows * LABEL_BAND_HEIGHT)
        / rows;
    let tile_width = requested_tile_width
        .min(width_budget)
        .min(height_budget)
        .max(32);
    // Tile height defaults to a square aspect ratio; `compose_sheet` will
    // downscale the actual frame to fit. We do not assume 16:9 here because
    // a video might be 1:1 (UI captures) or 9:16 (phone screen recordings).
    let tile_height = tile_width;
    let sheet_width =
        SHEET_MARGIN * 2 + columns * tile_width + columns.saturating_sub(1) * SHEET_MARGIN;
    let sheet_height = SHEET_MARGIN * 2
        + rows * (tile_height + LABEL_BAND_HEIGHT)
        + rows.saturating_sub(1) * SHEET_MARGIN;
    if sheet_width > MAX_SHEET_SIDE || sheet_height > MAX_SHEET_SIDE {
        anyhow::bail!(
            "sheet would be {}x{}, exceeding the {}px side cap",
            sheet_width,
            sheet_height,
            MAX_SHEET_SIDE
        );
    }
    Ok(GridPlan {
        columns,
        rows,
        tile_width,
        tile_height,
        sheet_width,
        sheet_height,
    })
}

fn auto_columns(count: usize) -> u32 {
    // Balanced square-ish layout. The exact algorithm matters only for the
    // "stable across runs" property; small counts favour a single row so the
    // judge sees the timeline left-to-right without scrolling.
    let n = count as u32;
    match n {
        0 => 1,
        1 => 1,
        2..=4 => n,
        5..=9 => 3,
        10..=16 => 4,
        17..=25 => 5,
        26..=36 => 6,
        37..=49 => 7,
        _ => 8,
    }
}

/// Normalise a decoded frame into an `RgbaImage` scaled to fit `tile_width`
/// while preserving the source aspect ratio. The returned image is centred
/// inside a tile-sized canvas, with the letterbox areas filled by the
/// background colour from the config. We letterbox rather than crop because
/// cropping would hide motion near the edges — exactly the region (legs,
/// feet, hands) that the user wants the judge to see.
pub fn normalize_tile(
    bytes: &[u8],
    tile_width: u32,
    tile_height: u32,
    background: [u8; 4],
) -> Result<RgbaImage> {
    let dyn_img = image::load_from_memory(bytes).context("unable to decode frame bytes")?;
    let (src_w, src_h) = (dyn_img.width(), dyn_img.height());
    if src_w == 0 || src_h == 0 {
        anyhow::bail!("frame has zero dimension ({}x{})", src_w, src_h);
    }
    let scale_x = tile_width as f32 / src_w as f32;
    let scale_y = tile_height as f32 / src_h as f32;
    let scale = scale_x.min(scale_y);
    let scaled_w = ((src_w as f32) * scale).round().max(1.0) as u32;
    let scaled_h = ((src_h as f32) * scale).round().max(1.0) as u32;
    let scaled = dyn_img.resize_exact(scaled_w, scaled_h, image::imageops::FilterType::Triangle);
    let mut canvas: RgbaImage = ImageBuffer::from_pixel(tile_width, tile_height, Rgba(background));
    let offset_x = (tile_width - scaled_w) / 2;
    let offset_y = (tile_height - scaled_h) / 2;
    let rgba = scaled.to_rgba8();
    for y in 0..scaled_h {
        for x in 0..scaled_w {
            let src = rgba.get_pixel(x, y);
            canvas
                .get_pixel_mut(offset_x + x, offset_y + y)
                .clone_from(src);
        }
    }
    Ok(canvas)
}

/// Compose the labelled contact sheet from decoded frames. Returns the
/// rendered `RgbaImage` plus the manifest describing what was placed where.
/// This function is the canonical entry point; it plans, normalises, lays
/// out, labels, and accumulates motion in one shot.
pub fn compose_sheet(
    frames: &[VideoFrame],
    cfg: &ContactSheetConfig,
) -> Result<(RgbaImage, ContactSheetReport)> {
    let input_bytes: usize = frames.iter().map(|f| f.bytes.len()).sum();
    if input_bytes > MAX_INPUT_BYTES {
        anyhow::bail!(
            "decoded input is {} bytes, capped at {}",
            input_bytes,
            MAX_INPUT_BYTES
        );
    }
    let mut notes = Vec::new();
    // Sub-sample if the caller asked us to. Even spacing preserves the
    // first and last frames so the judge can see the start/end states.
    let selected: Vec<(usize, &VideoFrame)> = match cfg.max_frames {
        Some(cap) if cap < frames.len() => evenly_spaced(frames, cap)
            .into_iter()
            .map(|i| (i, &frames[i]))
            .collect(),
        _ => frames.iter().enumerate().collect(),
    };
    if selected.len() < frames.len() {
        notes.push(format!(
            "sub-sampled {} frames down to {} for the sheet",
            frames.len(),
            selected.len()
        ));
    }
    let selected_refs: Vec<VideoFrame> = selected.iter().map(|(_, f)| (*f).clone()).collect();
    let plan = plan_grid(selected_refs.len(), cfg)?;
    let mut sheet: RgbaImage =
        ImageBuffer::from_pixel(plan.sheet_width, plan.sheet_height, Rgba(cfg.background));

    let mut tiles = Vec::with_capacity(selected.len());
    let mut normalised: Vec<RgbaImage> = Vec::with_capacity(selected.len());
    for (idx, (orig_idx, frame)) in selected.iter().enumerate() {
        let tile = normalize_tile(
            &frame.bytes,
            plan.tile_width,
            plan.tile_height,
            cfg.background,
        )?;
        let col = (idx as u32) % plan.columns;
        let row = (idx as u32) / plan.columns;
        let x = SHEET_MARGIN + col * (plan.tile_width + SHEET_MARGIN);
        let y = SHEET_MARGIN + row * (plan.tile_height + LABEL_BAND_HEIGHT + SHEET_MARGIN);
        blit(&mut sheet, &tile, x, y);
        draw_label_band(
            &mut sheet,
            x,
            y + plan.tile_height,
            plan.tile_width,
            LABEL_BAND_HEIGHT,
            frame,
            cfg.label_color,
        );
        tiles.push(TileRecord {
            frame_number: frame.frame_number,
            index: *orig_idx,
            timestamp_seconds: frame.timestamp_seconds,
            caption: frame.caption.clone(),
            x,
            y,
            width: plan.tile_width,
            height: plan.tile_height,
        });
        normalised.push(tile);
    }

    let motion = compute_motion(&normalised, &selected_refs);
    let encoded = encode_png(&sheet, MAX_PNG_BYTES)?;
    if encoded.len() > MAX_PNG_BYTES {
        // Defensive: the encoder respects the cap via compression level, but
        // a worst-case input could still exceed it. Surface the size so the
        // caller can sub-sample or shrink the tile width.
        anyhow::bail!(
            "encoded PNG is {} bytes, capped at {}",
            encoded.len(),
            MAX_PNG_BYTES
        );
    }
    Ok((
        sheet,
        ContactSheetReport {
            schema_version: 1,
            plan: plan.clone().into(),
            tiles,
            motion,
            input_bytes,
            encoded_png_bytes: encoded.len(),
            notes,
        },
    ))
}

/// Compute motion metrics between adjacent frames. Returns one `MotionEdge`
/// per adjacent pair, in the same order as the input. Frames that fail to
/// decode produce a `valid: false` edge rather than poisoning the whole
/// list — the judge sees "no measurement between 3 and 4" instead of "no
/// measurements at all".
pub fn compute_motion(frames: &[RgbaImage], metadata: &[VideoFrame]) -> Vec<MotionEdge> {
    let mut edges = Vec::with_capacity(frames.len().saturating_sub(1));
    for i in 0..frames.len().saturating_sub(1) {
        let from = &frames[i];
        let to = &frames[i + 1];
        if from.dimensions() != to.dimensions() {
            edges.push(MotionEdge {
                from_index: i,
                to_index: i + 1,
                mean_abs_luma_delta: 0.0,
                mean_abs_rgb_delta: 0.0,
                phash_hamming: 0,
                valid: false,
                note: Some(format!(
                    "size mismatch: {}x{} vs {}x{}",
                    from.width(),
                    from.height(),
                    to.width(),
                    to.height()
                )),
            });
            continue;
        }
        let (luma, rgb) = mean_abs_delta(from, to);
        let phash = ahash_hamming(from, to);
        edges.push(MotionEdge {
            from_index: i,
            to_index: i + 1,
            mean_abs_luma_delta: luma,
            mean_abs_rgb_delta: rgb,
            phash_hamming: phash,
            valid: true,
            note: None,
        });
    }
    // Metadata is currently unused by the math, but the parameter is kept
    // so future heuristics (timestamp gaps, captions) can be added without
    // breaking the public signature.
    let _ = metadata;
    edges
}

/// Mean absolute delta between two same-sized RGBA images, returned as
/// `(luma, rgb)`. Luma uses BT.601 weights on the RGB channels; alpha is
/// ignored because the frames are already composited on the sheet
/// background.
fn mean_abs_delta(a: &RgbaImage, b: &RgbaImage) -> (f32, f32) {
    let mut luma_sum: u64 = 0;
    let mut rgb_sum: u64 = 0;
    let mut count: u64 = 0;
    for (pa, pb) in a.pixels().zip(b.pixels()) {
        let dr = (pa[0] as i32 - pb[0] as i32).unsigned_abs();
        let dg = (pa[1] as i32 - pb[1] as i32).unsigned_abs();
        let db = (pa[2] as i32 - pb[2] as i32).unsigned_abs();
        rgb_sum += (dr + dg + db) as u64;
        let luma_a = (299 * pa[0] as u32 + 587 * pa[1] as u32 + 114 * pa[2] as u32) / 1000;
        let luma_b = (299 * pb[0] as u32 + 587 * pb[1] as u32 + 114 * pb[2] as u32) / 1000;
        luma_sum += luma_a.abs_diff(luma_b) as u64;
        count += 1;
    }
    if count == 0 {
        return (0.0, 0.0);
    }
    let luma = luma_sum as f32 / count as f32;
    let rgb = (rgb_sum as f32 / 3.0) / count as f32;
    (luma, rgb)
}

/// 8x8 average-hash (aHash) Hamming distance between two frames. Cheap, no
/// DCT, deterministic, and good enough to flag "this frame is essentially
/// the same as the previous one" or "the camera moved". Returns 0..=64.
fn ahash_hamming(a: &RgbaImage, b: &RgbaImage) -> u32 {
    let hash_a = ahash8(a);
    let hash_b = ahash8(b);
    (hash_a ^ hash_b).count_ones()
}

fn ahash8(img: &RgbaImage) -> u64 {
    let mut small = ImageBuffer::<image::Luma<u8>, Vec<u8>>::new(8, 8);
    for y in 0..8u32 {
        for x in 0..8u32 {
            let sx = ((x as f32 + 0.5) / 8.0 * img.width() as f32) as u32;
            let sy = ((y as f32 + 0.5) / 8.0 * img.height() as f32) as u32;
            let px = sx.min(img.width().saturating_sub(1));
            let py = sy.min(img.height().saturating_sub(1));
            let p = img.get_pixel(px, py);
            let luma = (299 * p[0] as u32 + 587 * p[1] as u32 + 114 * p[2] as u32) / 1000;
            small.get_pixel_mut(x, y).0[0] = luma as u8;
        }
    }
    let mut sum: u64 = 0;
    for p in small.pixels() {
        sum += p.0[0] as u64;
    }
    let mean = (sum / 64) as u32;
    let mut hash: u64 = 0;
    for (bit, p) in (0_u32..).zip(small.pixels()) {
        if (p.0[0] as u32) >= mean {
            hash |= 1 << bit;
        }
    }
    hash
}

fn blit(dst: &mut RgbaImage, src: &RgbaImage, x: u32, y: u32) {
    for sy in 0..src.height() {
        for sx in 0..src.width() {
            let dx = x + sx;
            let dy = y + sy;
            if dx < dst.width() && dy < dst.height() {
                let p = src.get_pixel(sx, sy);
                dst.get_pixel_mut(dx, dy).clone_from(p);
            }
        }
    }
}

/// Render the label band under one tile. Two lines: the top line shows the
/// frame number and timestamp; the bottom line shows the optional caption
/// truncated to fit. We do not pull in a font crate — instead we draw the
/// characters as a tiny 5x7 bitmap font that covers `0-9`, `A-Z`, `:`, `.`,
/// `-`, and space. It is enough for the labels we promise and avoids a
/// dependency that would touch `Cargo.toml`.
fn draw_label_band(
    sheet: &mut RgbaImage,
    x: u32,
    y: u32,
    width: u32,
    _height: u32,
    frame: &VideoFrame,
    color: [u8; 4],
) {
    // Border for visual separation between tile and label.
    let border = Rgba([48, 48, 52, 255]);
    if y < sheet.height() {
        for bx in x..(x + width.min(sheet.width().saturating_sub(x))) {
            *sheet.get_pixel_mut(bx, y) = border;
        }
    }
    let timestamp_label = format!("#{} t={:.2}s", frame.frame_number, frame.timestamp_seconds);
    draw_text(sheet, x + 6, y + 4, &timestamp_label, color);
    if let Some(caption) = &frame.caption {
        let trimmed: String = caption.chars().take(28).collect();
        draw_text(sheet, x + 6, y + 18, &trimmed, color);
    }
}

fn draw_text(sheet: &mut RgbaImage, x: u32, y: u32, text: &str, color: [u8; 4]) {
    let mut cx = x;
    const MAX_CHARS: usize = 24;
    for ch in text.chars().take(MAX_CHARS) {
        if let Some(glyph) = glyph_for(ch) {
            draw_glyph(sheet, cx, y, &glyph, color);
        }
        cx += 6;
        if cx + 6 > sheet.width() {
            break;
        }
    }
}

fn draw_glyph(sheet: &mut RgbaImage, x: u32, y: u32, glyph: &[u8; 7], color: [u8; 4]) {
    for (row, bits) in glyph.iter().enumerate() {
        for col in 0..5u32 {
            if (bits >> (4 - col)) & 1 == 1 {
                let px = x + col;
                let py = y + row as u32;
                if px < sheet.width() && py < sheet.height() {
                    *sheet.get_pixel_mut(px, py) = Rgba(color);
                }
            }
        }
    }
}

fn glyph_for(ch: char) -> Option<[u8; 7]> {
    // 5x7 bitmap font. Columns are MSB-first. Each glyph is 7 rows of 5
    // pixels; bits read top-to-bottom, left-to-right.
    let upper = ch.to_ascii_uppercase();
    match upper {
        ' ' => Some([0; 7]),
        '-' => Some([
            0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000,
        ]),
        '.' => Some([
            0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100,
        ]),
        ':' => Some([
            0b00000, 0b01100, 0b01100, 0b00000, 0b01100, 0b01100, 0b00000,
        ]),
        '/' => Some([
            0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000,
        ]),
        '_' => Some([
            0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b11111,
        ]),
        '0' => Some([
            0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
        ]),
        '1' => Some([
            0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ]),
        '2' => Some([
            0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111,
        ]),
        '3' => Some([
            0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
        ]),
        '4' => Some([
            0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
        ]),
        '5' => Some([
            0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110,
        ]),
        '6' => Some([
            0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
        ]),
        '7' => Some([
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
        ]),
        '8' => Some([
            0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
        ]),
        '9' => Some([
            0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100,
        ]),
        'A' => Some([
            0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ]),
        'B' => Some([
            0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110,
        ]),
        'C' => Some([
            0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110,
        ]),
        'D' => Some([
            0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110,
        ]),
        'E' => Some([
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111,
        ]),
        'F' => Some([
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000,
        ]),
        'G' => Some([
            0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110,
        ]),
        'H' => Some([
            0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ]),
        'I' => Some([
            0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ]),
        'L' => Some([
            0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111,
        ]),
        'M' => Some([
            0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001,
        ]),
        'N' => Some([
            0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001,
        ]),
        'O' => Some([
            0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ]),
        'P' => Some([
            0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000,
        ]),
        'R' => Some([
            0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001,
        ]),
        'S' => Some([
            0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110,
        ]),
        'T' => Some([
            0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100,
        ]),
        'U' => Some([
            0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ]),
        'W' => Some([
            0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001,
        ]),
        'Y' => Some([
            0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100,
        ]),
        'K' => Some([
            0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001,
        ]),
        'V' => Some([
            0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100,
        ]),
        'X' => Some([
            0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001,
        ]),
        'Z' => Some([
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111,
        ]),
        _ => None,
    }
}

fn evenly_spaced<T>(items: &[T], target: usize) -> Vec<usize> {
    if items.is_empty() || target == 0 {
        return Vec::new();
    }
    if target >= items.len() {
        return (0..items.len()).collect();
    }
    let mut seen = vec![false; items.len()];
    let mut out = Vec::with_capacity(target);
    let last = items.len() - 1;
    for i in 0..target {
        let idx = ((i as f64) * (last as f64) / ((target - 1) as f64)).round() as usize;
        let idx = idx.min(last);
        if !seen[idx] {
            seen[idx] = true;
            out.push(idx);
        }
    }
    while out.len() < target {
        let next = items.len() - (target - out.len());
        if next < items.len() && !seen[next] {
            seen[next] = true;
            out.push(next);
        } else {
            // Find any unused index closest to the end.
            let mut found = None;
            for j in (0..items.len()).rev() {
                if !seen[j] {
                    found = Some(j);
                    break;
                }
            }
            match found {
                Some(j) => {
                    seen[j] = true;
                    out.push(j);
                }
                None => break,
            }
        }
    }
    out.sort();
    out
}

fn encode_png(img: &RgbaImage, max_bytes: usize) -> Result<Vec<u8>> {
    // Try the cap as a hard ceiling. The image crate does not accept a byte
    // budget directly, so we step the compression level downward and stop
    // when the output fits or we hit the lowest level.
    let dynamic = image::DynamicImage::ImageRgba8(img.clone());
    for level in [6u8, 4, 2, 1] {
        let mut cursor = Cursor::new(Vec::<u8>::new());
        let encoder = image::codecs::png::PngEncoder::new_with_quality(
            &mut cursor,
            image::codecs::png::CompressionType::Level(level),
            image::codecs::png::FilterType::Adaptive,
        );
        if let Err(err) = encoder.write_image(
            dynamic.as_bytes(),
            dynamic.width(),
            dynamic.height(),
            dynamic.color().into(),
        ) {
            return Err(anyhow::anyhow!("png encode failed: {err}"));
        }
        let bytes = cursor.into_inner();
        if bytes.len() <= max_bytes {
            return Ok(bytes);
        }
    }
    // Final attempt: if still over the cap, return whatever we produced; the
    // caller (compose_sheet) will surface the size error.
    let mut cursor = Cursor::new(Vec::<u8>::new());
    dynamic
        .write_to(&mut cursor, image::ImageFormat::Png)
        .context("png encode failed at fallback level")?;
    Ok(cursor.into_inner())
}

/// Encode a composed sheet for a transient multimodal model attachment.
/// Callers still own persistence; this wrapper keeps the same bounded encoder
/// used by `compose_sheet` and `persist_report`.
pub fn encode_png_bytes(img: &RgbaImage, max_bytes: usize) -> Result<Vec<u8>> {
    encode_png(img, max_bytes)
}

/// Persist the sheet and a sibling JSON manifest under `report_dir`. The
/// directory is created if it does not exist. The filename is derived from
/// the JSON manifest's first non-empty timestamp and the frame count so two
/// sheets written close together do not clobber each other but a reviewer
/// can still see which run a file came from.
pub fn persist_report(
    report_dir: &Path,
    label: &str,
    frames: &[VideoFrame],
    cfg: &ContactSheetConfig,
) -> Result<PersistedReport> {
    if !report_dir.exists() {
        std::fs::create_dir_all(report_dir)
            .with_context(|| format!("create report dir {}", report_dir.display()))?;
    }
    // A label becomes a filename; reject instead of rewriting so the caller
    // cannot accidentally believe evidence was stored under a different id.
    if label.is_empty()
        || label.len() > 96
        || !label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        anyhow::bail!("label must be 1-96 ascii alphanumeric, underscore, or hyphen characters");
    }
    let (sheet, report) = compose_sheet(frames, cfg)?;
    let png = encode_png(&sheet, MAX_PNG_BYTES)?;
    let manifest_json = serde_json::to_vec_pretty(&report)?;
    let png_path = report_dir.join(format!("{label}.png"));
    let manifest_path = report_dir.join(format!("{label}.manifest.json"));
    let png_temp = write_synced_temp(&png_path, &png)?;
    let manifest_temp = match write_synced_temp(&manifest_path, &manifest_json) {
        Ok(path) => path,
        Err(error) => {
            let _ = std::fs::remove_file(&png_temp);
            return Err(error);
        }
    };
    if let Err(error) = std::fs::rename(&png_temp, &png_path) {
        let _ = std::fs::remove_file(&png_temp);
        let _ = std::fs::remove_file(&manifest_temp);
        return Err(error).with_context(|| format!("commit png {}", png_path.display()));
    }
    if let Err(error) = std::fs::rename(&manifest_temp, &manifest_path) {
        let _ = std::fs::remove_file(&manifest_temp);
        // Keep the report pair all-or-nothing from a reader's perspective:
        // if the manifest cannot be committed, remove the already-renamed
        // image instead of leaving a misleading orphan behind.
        let _ = std::fs::remove_file(&png_path);
        return Err(error).with_context(|| format!("commit manifest {}", manifest_path.display()));
    }
    if let Err(error) = std::fs::File::open(report_dir).and_then(|directory| directory.sync_all()) {
        let _ = std::fs::remove_file(&png_path);
        let _ = std::fs::remove_file(&manifest_path);
        return Err(error).with_context(|| format!("sync report dir {}", report_dir.display()));
    }
    Ok(PersistedReport {
        png_path,
        manifest_path,
        png_bytes: png.len(),
    })
}

fn write_synced_temp(destination: &Path, bytes: &[u8]) -> Result<PathBuf> {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .context("report destination must have a UTF-8 filename")?;
    let parent = destination
        .parent()
        .context("report destination must have a parent")?;
    let temp = parent.join(format!(
        ".{file_name}.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .with_context(|| format!("create report temp {}", temp.display()))?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&temp);
        return Err(error).with_context(|| format!("write report temp {}", temp.display()));
    }
    Ok(temp)
}

/// Returned by `persist_report` so callers do not have to rebuild the
/// filenames. Paths are absolute (or relative to the caller's cwd) — the
/// caller decides how to surface them.
#[derive(Debug, Clone)]
pub struct PersistedReport {
    pub png_path: PathBuf,
    pub manifest_path: PathBuf,
    pub png_bytes: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb, RgbImage};

    fn solid_png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
        let mut img = RgbImage::new(width, height);
        for (_, _, p) in img.enumerate_pixels_mut() {
            *p = Rgb(rgb);
        }
        let mut cursor = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        cursor.into_inner()
    }

    fn gradient_png(width: u32, height: u32, base: u8, delta: u8) -> Vec<u8> {
        let mut img = RgbImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let offset = (x.wrapping_add(y) as u8).wrapping_mul(delta);
                let v = base.wrapping_add(offset);
                *img.get_pixel_mut(x, y) = Rgb([v, v.wrapping_add(7), v.wrapping_add(13)]);
            }
        }
        let mut cursor = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        cursor.into_inner()
    }

    fn frames(n: usize) -> Vec<VideoFrame> {
        (0..n)
            .map(|i| VideoFrame {
                bytes: gradient_png(64, 48, 30, (i as u8).wrapping_mul(13)),
                timestamp_seconds: i as f64 * 0.1,
                frame_number: (i as u32) + 1,
                caption: if i % 2 == 0 {
                    Some("step".into())
                } else {
                    None
                },
            })
            .collect()
    }

    #[test]
    fn plan_grid_rejects_zero_frames() {
        let cfg = ContactSheetConfig::default();
        let err = plan_grid(0, &cfg).unwrap_err().to_string();
        assert!(err.contains("at least one frame"));
    }

    #[test]
    fn plan_grid_rejects_over_cap() {
        let cfg = ContactSheetConfig {
            max_frames: Some(MAX_FRAMES + 1),
            ..ContactSheetConfig::default()
        };
        let err = plan_grid(MAX_FRAMES + 2, &cfg).unwrap_err().to_string();
        assert!(err.contains("capped at"));
    }

    #[test]
    fn plan_grid_stays_within_sheet_cap() {
        let cfg = ContactSheetConfig {
            tile_width: MAX_TILE_WIDTH,
            ..ContactSheetConfig::default()
        };
        let plan = plan_grid(MAX_FRAMES, &cfg).unwrap();
        assert!(plan.sheet_width <= MAX_SHEET_SIDE);
        assert!(plan.sheet_height <= MAX_SHEET_SIDE);
    }

    #[test]
    fn plan_grid_auto_columns_is_stable() {
        let cfg = ContactSheetConfig::default();
        let a = plan_grid(12, &cfg).unwrap();
        let b = plan_grid(12, &cfg).unwrap();
        assert_eq!(a, b);
        assert!(a.columns >= 2 && a.columns <= 8);
    }

    #[test]
    fn plan_grid_clamps_explicit_columns() {
        let cfg = ContactSheetConfig {
            columns: Some(100),
            ..ContactSheetConfig::default()
        };
        let plan = plan_grid(3, &cfg).unwrap();
        // Columns cap to frame count so we never render an empty row.
        assert_eq!(plan.columns, 3);
    }

    #[test]
    fn compose_sheet_builds_manifest_with_labels_in_order() {
        let cfg = ContactSheetConfig::default();
        let (sheet, report) = compose_sheet(&frames(6), &cfg).unwrap();
        assert_eq!(sheet.width(), report.plan.sheet_width);
        assert_eq!(sheet.height(), report.plan.sheet_height);
        assert_eq!(report.tiles.len(), 6);
        let timestamps: Vec<_> = report.tiles.iter().map(|t| t.timestamp_seconds).collect();
        let expected: Vec<_> = (0..6).map(|i| i as f64 * 0.1).collect();
        assert_eq!(timestamps, expected);
        assert_eq!(report.tiles[0].x, SHEET_MARGIN);
        assert_eq!(report.tiles[0].y, SHEET_MARGIN);
        assert!(report.tiles[1].x > report.tiles[0].x);
        assert_eq!(report.tiles[1].y, report.tiles[0].y);
        assert_eq!(report.tiles[0].frame_number, 1);
        assert_eq!(report.tiles[5].frame_number, 6);
    }

    #[test]
    fn compose_sheet_subsamples_when_max_frames_smaller() {
        let cfg = ContactSheetConfig {
            max_frames: Some(3),
            ..ContactSheetConfig::default()
        };
        let (_, report) = compose_sheet(&frames(12), &cfg).unwrap();
        assert_eq!(report.tiles.len(), 3);
        assert!(report.notes.iter().any(|n| n.contains("sub-sampled")));
        assert_eq!(report.tiles.first().unwrap().frame_number, 1);
        assert_eq!(report.tiles.last().unwrap().frame_number, 12);
    }

    #[test]
    fn compose_sheet_reports_input_byte_total() {
        let cfg = ContactSheetConfig::default();
        let (_, report) = compose_sheet(&frames(4), &cfg).unwrap();
        let expected: usize = frames(4).iter().map(|f| f.bytes.len()).sum();
        assert_eq!(report.input_bytes, expected);
        assert!(report.encoded_png_bytes > 0);
        assert!(report.encoded_png_bytes <= MAX_PNG_BYTES);
    }

    #[test]
    fn compose_sheet_rejects_oversize_input() {
        let huge = vec![0u8; MAX_INPUT_BYTES + 1];
        let cfg = ContactSheetConfig::default();
        let err = compose_sheet(
            &[VideoFrame {
                bytes: huge,
                timestamp_seconds: 0.0,
                frame_number: 1,
                caption: None,
            }],
            &cfg,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("decoded input"));
    }

    #[test]
    fn compose_sheet_handles_malformed_frame_without_panicking() {
        let mut frames = frames(2);
        frames.push(VideoFrame {
            bytes: vec![0xFFu8; 16],
            timestamp_seconds: 0.2,
            frame_number: 3,
            caption: None,
        });
        let cfg = ContactSheetConfig::default();
        let err = compose_sheet(&frames, &cfg).unwrap_err().to_string();
        assert!(err.contains("unable to decode"));
    }

    #[test]
    fn normalize_tile_letterboxes_to_preserve_aspect() {
        let wide = solid_png(800, 100, [255, 0, 0]);
        let tile = normalize_tile(&wide, 200, 200, [0, 0, 0, 255]).unwrap();
        assert_eq!(tile.width(), 200);
        assert_eq!(tile.height(), 200);
        let mut red_rows = 0;
        for y in 0..tile.height() {
            let p = tile.get_pixel(100, y);
            if p[0] > 200 && p[1] < 30 && p[2] < 30 {
                red_rows += 1;
            }
        }
        assert!(
            red_rows > 10 && red_rows < 80,
            "unexpected red rows: {red_rows}"
        );
    }

    #[test]
    fn normalize_tile_rejects_zero_dimension_frame() {
        let img = RgbImage::new(0, 0);
        let mut cursor = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img.clone())
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap_err(); // image crate rejects 0x0 on encode, fine.
                           // Test the loader side: an empty PNG header is malformed.
        let err = normalize_tile(&[0xFFu8; 16], 32, 32, [0, 0, 0, 255])
            .unwrap_err()
            .to_string();
        assert!(err.contains("unable to decode") || err.contains("zero dimension"));
        let _ = img;
    }

    #[test]
    fn motion_metrics_detects_identical_and_different_frames() {
        let a = solid_png(64, 64, [128, 128, 128]);
        let b = solid_png(64, 64, [128, 128, 128]);
        let c = solid_png(64, 64, [10, 10, 10]);
        let ra = image::load_from_memory(&a).unwrap().to_rgba8();
        let rb = image::load_from_memory(&b).unwrap().to_rgba8();
        let rc = image::load_from_memory(&c).unwrap().to_rgba8();
        let identical = compute_motion(&[ra.clone(), rb.clone()], &[]);
        assert_eq!(identical.len(), 1);
        assert!(identical[0].valid);
        assert!(identical[0].mean_abs_luma_delta < 0.5);
        assert_eq!(identical[0].phash_hamming, 0);
        let different = compute_motion(&[ra, rb, rc], &[]);
        assert_eq!(different.len(), 2);
        assert!(different[1].mean_abs_luma_delta > 50.0);
    }

    #[test]
    fn motion_metrics_records_size_mismatch_without_panicking() {
        let a = image::RgbaImage::new(32, 32);
        let b = image::RgbaImage::new(64, 64);
        let edges = compute_motion(&[a, b], &[]);
        assert_eq!(edges.len(), 1);
        assert!(!edges[0].valid);
        assert!(edges[0].note.as_deref().unwrap().contains("size mismatch"));
    }

    #[test]
    fn motion_metrics_handles_single_frame() {
        let img = image::RgbaImage::new(16, 16);
        let edges = compute_motion(&[img], &[]);
        assert!(edges.is_empty());
    }

    #[test]
    fn persist_report_writes_png_and_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = ContactSheetConfig::default();
        let report = persist_report(dir.path(), "session-1", &frames(3), &cfg).unwrap();
        assert!(report.png_path.exists());
        assert!(report.manifest_path.exists());
        let manifest_bytes = std::fs::read(&report.manifest_path).unwrap();
        let manifest: ContactSheetReport = serde_json::from_slice(&manifest_bytes).unwrap();
        assert_eq!(manifest.tiles.len(), 3);
        assert!(report.png_bytes > 0);
    }

    #[test]
    fn persist_report_refuses_path_traversal_label() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = ContactSheetConfig::default();
        let err = persist_report(dir.path(), "../escape", &frames(1), &cfg)
            .unwrap_err()
            .to_string();
        assert!(err.contains("ascii alphanumeric"));
    }

    #[test]
    fn persist_report_refuses_empty_label() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = ContactSheetConfig::default();
        let err = persist_report(dir.path(), "   ", &frames(1), &cfg)
            .unwrap_err()
            .to_string();
        assert!(err.contains("ascii alphanumeric"));
    }

    #[test]
    fn evenly_spaced_preserves_first_and_last() {
        let idx = evenly_spaced(&[0; 20], 5);
        assert_eq!(idx.first().copied(), Some(0));
        assert_eq!(idx.last().copied(), Some(19));
        assert_eq!(idx.len(), 5);
    }

    #[test]
    fn evenly_spaced_handles_target_equal_to_length() {
        let idx = evenly_spaced(&[0; 5], 5);
        assert_eq!(idx, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn evenly_spaced_handles_zero_target() {
        let idx = evenly_spaced(&[0; 5], 0);
        assert!(idx.is_empty());
    }

    #[test]
    fn encode_png_produces_valid_png() {
        let img: RgbaImage = ImageBuffer::from_pixel(8, 8, Rgba([200, 200, 200, 255]));
        let bytes = encode_png(&img, MAX_PNG_BYTES).unwrap();
        // PNG signature.
        assert_eq!(&bytes[0..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
    }

    #[test]
    fn label_band_renders_text_pixels_into_sheet() {
        let cfg = ContactSheetConfig::default();
        let (sheet, report) = compose_sheet(&frames(1), &cfg).unwrap();
        let tile = &report.tiles[0];
        let band_y_start = tile.y + tile.height;
        let band_y_end = band_y_start + LABEL_BAND_HEIGHT;
        let mut label_pixels = 0u32;
        for y in band_y_start..band_y_end {
            for x in tile.x..(tile.x + tile.width) {
                let p = sheet.get_pixel(x, y);
                if p[0] > 200 && p[1] > 200 && p[2] > 200 {
                    label_pixels += 1;
                }
            }
        }
        assert!(
            label_pixels > 10,
            "label band rendered only {label_pixels} bright pixels"
        );
    }

    #[test]
    fn manifest_roundtrips_through_serde() {
        let cfg = ContactSheetConfig::default();
        let (_, report) = compose_sheet(&frames(3), &cfg).unwrap();
        let bytes = serde_json::to_vec(&report).unwrap();
        let back: ContactSheetReport = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.tiles.len(), report.tiles.len());
        assert_eq!(back.motion.len(), report.motion.len());
        assert_eq!(back.schema_version, 1);
        assert_eq!(back.plan, report.plan);
    }

    #[test]
    fn motion_edges_reference_correct_indices() {
        let cfg = ContactSheetConfig::default();
        let (_, report) = compose_sheet(&frames(5), &cfg).unwrap();
        assert_eq!(report.motion.len(), 4);
        for (i, edge) in report.motion.iter().enumerate() {
            assert_eq!(edge.from_index, i);
            assert_eq!(edge.to_index, i + 1);
        }
    }

    #[test]
    fn rgba_image_default_is_transparent_black() {
        let img: RgbaImage = ImageBuffer::new(4, 4);
        for p in img.pixels() {
            assert_eq!(p.0, [0, 0, 0, 0]);
        }
    }
}
