//! Clean-room image→mesh heuristics.
//!
//! Implements published textbook algorithms only: Otsu thresholding (Otsu,
//! "A Threshold Selection Method from Gray-Level Histograms", 1979),
//! Moore-neighbor contour tracing with Jacob's stopping criterion,
//! Ramer–Douglas–Peucker polyline simplification (Ramer 1972, Douglas &
//! Peucker 1973), ear-clipping polygon triangulation (standard computational
//! geometry), and luma-as-height displacement. No third-party image-to-3D
//! project was consulted or copied.

use anyhow::{Context, Result};
use base64::Engine;
use image::GrayImage;
use serde_json::{json, Value};

/// Largest side after ingest downscale. Keeps flood fill and triangulation
/// millisecond-scale and bounds the embedded texture size.
const MAX_SIDE: u32 = 512;
/// Lathe revolution segments.
const LATHE_SEGMENTS: u32 = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeshMode {
    Extrude,
    Heightfield,
    Lathe,
}

impl MeshMode {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "extrude" => Ok(Self::Extrude),
            "heightfield" => Ok(Self::Heightfield),
            "lathe" => Ok(Self::Lathe),
            other => anyhow::bail!("unknown mesh mode {other}; use extrude, heightfield, lathe"),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Extrude => "extrude",
            Self::Heightfield => "heightfield",
            Self::Lathe => "lathe",
        }
    }
}

#[derive(Debug, Clone)]
pub struct MeshOptions {
    pub mode: MeshMode,
    /// World units. `0.0` = auto (0.25 × silhouette width).
    pub depth: f32,
    /// Heightfield grid resolution, clamped to 8..=192.
    pub resolution: u32,
    /// Max world dimension of the silhouette after normalisation.
    pub target_size: f32,
    /// Manual binarisation threshold; `None` = Otsu.
    pub threshold: Option<u8>,
}

impl Default for MeshOptions {
    fn default() -> Self {
        Self {
            mode: MeshMode::Extrude,
            depth: 0.0,
            resolution: 64,
            target_size: 1.6,
            threshold: None,
        }
    }
}

impl MeshOptions {
    /// Build options from tool-call args (`mode`, `depth`, `resolution`,
    /// `targetSize`, `threshold`). Unknown mode errors; everything else
    /// falls back to defaults.
    pub fn from_args(args: &Value) -> Result<Self> {
        let mut opts = Self::default();
        if let Some(mode) = args.get("mode").and_then(Value::as_str) {
            opts.mode = MeshMode::parse(mode)?;
        }
        if let Some(depth) = args.get("depth").and_then(Value::as_f64) {
            opts.depth = depth.max(0.0) as f32;
        }
        if let Some(res) = args.get("resolution").and_then(Value::as_u64) {
            opts.resolution = (res as u32).clamp(8, 192);
        }
        if let Some(size) = args.get("targetSize").and_then(Value::as_f64) {
            if size > 0.0 {
                opts.target_size = size as f32;
            }
        }
        if let Some(threshold) = args.get("threshold").and_then(Value::as_u64) {
            opts.threshold = Some(threshold.min(255) as u8);
        }
        Ok(opts)
    }
}

#[derive(Debug, Clone)]
pub struct MeshStats {
    pub vertices: usize,
    pub triangles: usize,
    pub mask_coverage: f32,
    pub contour_points: usize,
}

#[derive(Debug, Clone)]
pub struct MeshResult {
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
    pub uvs: Vec<f32>,
    /// Masked copy of the (downscaled) source: alpha 0 outside the silhouette.
    pub texture_png: Vec<u8>,
    pub mode: MeshMode,
    pub stats: MeshStats,
}

/// Admission heuristics for ingest gating.
#[derive(Debug, Clone)]
pub struct Admission {
    pub pass: bool,
    /// Variance of the 3x3 Laplacian over luma; low = blurry.
    pub blur_score: f32,
    /// Foreground fraction of the largest connected component.
    pub mask_coverage: f32,
    #[allow(dead_code)] // reported to callers via image3d::ingest JSON, not read in core
    pub width: u32,
    #[allow(dead_code)]
    pub height: u32,
    pub notes: Vec<String>,
}

// ---------------------------------------------------------------------------
// Bit mask
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct BitMask {
    w: u32,
    h: u32,
    data: Vec<bool>,
}

impl BitMask {
    fn new(w: u32, h: u32) -> Self {
        Self {
            w,
            h,
            data: vec![false; (w * h) as usize],
        }
    }

    #[inline]
    fn get(&self, x: i64, y: i64) -> bool {
        if x < 0 || y < 0 || x >= self.w as i64 || y >= self.h as i64 {
            return false;
        }
        self.data[(y as u32 * self.w + x as u32) as usize]
    }

    #[inline]
    fn set(&mut self, x: u32, y: u32, value: bool) {
        self.data[(y * self.w + x) as usize] = value;
    }

    fn count(&self) -> usize {
        self.data.iter().filter(|b| **b).count()
    }
}

// ---------------------------------------------------------------------------
// Otsu threshold (Otsu 1979)
// ---------------------------------------------------------------------------

fn otsu_threshold(luma: &GrayImage) -> u8 {
    let mut hist = [0u64; 256];
    for p in luma.pixels() {
        hist[p.0[0] as usize] += 1;
    }
    otsu_from_histogram(&hist)
}

fn otsu_from_histogram(hist: &[u64; 256]) -> u8 {
    let total: u64 = hist.iter().sum();
    if total == 0 {
        return 127;
    }
    let sum_all: f64 = hist
        .iter()
        .enumerate()
        .map(|(i, &c)| i as f64 * c as f64)
        .sum();
    let mut sum_b = 0.0f64;
    let mut weight_b = 0u64;
    let mut best = 0.0f64;
    let mut threshold = 127u8;
    for (t, &count) in hist.iter().enumerate() {
        weight_b += count;
        if weight_b == 0 {
            continue;
        }
        let weight_f = total - weight_b;
        if weight_f == 0 {
            break;
        }
        sum_b += t as f64 * count as f64;
        let mean_b = sum_b / weight_b as f64;
        let mean_f = (sum_all - sum_b) / weight_f as f64;
        let between = weight_b as f64 * weight_f as f64 * (mean_b - mean_f).powi(2);
        if between > best {
            best = between;
            threshold = t as u8;
        }
    }
    threshold
}

// ---------------------------------------------------------------------------
// Silhouette extraction
// ---------------------------------------------------------------------------

/// Binarise luma at `threshold`, choosing foreground polarity so the subject
/// does not dominate the image border (backgrounds touch the border).
fn binarise(luma: &GrayImage, threshold: u8) -> BitMask {
    let (w, h) = luma.dimensions();
    let mut mask = BitMask::new(w, h);
    for (x, y, p) in luma.enumerate_pixels() {
        mask.set(x, y, p.0[0] > threshold);
    }
    // Border occupancy of the "bright" class.
    let mut border_set = 0u32;
    let mut border_total = 0u32;
    for x in 0..w {
        for y in [0, h.saturating_sub(1)] {
            border_total += 1;
            if mask.get(x as i64, y as i64) {
                border_set += 1;
            }
        }
    }
    for y in 0..h {
        for x in [0, w.saturating_sub(1)] {
            border_total += 1;
            if mask.get(x as i64, y as i64) {
                border_set += 1;
            }
        }
    }
    if border_total > 0 && border_set * 2 > border_total {
        for value in mask.data.iter_mut() {
            *value = !*value;
        }
    }
    mask
}

/// Largest 4-connected foreground component via BFS flood fill.
fn largest_component(mask: &BitMask) -> BitMask {
    let mut visited = vec![false; mask.data.len()];
    let mut best: Vec<u32> = Vec::new();
    let mut current: Vec<u32> = Vec::new();
    let mut queue: std::collections::VecDeque<u32> = Default::default();
    let w = mask.w as i64;
    let h = mask.h as i64;
    for start in 0..mask.data.len() {
        if !mask.data[start] || visited[start] {
            continue;
        }
        current.clear();
        queue.push_back(start as u32);
        visited[start] = true;
        while let Some(index) = queue.pop_front() {
            current.push(index);
            let x = (index as i64) % w;
            let y = (index as i64) / w;
            for (dx, dy) in [(1i64, 0i64), (-1, 0), (0, 1), (0, -1)] {
                let nx = x + dx;
                let ny = y + dy;
                if nx < 0 || ny < 0 || nx >= w || ny >= h {
                    continue;
                }
                let ni = (ny * w + nx) as usize;
                if mask.data[ni] && !visited[ni] {
                    visited[ni] = true;
                    queue.push_back(ni as u32);
                }
            }
        }
        if current.len() > best.len() {
            std::mem::swap(&mut best, &mut current);
        }
    }
    let mut out = BitMask::new(mask.w, mask.h);
    for index in best {
        out.data[index as usize] = true;
    }
    out
}

/// One-pixel morphological close (3x3 dilate then 3x3 erode) to seal pinholes.
fn morph_close(mask: &BitMask) -> BitMask {
    let dilated = morph(mask, true);
    morph(&dilated, false)
}

fn morph(mask: &BitMask, dilate: bool) -> BitMask {
    let mut out = BitMask::new(mask.w, mask.h);
    for y in 0..mask.h as i64 {
        for x in 0..mask.w as i64 {
            let mut any = false;
            let mut all = true;
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let v = mask.get(x + dx, y + dy);
                    any |= v;
                    all &= v;
                }
            }
            out.set(x as u32, y as u32, if dilate { any } else { all });
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Moore-neighbor contour tracing
// ---------------------------------------------------------------------------

/// Clockwise 8-neighbourhood in image coordinates (y down):
/// E, SE, S, SW, W, NW, N, NE.
const DIRS: [(i64, i64); 8] = [
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
    (0, -1),
    (1, -1),
];

/// Trace the outer boundary of the (single-component) mask. Returns boundary
/// pixel centres in image coordinates.
fn trace_contour(mask: &BitMask) -> Vec<(f32, f32)> {
    // First foreground pixel in row-major order: its W and N neighbours are
    // background, so W is a valid backtrack.
    let mut start: Option<(i64, i64)> = None;
    'scan: for y in 0..mask.h as i64 {
        for x in 0..mask.w as i64 {
            if mask.get(x, y) {
                start = Some((x, y));
                break 'scan;
            }
        }
    }
    let Some(start) = start else {
        return Vec::new();
    };

    let mut contour: Vec<(f32, f32)> = vec![(start.0 as f32, start.1 as f32)];
    let mut current = start;
    // Backtrack: the background pixel we entered `current` from. West of the
    // scan-order start pixel is guaranteed background.
    let mut backtrack = (start.0 - 1, start.1);
    let initial_backtrack = backtrack;
    let cap = mask.data.len() * 4 + 8;

    for _ in 0..cap {
        let back_dir = DIRS
            .iter()
            .position(|d| (current.0 + d.0, current.1 + d.1) == backtrack)
            .unwrap_or(4);
        let mut advanced = false;
        for step in 1..=8 {
            let idx = (back_dir + step) % 8;
            let candidate = (current.0 + DIRS[idx].0, current.1 + DIRS[idx].1);
            if mask.get(candidate.0, candidate.1) {
                backtrack = (
                    current.0 + DIRS[(back_dir + step - 1) % 8].0,
                    current.1 + DIRS[(back_dir + step - 1) % 8].1,
                );
                current = candidate;
                advanced = true;
                break;
            }
        }
        if !advanced {
            // Isolated pixel.
            break;
        }
        // Jacob's stopping criterion: back at the start, entered the same way.
        if current == start && backtrack == initial_backtrack {
            break;
        }
        contour.push((current.0 as f32, current.1 as f32));
    }
    contour
}

// ---------------------------------------------------------------------------
// Ramer–Douglas–Peucker simplification
// ---------------------------------------------------------------------------

fn perpendicular_distance(p: (f32, f32), a: (f32, f32), b: (f32, f32)) -> f32 {
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-9 {
        let ex = p.0 - a.0;
        let ey = p.1 - a.1;
        return (ex * ex + ey * ey).sqrt();
    }
    ((dx * (a.1 - p.1) - dy * (a.0 - p.0)) / len).abs()
}

/// Simplify an open polyline, keeping endpoints.
fn rdp(points: &[(f32, f32)], epsilon: f32) -> Vec<(f32, f32)> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let first = points[0];
    let last = *points.last().unwrap();
    let mut max_dist = 0.0f32;
    let mut max_index = 0usize;
    for (i, p) in points.iter().enumerate().skip(1).take(points.len() - 2) {
        let d = perpendicular_distance(*p, first, last);
        if d > max_dist {
            max_dist = d;
            max_index = i;
        }
    }
    if max_dist > epsilon {
        let mut left = rdp(&points[..=max_index], epsilon);
        let right = rdp(&points[max_index..], epsilon);
        left.pop();
        left.extend(right);
        left
    } else {
        vec![first, last]
    }
}

/// Simplify a closed contour: split at the point farthest from the start so
/// RDP endpoints do not erase real corners, simplify both halves.
fn rdp_closed(points: &[(f32, f32)], epsilon: f32) -> Vec<(f32, f32)> {
    if points.len() < 4 {
        return points.to_vec();
    }
    let first = points[0];
    let mut far = points.len() / 2;
    let mut far_dist = 0.0f32;
    for (i, p) in points.iter().enumerate() {
        let dx = p.0 - first.0;
        let dy = p.1 - first.1;
        let d = dx * dx + dy * dy;
        if d > far_dist {
            far_dist = d;
            far = i;
        }
    }
    if far == 0 || far == points.len() - 1 {
        return rdp(points, epsilon);
    }
    let mut half_a = rdp(&points[..=far], epsilon);
    let mut wrapped: Vec<(f32, f32)> = points[far..].to_vec();
    wrapped.push(first);
    let half_b = rdp(&wrapped, epsilon);
    half_a.pop();
    half_a.extend(half_b);
    // Closed: drop the duplicated closing point.
    if half_a.len() > 1 && half_a.first() == half_a.last() {
        half_a.pop();
    }
    dedupe_consecutive(&half_a)
}

fn dedupe_consecutive(points: &[(f32, f32)]) -> Vec<(f32, f32)> {
    let mut out: Vec<(f32, f32)> = Vec::with_capacity(points.len());
    for p in points {
        if out
            .last()
            .map(|last| (last.0 - p.0).abs() < 1e-6 && (last.1 - p.1).abs() < 1e-6)
            .unwrap_or(false)
        {
            continue;
        }
        out.push(*p);
    }
    if out.len() > 1 {
        let first = out[0];
        let last = *out.last().unwrap();
        if (first.0 - last.0).abs() < 1e-6 && (first.1 - last.1).abs() < 1e-6 {
            out.pop();
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Ear-clipping triangulation
// ---------------------------------------------------------------------------

fn signed_area(polygon: &[(f32, f32)]) -> f32 {
    let mut area = 0.0f32;
    for i in 0..polygon.len() {
        let a = polygon[i];
        let b = polygon[(i + 1) % polygon.len()];
        area += a.0 * b.1 - b.0 * a.1;
    }
    area * 0.5
}

fn cross(o: (f32, f32), a: (f32, f32), b: (f32, f32)) -> f32 {
    (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0)
}

fn point_in_triangle(p: (f32, f32), a: (f32, f32), b: (f32, f32), c: (f32, f32)) -> bool {
    let d1 = cross(a, b, p);
    let d2 = cross(b, c, p);
    let d3 = cross(c, a, p);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

/// Triangulate a simple polygon (CCW) by ear clipping. Returns index triples
/// into the input slice. The polygon must be CCW; callers normalise first.
fn ear_clip(polygon: &[(f32, f32)]) -> Vec<u32> {
    let n = polygon.len();
    if n < 3 {
        return Vec::new();
    }
    let mut remaining: Vec<u32> = (0..n as u32).collect();
    let mut triangles: Vec<u32> = Vec::with_capacity((n - 2) * 3);
    let mut guard = 0usize;
    let guard_cap = n * n + 16;
    while remaining.len() > 3 && guard < guard_cap {
        guard += 1;
        let m = remaining.len();
        let mut clipped = false;
        for i in 0..m {
            let ia = remaining[(i + m - 1) % m];
            let ib = remaining[i];
            let ic = remaining[(i + 1) % m];
            let a = polygon[ia as usize];
            let b = polygon[ib as usize];
            let c = polygon[ic as usize];
            // Convex corner in a CCW polygon.
            if cross(a, b, c) <= 1e-9 {
                continue;
            }
            let mut contains_other = false;
            for &other in &remaining {
                if other == ia || other == ib || other == ic {
                    continue;
                }
                if point_in_triangle(polygon[other as usize], a, b, c) {
                    contains_other = true;
                    break;
                }
            }
            if contains_other {
                continue;
            }
            triangles.extend_from_slice(&[ia, ib, ic]);
            remaining.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            // Degenerate leftovers (collinear runs). Clip the corner with the
            // largest cross product to keep making progress.
            let mut best_i = 0usize;
            let mut best_cross = f32::MIN;
            for i in 0..remaining.len() {
                let m2 = remaining.len();
                let a = polygon[remaining[(i + m2 - 1) % m2] as usize];
                let b = polygon[remaining[i] as usize];
                let c = polygon[remaining[(i + 1) % m2] as usize];
                let cr = cross(a, b, c);
                if cr > best_cross {
                    best_cross = cr;
                    best_i = i;
                }
            }
            let m2 = remaining.len();
            triangles.extend_from_slice(&[
                remaining[(best_i + m2 - 1) % m2],
                remaining[best_i],
                remaining[(best_i + 1) % m2],
            ]);
            remaining.remove(best_i);
        }
    }
    if remaining.len() == 3 {
        triangles.extend_from_slice(&[remaining[0], remaining[1], remaining[2]]);
    }
    triangles
}

// ---------------------------------------------------------------------------
// Shared image prep
// ---------------------------------------------------------------------------

struct Prepared {
    luma: GrayImage,
    rgba: image::RgbaImage,
    mask: BitMask,
}

fn prepare(image_bytes: &[u8], threshold: Option<u8>) -> Result<Prepared> {
    let decoded = image::load_from_memory(image_bytes).context("unable to decode image")?;
    let (w, h) = (decoded.width(), decoded.height());
    let scale = (MAX_SIDE as f32 / w.max(h) as f32).min(1.0);
    let (nw, nh) = (
        ((w as f32 * scale).round() as u32).max(1),
        ((h as f32 * scale).round() as u32).max(1),
    );
    let resized = if scale < 1.0 {
        decoded.resize_exact(nw, nh, image::imageops::FilterType::Triangle)
    } else {
        decoded
    };
    let luma = resized.to_luma8();
    let rgba = resized.to_rgba8();
    let threshold = threshold.unwrap_or_else(|| otsu_threshold(&luma));
    let mask = morph_close(&largest_component(&binarise(&luma, threshold)));
    Ok(Prepared { luma, rgba, mask })
}

fn masked_texture_png(rgba: &image::RgbaImage, mask: &BitMask) -> Result<Vec<u8>> {
    let mut out = rgba.clone();
    for (x, y, p) in out.enumerate_pixels_mut() {
        if !mask.get(x as i64, y as i64) {
            p.0[3] = 0;
        }
    }
    let mut cursor = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(out)
        .write_to(&mut cursor, image::ImageFormat::Png)
        .context("texture encode failed")?;
    Ok(cursor.into_inner())
}

fn mask_bbox(mask: &BitMask) -> Option<(u32, u32, u32, u32)> {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (u32::MAX, u32::MAX, 0u32, 0u32);
    let mut any = false;
    for y in 0..mask.h {
        for x in 0..mask.w {
            if mask.get(x as i64, y as i64) {
                any = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }
    any.then_some((min_x, min_y, max_x, max_y))
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/// Admission heuristics for ingest gating: Laplacian-variance blur estimate
/// plus silhouette coverage of the largest component.
pub fn admit(image_bytes: &[u8]) -> Result<Admission> {
    let decoded = image::load_from_memory(image_bytes).context("unable to decode image")?;
    let (width, height) = (decoded.width(), decoded.height());
    let prepared = prepare(image_bytes, None)?;
    let blur_score = laplacian_variance(&prepared.luma);
    let total = (prepared.mask.w * prepared.mask.h) as f32;
    let mask_coverage = if total > 0.0 {
        prepared.mask.count() as f32 / total
    } else {
        0.0
    };

    let mut notes: Vec<String> = Vec::new();
    let mut pass = true;
    if width.min(height) < 64 {
        pass = false;
        notes.push(format!(
            "resolution too low ({width}x{height}); minimum side is 64px"
        ));
    }
    if blur_score < 30.0 {
        pass = false;
        notes.push(format!(
            "image looks blurry (Laplacian variance {blur_score:.1} < 30); provide a sharper reference"
        ));
    } else if blur_score < 100.0 {
        notes.push(format!(
            "image is slightly soft (Laplacian variance {blur_score:.1}); edges may be imprecise"
        ));
    }
    if mask_coverage < 0.02 {
        pass = false;
        notes.push(format!(
            "no clear subject silhouette (coverage {:.1}% < 2%); use a plainer background",
            mask_coverage * 100.0
        ));
    } else if mask_coverage > 0.9 {
        notes.push(format!(
            "silhouette fills {:.0}% of the frame; subject/background separation may be poor",
            mask_coverage * 100.0
        ));
    }
    Ok(Admission {
        pass,
        blur_score,
        mask_coverage,
        width,
        height,
        notes,
    })
}

fn laplacian_variance(luma: &GrayImage) -> f32 {
    let (w, h) = luma.dimensions();
    if w < 3 || h < 3 {
        return 0.0;
    }
    let mut values: Vec<f32> = Vec::with_capacity(((w - 2) * (h - 2)) as usize);
    let at = |x: u32, y: u32| luma.get_pixel(x, y).0[0] as f32;
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let v = at(x + 1, y) + at(x - 1, y) + at(x, y + 1) + at(x, y - 1) - 4.0 * at(x, y);
            values.push(v);
        }
    }
    let mean = values.iter().sum::<f32>() / values.len() as f32;
    values.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / values.len() as f32
}

// ---------------------------------------------------------------------------
// image_to_mesh
// ---------------------------------------------------------------------------

pub fn image_to_mesh(image_bytes: &[u8], opts: &MeshOptions) -> Result<MeshResult> {
    let prepared = prepare(image_bytes, opts.threshold)?;
    let mask = &prepared.mask;
    let (w, h) = (mask.w, mask.h);
    let (min_x, min_y, max_x, max_y) =
        mask_bbox(mask).context("no silhouette found in the image")?;
    let bbox_w = (max_x - min_x + 1) as f32;
    let bbox_h = (max_y - min_y + 1) as f32;
    if bbox_w < 3.0 || bbox_h < 3.0 {
        anyhow::bail!("silhouette too small to mesh ({bbox_w}x{bbox_h} px)");
    }

    let epsilon = 0.006 * w.max(h) as f32;
    let raw_contour = trace_contour(mask);
    let contour = rdp_closed(&raw_contour, epsilon);

    // World 2D: x right, y up (flip image y). CCW in this frame faces +z.
    let mut polygon: Vec<(f32, f32)> = contour.iter().map(|p| (p.0, h as f32 - p.1)).collect();
    if signed_area(&polygon) < 0.0 {
        polygon.reverse();
    }
    let polygon = dedupe_consecutive(&polygon);
    if polygon.len() < 3 && opts.mode != MeshMode::Lathe {
        anyhow::bail!("contour degenerated to fewer than 3 points");
    }

    // Depth: world-unit option converted to pixel space (normalisation later
    // scales the silhouette's max bbox dimension to target_size).
    let scale = opts.target_size / bbox_w.max(bbox_h);
    let depth_px = if opts.depth > 0.0 {
        opts.depth / scale
    } else {
        0.25 * bbox_w
    };

    let (mut positions, indices, uvs) = match opts.mode {
        MeshMode::Extrude => extrude(&polygon, depth_px, w as f32, h as f32),
        MeshMode::Heightfield => heightfield(
            &prepared.luma,
            mask,
            (min_x, min_y, max_x, max_y),
            opts.resolution,
            depth_px,
        ),
        MeshMode::Lathe => lathe(mask, (min_x, min_y, max_x, max_y), epsilon)?,
    };

    normalise_positions(&mut positions, opts.target_size);

    let texture_png = masked_texture_png(&prepared.rgba, mask)?;
    let coverage = mask.count() as f32 / (w * h) as f32;
    let stats = MeshStats {
        vertices: positions.len() / 3,
        triangles: indices.len() / 3,
        mask_coverage: coverage,
        contour_points: polygon.len(),
    };
    Ok(MeshResult {
        positions,
        indices,
        uvs,
        texture_png,
        mode: opts.mode,
        stats,
    })
}

/// Uniform scale so max dimension = target_size; center x/z, ground min y = 0.
fn normalise_positions(positions: &mut [f32], target_size: f32) {
    if positions.is_empty() {
        return;
    }
    let mut min = [f32::MAX; 3];
    let mut max = [f32::MIN; 3];
    for chunk in positions.chunks_exact(3) {
        for axis in 0..3 {
            min[axis] = min[axis].min(chunk[axis]);
            max[axis] = max[axis].max(chunk[axis]);
        }
    }
    let span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    let largest = span[0].max(span[1]).max(span[2]).max(1e-6);
    let s = target_size / largest;
    let cx = (min[0] + max[0]) * 0.5;
    let cz = (min[2] + max[2]) * 0.5;
    for chunk in positions.chunks_exact_mut(3) {
        chunk[0] = (chunk[0] - cx) * s;
        chunk[1] = (chunk[1] - min[1]) * s;
        chunk[2] = (chunk[2] - cz) * s;
    }
}

/// Extrude a CCW polygon (world 2D, y up) into a closed solid: front cap at
/// +depth/2, back cap at -depth/2, side quads with arc-length UVs.
fn extrude(
    polygon: &[(f32, f32)],
    depth: f32,
    img_w: f32,
    img_h: f32,
) -> (Vec<f32>, Vec<u32>, Vec<f32>) {
    let n = polygon.len();
    let half = depth * 0.5;
    let cap_indices = ear_clip(polygon);

    let mut positions: Vec<f32> = Vec::new();
    let mut uvs: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();

    // Front cap vertices [0, n), back cap [n, 2n).
    for &(x, y) in polygon {
        positions.extend_from_slice(&[x, y, half]);
        uvs.extend_from_slice(&[x / img_w, y / img_h]);
    }
    for &(x, y) in polygon {
        positions.extend_from_slice(&[x, y, -half]);
        uvs.extend_from_slice(&[x / img_w, y / img_h]);
    }
    // Front cap: CCW polygon faces +z as-is.
    indices.extend_from_slice(&cap_indices);
    // Back cap: reversed winding.
    for tri in cap_indices.chunks_exact(3) {
        indices.extend_from_slice(&[tri[2] + n as u32, tri[1] + n as u32, tri[0] + n as u32]);
    }

    // Side ring with a seam duplicate so arc-length U is continuous.
    let mut arc: Vec<f32> = Vec::with_capacity(n + 1);
    let mut total = 0.0f32;
    arc.push(0.0);
    for i in 0..n {
        let a = polygon[i];
        let b = polygon[(i + 1) % n];
        total += ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
        arc.push(total);
    }
    let total = total.max(1e-6);
    let side_base = positions.len() as u32 / 3;
    for i in 0..=n {
        let (x, y) = polygon[i % n];
        let u = arc[i] / total;
        positions.extend_from_slice(&[x, y, half]);
        uvs.extend_from_slice(&[u, 1.0]);
        positions.extend_from_slice(&[x, y, -half]);
        uvs.extend_from_slice(&[u, 0.0]);
    }
    for i in 0..n as u32 {
        let f0 = side_base + i * 2;
        let b0 = f0 + 1;
        let f1 = side_base + (i + 1) * 2;
        let b1 = f1 + 1;
        // Outward winding for a CCW polygon.
        indices.extend_from_slice(&[f0, b0, b1]);
        indices.extend_from_slice(&[f0, b1, f1]);
    }
    (positions, indices, uvs)
}

/// Regular grid relief plate over the mask bbox; z = smoothed luma × depth
/// inside the mask, 0 outside (the flat rim doubles as the skirt).
fn heightfield(
    luma: &GrayImage,
    mask: &BitMask,
    bbox: (u32, u32, u32, u32),
    resolution: u32,
    depth: f32,
) -> (Vec<f32>, Vec<u32>, Vec<f32>) {
    let (min_x, min_y, max_x, max_y) = bbox;
    let res = resolution.clamp(8, 192);
    let (w, h) = luma.dimensions();
    let bw = (max_x - min_x) as f32;
    let bh = (max_y - min_y) as f32;

    // 3x3 box blur sample.
    let smoothed = |px: i64, py: i64| -> f32 {
        let mut sum = 0.0f32;
        let mut count = 0.0f32;
        for dy in -1i64..=1 {
            for dx in -1i64..=1 {
                let x = px + dx;
                let y = py + dy;
                if x >= 0 && y >= 0 && (x as u32) < w && (y as u32) < h {
                    sum += luma.get_pixel(x as u32, y as u32).0[0] as f32;
                    count += 1.0;
                }
            }
        }
        if count > 0.0 {
            sum / count
        } else {
            0.0
        }
    };

    let mut positions: Vec<f32> = Vec::with_capacity(((res + 1) * (res + 1) * 3) as usize);
    let mut uvs: Vec<f32> = Vec::with_capacity(((res + 1) * (res + 1) * 2) as usize);
    for gy in 0..=res {
        for gx in 0..=res {
            let fx = min_x as f32 + bw * gx as f32 / res as f32;
            let fy = min_y as f32 + bh * gy as f32 / res as f32;
            let px = fx.round() as i64;
            let py = fy.round() as i64;
            let inside = mask.get(px, py);
            let z = if inside {
                smoothed(px, py) / 255.0 * depth
            } else {
                0.0
            };
            // World: x right, y up (flip image y), relief along +z.
            positions.extend_from_slice(&[fx, h as f32 - fy, z]);
            uvs.extend_from_slice(&[fx / w as f32, 1.0 - fy / h as f32]);
        }
    }
    let mut indices: Vec<u32> = Vec::with_capacity((res * res * 6) as usize);
    let stride = res + 1;
    for gy in 0..res {
        for gx in 0..res {
            // Row gy is image-top (world-high); winding chosen to face +z.
            let a = gy * stride + gx;
            let b = a + 1;
            let c = a + stride;
            let d = c + 1;
            indices.extend_from_slice(&[a, c, d]);
            indices.extend_from_slice(&[a, d, b]);
        }
    }
    (positions, indices, uvs)
}

/// Revolve the silhouette's per-row max radius around the vertical axis.
fn lathe(
    mask: &BitMask,
    bbox: (u32, u32, u32, u32),
    epsilon: f32,
) -> Result<(Vec<f32>, Vec<u32>, Vec<f32>)> {
    let (min_x, min_y, max_x, max_y) = bbox;
    // Axis: silhouette centroid x.
    let mut cx_sum = 0.0f64;
    let mut count = 0.0f64;
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            if mask.get(x as i64, y as i64) {
                cx_sum += x as f64;
                count += 1.0;
            }
        }
    }
    if count == 0.0 {
        anyhow::bail!("empty silhouette");
    }
    let cx = (cx_sum / count) as f32;

    // Right-half profile: max radius per row, top to bottom.
    let mut profile: Vec<(f32, f32)> = Vec::new();
    for y in min_y..=max_y {
        let mut radius = 0.0f32;
        let mut any = false;
        for x in min_x..=max_x {
            if mask.get(x as i64, y as i64) {
                any = true;
                radius = radius.max((x as f32 - cx).abs());
            }
        }
        if any {
            profile.push((radius.max(0.5), y as f32));
        }
    }
    if profile.len() < 2 {
        anyhow::bail!("silhouette too thin for lathe");
    }
    let profile = {
        let simplified = rdp(&profile, epsilon);
        if simplified.len() >= 2 {
            simplified
        } else {
            profile
        }
    };

    let rows = profile.len();
    let segs = LATHE_SEGMENTS;
    let mut positions: Vec<f32> = Vec::new();
    let mut uvs: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let img_h = mask.h as f32;

    // Rings with a seam duplicate column.
    for (k, &(radius, y_img)) in profile.iter().enumerate() {
        let y = img_h - y_img; // world y up
        for i in 0..=segs {
            let theta = std::f32::consts::TAU * i as f32 / segs as f32;
            positions.extend_from_slice(&[radius * theta.cos(), y, radius * theta.sin()]);
            uvs.extend_from_slice(&[i as f32 / segs as f32, 1.0 - k as f32 / (rows - 1) as f32]);
        }
    }
    let stride = segs + 1;
    for k in 0..(rows as u32 - 1) {
        for i in 0..segs {
            let a = k * stride + i; // upper ring
            let b = (k + 1) * stride + i; // lower ring
                                          // Outward winding for revolve around +y with theta toward +z.
            indices.extend_from_slice(&[a, b + 1, b]);
            indices.extend_from_slice(&[a, a + 1, b + 1]);
        }
    }

    // Caps: fan to an axis vertex at each end.
    let top = profile[0];
    let bottom = profile[rows - 1];
    let top_apex = positions.len() as u32 / 3;
    positions.extend_from_slice(&[0.0, img_h - top.1, 0.0]);
    uvs.extend_from_slice(&[0.5, 1.0]);
    let bottom_apex = positions.len() as u32 / 3;
    positions.extend_from_slice(&[0.0, img_h - bottom.1, 0.0]);
    uvs.extend_from_slice(&[0.5, 0.0]);
    for i in 0..segs {
        // Top cap faces +y.
        indices.extend_from_slice(&[top_apex, i + 1, i]);
        // Bottom cap faces -y.
        let base = (rows as u32 - 1) * stride;
        indices.extend_from_slice(&[bottom_apex, base + i, base + i + 1]);
    }
    Ok((positions, indices, uvs))
}

// ---------------------------------------------------------------------------
// .cali spec emission
// ---------------------------------------------------------------------------

/// Assemble a `.cali` spec Value from a mesh result: one `mesh` component and
/// one material whose `map` embeds the masked source texture as a PNG data
/// URI. Compatible with `image3d::generate` and the renderer's mesh branch.
pub fn mesh_to_cali_spec(name: &str, source_hash: &str, result: &MeshResult) -> Value {
    let texture_b64 = base64::engine::general_purpose::STANDARD.encode(&result.texture_png);
    json!({
        "schemaVersion": crate::image3d::CALI_SCHEMA_VERSION,
        "targetName": name,
        "sourceHash": source_hash,
        "suitability": "pass",
        "coordinateFrame": { "up": [0, 1, 0], "scale": "meters", "cameraYaw": 0 },
        "componentTree": [
            {
                "id": "mesh-root",
                "name": name,
                "level": "macro",
                "topologyClass": "image-mesh",
                "primitive": "mesh",
                "mesh": {
                    "positions": result.positions,
                    "indices": result.indices,
                    "uvs": result.uvs
                },
                "transform": { "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1] },
                "parent": null,
                "materialId": "material-image"
            }
        ],
        "materials": [
            {
                "id": "material-image",
                "name": "Image Projection",
                "pbr": {
                    "baseColor": "#ffffff",
                    "metalness": 0.0,
                    "roughness": 0.85,
                    "map": format!("data:image/png;base64,{texture_b64}")
                }
            }
        ],
        "proceduralStrategy": ["image-mesh", format!("image-mesh-{}", result.mode.as_str())],
        "runtime": {
            "pivots": [{ "id": "pivot-primary", "node": "mesh-root", "axis": [0, 1, 0] }],
            "sockets": [],
            "colliders": [{ "id": "collider-root", "node": "mesh-root", "kind": "box" }],
            "destructionGroups": []
        },
        "assessment": {
            "generator": "image_mesh",
            "mode": result.mode.as_str(),
            "stats": {
                "vertices": result.stats.vertices,
                "triangles": result.stats.triangles,
                "maskCoverage": result.stats.mask_coverage,
                "contourPoints": result.stats.contour_points
            }
        },
        "buildPasses": crate::image3d::PASS_ORDER
            .iter()
            .map(|p| json!({ "id": p, "componentRefs": ["mesh-root"] }))
            .collect::<Vec<_>>(),
        "reviewHistory": []
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_png(img: image::RgbImage) -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        cursor.into_inner()
    }

    fn white_square_on_black(size: u32, margin: u32) -> Vec<u8> {
        let mut img = image::RgbImage::new(size, size);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let inside = x >= margin && x < size - margin && y >= margin && y < size - margin;
            *p = if inside {
                image::Rgb([240, 240, 240])
            } else {
                image::Rgb([8, 8, 8])
            };
        }
        encode_png(img)
    }

    fn white_circle_on_black(size: u32, radius: u32) -> Vec<u8> {
        let mut img = image::RgbImage::new(size, size);
        let c = size as f32 / 2.0;
        for (x, y, p) in img.enumerate_pixels_mut() {
            let dx = x as f32 - c;
            let dy = y as f32 - c;
            *p = if (dx * dx + dy * dy).sqrt() < radius as f32 {
                image::Rgb([230, 230, 230])
            } else {
                image::Rgb([10, 10, 10])
            };
        }
        encode_png(img)
    }

    #[test]
    fn otsu_separates_a_bimodal_histogram() {
        let mut hist = [0u64; 256];
        hist[30] = 5000;
        hist[220] = 5000;
        let t = otsu_from_histogram(&hist);
        assert!(
            (30..220).contains(&t),
            "threshold {t} should split the modes"
        );
    }

    #[test]
    fn binarise_picks_the_non_border_class_as_foreground() {
        // Bright object on dark ground and the inverse must both yield the
        // object as foreground.
        for invert in [false, true] {
            let mut img = GrayImage::new(64, 64);
            for (x, y, p) in img.enumerate_pixels_mut() {
                let inside = (16..48).contains(&x) && (16..48).contains(&y);
                let bright = inside != invert;
                p.0[0] = if bright { 230 } else { 20 };
            }
            let mask = binarise(&img, otsu_threshold(&img));
            assert!(mask.get(32, 32), "center must be foreground");
            assert!(!mask.get(0, 0), "corner must be background");
        }
    }

    #[test]
    fn largest_component_drops_specks() {
        let mut mask = BitMask::new(32, 32);
        for y in 4..20u32 {
            for x in 4..20u32 {
                mask.set(x, y, true);
            }
        }
        mask.set(30, 30, true); // speck
        let largest = largest_component(&mask);
        assert!(largest.get(10, 10));
        assert!(!largest.get(30, 30));
        assert_eq!(largest.count(), 16 * 16);
    }

    #[test]
    fn contour_of_a_square_has_perimeter_length() {
        let mut mask = BitMask::new(64, 64);
        for y in 10..50u32 {
            for x in 10..50u32 {
                mask.set(x, y, true);
            }
        }
        let contour = trace_contour(&mask);
        // 40x40 block: boundary pixel count = 4*40 - 4 = 156.
        assert!(
            (140..=170).contains(&contour.len()),
            "contour length {} should be near the perimeter",
            contour.len()
        );
    }

    #[test]
    fn contour_of_a_circle_is_near_circumference() {
        let bytes = white_circle_on_black(128, 40);
        let prepared = prepare(&bytes, None).unwrap();
        let contour = trace_contour(&prepared.mask);
        let circumference = 2.0 * std::f32::consts::PI * 40.0;
        let len = contour.len() as f32;
        assert!(
            len > circumference * 0.8 && len < circumference * 1.6,
            "contour {len} points vs circumference {circumference}"
        );
    }

    #[test]
    fn rdp_reduces_a_noisy_square_to_few_points() {
        let mut points: Vec<(f32, f32)> = Vec::new();
        // Square 0,0 -> 100,0 -> 100,100 -> 0,100, one point per unit.
        for i in 0..100 {
            points.push((i as f32, (i % 2) as f32 * 0.3));
        }
        for i in 0..100 {
            points.push((100.0, i as f32));
        }
        for i in 0..100 {
            points.push((100.0 - i as f32, 100.0));
        }
        for i in 0..100 {
            points.push((0.0, 100.0 - i as f32));
        }
        let simplified = rdp_closed(&points, 1.0);
        assert!(
            simplified.len() >= 4 && simplified.len() <= 10,
            "square simplified to {} points",
            simplified.len()
        );
    }

    #[test]
    fn ear_clip_convex_polygon_yields_n_minus_2_triangles() {
        // Regular CCW hexagon.
        let polygon: Vec<(f32, f32)> = (0..6)
            .map(|i| {
                let a = std::f32::consts::TAU * i as f32 / 6.0;
                (a.cos(), a.sin())
            })
            .collect();
        let triangles = ear_clip(&polygon);
        assert_eq!(triangles.len(), (6 - 2) * 3);
    }

    #[test]
    fn ear_clip_handles_a_concave_polygon() {
        // L-shape, CCW.
        let polygon = vec![
            (0.0, 0.0),
            (2.0, 0.0),
            (2.0, 1.0),
            (1.0, 1.0),
            (1.0, 2.0),
            (0.0, 2.0),
        ];
        assert!(signed_area(&polygon) > 0.0);
        let triangles = ear_clip(&polygon);
        assert_eq!(triangles.len(), (6 - 2) * 3);
        // Total triangulated area must equal the polygon area (3.0).
        let mut area = 0.0f32;
        for tri in triangles.chunks_exact(3) {
            let a = polygon[tri[0] as usize];
            let b = polygon[tri[1] as usize];
            let c = polygon[tri[2] as usize];
            area += cross(a, b, c).abs() * 0.5;
        }
        assert!((area - 3.0).abs() < 1e-3, "area {area}");
    }

    /// Position-keyed manifold check: every edge shared by exactly two
    /// triangles (seam-duplicated vertices are merged by quantised position).
    fn assert_manifold(positions: &[f32], indices: &[u32]) {
        let key = |i: u32| -> (i64, i64, i64) {
            let p = &positions[i as usize * 3..i as usize * 3 + 3];
            (
                (p[0] * 1000.0).round() as i64,
                (p[1] * 1000.0).round() as i64,
                (p[2] * 1000.0).round() as i64,
            )
        };
        type QuantisedVertex = (i64, i64, i64);
        let mut edges: std::collections::HashMap<(QuantisedVertex, QuantisedVertex), u32> =
            Default::default();
        for tri in indices.chunks_exact(3) {
            for e in 0..3 {
                let a = key(tri[e]);
                let b = key(tri[(e + 1) % 3]);
                let edge = if a <= b { (a, b) } else { (b, a) };
                *edges.entry(edge).or_insert(0) += 1;
            }
        }
        for (edge, count) in &edges {
            assert_eq!(
                *count, 2,
                "edge {edge:?} shared by {count} triangles (expected 2)"
            );
        }
    }

    #[test]
    fn extrude_of_a_square_is_a_closed_manifold() {
        let bytes = white_square_on_black(128, 24);
        let result = image_to_mesh(&bytes, &MeshOptions::default()).unwrap();
        assert!(result.stats.triangles >= 8, "needs caps and sides");
        assert_eq!(result.positions.len() % 3, 0);
        assert_eq!(result.uvs.len() / 2, result.positions.len() / 3);
        assert!(result
            .indices
            .iter()
            .all(|i| (*i as usize) < result.positions.len() / 3));
        assert_manifold(&result.positions, &result.indices);
        // A square silhouette should simplify to a handful of contour points.
        assert!(
            result.stats.contour_points <= 16,
            "square contour kept {} points",
            result.stats.contour_points
        );
    }

    #[test]
    fn extrude_is_normalised_and_grounded() {
        let bytes = white_square_on_black(128, 24);
        let opts = MeshOptions {
            target_size: 2.0,
            ..MeshOptions::default()
        };
        let result = image_to_mesh(&bytes, &opts).unwrap();
        let mut min = [f32::MAX; 3];
        let mut max = [f32::MIN; 3];
        for chunk in result.positions.chunks_exact(3) {
            for axis in 0..3 {
                min[axis] = min[axis].min(chunk[axis]);
                max[axis] = max[axis].max(chunk[axis]);
            }
        }
        let spans = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        let largest = spans[0].max(spans[1]).max(spans[2]);
        assert!((largest - 2.0).abs() < 1e-3, "max span {largest}");
        assert!(min[1].abs() < 1e-4, "grounded at y=0, got {}", min[1]);
        assert!((min[0] + max[0]).abs() < 1e-3, "centered in x");
        assert!((min[2] + max[2]).abs() < 1e-3, "centered in z");
    }

    #[test]
    fn explicit_depth_is_respected() {
        let bytes = white_square_on_black(128, 24);
        let opts = MeshOptions {
            depth: 0.4,
            target_size: 1.6,
            ..MeshOptions::default()
        };
        let result = image_to_mesh(&bytes, &opts).unwrap();
        let mut min_z = f32::MAX;
        let mut max_z = f32::MIN;
        for chunk in result.positions.chunks_exact(3) {
            min_z = min_z.min(chunk[2]);
            max_z = max_z.max(chunk[2]);
        }
        assert!(
            ((max_z - min_z) - 0.4).abs() < 0.02,
            "depth span {} should be ~0.4",
            max_z - min_z
        );
    }

    #[test]
    fn heightfield_produces_a_grid() {
        let bytes = white_square_on_black(128, 24);
        let opts = MeshOptions {
            mode: MeshMode::Heightfield,
            resolution: 16,
            ..MeshOptions::default()
        };
        let result = image_to_mesh(&bytes, &opts).unwrap();
        assert_eq!(result.positions.len() / 3, 17 * 17);
        assert_eq!(result.indices.len() / 3, 16 * 16 * 2);
        // Interior vertices must be displaced; the exact rim of the bbox may
        // sample outside the mask and stay flat.
        let raised = result
            .positions
            .chunks_exact(3)
            .filter(|c| c[2].abs() > 1e-4)
            .count();
        assert!(raised > 0, "relief must displace interior vertices");
    }

    #[test]
    fn lathe_revolves_a_circle() {
        let bytes = white_circle_on_black(128, 40);
        let opts = MeshOptions {
            mode: MeshMode::Lathe,
            ..MeshOptions::default()
        };
        let result = image_to_mesh(&bytes, &opts).unwrap();
        assert!(result.stats.triangles > LATHE_SEGMENTS as usize * 2);
        // Revolved circle ≈ sphere-ish: x/z spans should match.
        let mut min = [f32::MAX; 3];
        let mut max = [f32::MIN; 3];
        for chunk in result.positions.chunks_exact(3) {
            for axis in 0..3 {
                min[axis] = min[axis].min(chunk[axis]);
                max[axis] = max[axis].max(chunk[axis]);
            }
        }
        let span_x = max[0] - min[0];
        let span_z = max[2] - min[2];
        assert!(
            (span_x - span_z).abs() < 0.05,
            "revolution must be symmetric: x {span_x} z {span_z}"
        );
    }

    #[test]
    fn texture_is_alpha_masked() {
        let bytes = white_square_on_black(128, 24);
        let result = image_to_mesh(&bytes, &MeshOptions::default()).unwrap();
        let tex = image::load_from_memory(&result.texture_png)
            .unwrap()
            .to_rgba8();
        assert_eq!(tex.get_pixel(2, 2).0[3], 0, "background is transparent");
        assert_eq!(tex.get_pixel(64, 64).0[3], 255, "subject is opaque");
    }

    #[test]
    fn admit_rejects_tiny_and_empty_images() {
        let tiny = white_square_on_black(32, 8);
        let admission = admit(&tiny).unwrap();
        assert!(!admission.pass);
        assert!(admission.notes.iter().any(|n| n.contains("resolution")));

        // A featureless flat image: no silhouette, no detail.
        let flat = encode_png(image::RgbImage::from_pixel(
            128,
            128,
            image::Rgb([128, 128, 128]),
        ));
        let admission = admit(&flat).unwrap();
        assert!(!admission.pass);
    }

    #[test]
    fn admit_passes_a_clean_subject() {
        let bytes = white_square_on_black(256, 48);
        let admission = admit(&bytes).unwrap();
        assert!(admission.pass, "notes: {:?}", admission.notes);
        assert!(admission.mask_coverage > 0.2);
        assert!(admission.blur_score > 30.0);
    }

    #[test]
    fn options_parse_from_args() {
        let opts = MeshOptions::from_args(&json!({
            "mode": "lathe", "depth": 0.5, "resolution": 500, "targetSize": 2.0, "threshold": 90
        }))
        .unwrap();
        assert_eq!(opts.mode, MeshMode::Lathe);
        assert!((opts.depth - 0.5).abs() < 1e-6);
        assert_eq!(opts.resolution, 192, "resolution clamps to 192");
        assert_eq!(opts.threshold, Some(90));
        assert!(MeshOptions::from_args(&json!({"mode": "nope"})).is_err());
    }

    #[test]
    fn spec_emission_is_valid() {
        let bytes = white_square_on_black(128, 24);
        let result = image_to_mesh(&bytes, &MeshOptions::default()).unwrap();
        let spec = mesh_to_cali_spec("Crate", "hash123", &result);
        assert_eq!(spec["componentTree"][0]["primitive"], "mesh");
        assert_eq!(spec["materials"][0]["id"], "material-image");
        assert!(spec["materials"][0]["pbr"]["map"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        let validation = crate::image3d::validate_spec(&spec).unwrap();
        assert_eq!(
            validation["valid"], true,
            "errors: {}",
            validation["errors"]
        );
    }
}
