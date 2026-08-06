use anyhow::{Context, Result};
use base64::Engine;
use image::imageops::FilterType;
use image::RgbImage;
use serde_json::{json, Value};
use std::path::Path;

pub fn save_baseline(root: &Path, slug: &str, name: &str, image_base64: &str) -> Result<Value> {
    let bytes = decode_image_base64(image_base64)?;
    let dir = crate::store::project_dir(root, slug)?.join("baselines");
    std::fs::create_dir_all(&dir)?;
    let file_name = format!("{}.png", sanitize_name(name)?);
    std::fs::write(dir.join(&file_name), &bytes)?;
    Ok(json!({ "name": name, "path": format!("baselines/{}", file_name), "bytes": bytes.len() }))
}

pub fn compare_baseline(
    root: &Path,
    slug: &str,
    name: &str,
    image_base64: &str,
    threshold: u32,
) -> Result<Value> {
    let file_name = format!("{}.png", sanitize_name(name)?);
    let path = crate::store::project_dir(root, slug)?
        .join("baselines")
        .join(&file_name);
    if !path.exists() {
        anyhow::bail!("baseline {} not found", name);
    }
    let bytes = decode_image_base64(image_base64)?;
    let (distance, changed) = pixel_distance(&std::fs::read(&path)?, &bytes)?;
    Ok(json!({
        "distance": distance,
        "changedPixelPercent": changed,
        "threshold": threshold,
        "pass": distance <= threshold,
        "baseline": file_name
    }))
}

/// Per-channel RGB comparison at a normalised size.
///
/// This replaces a 64-bit dHash over an 8x8 luma downscale. That hash was
/// colour-blind and coarse enough to be near-useless as a regression gate: a
/// solid red baseline compared against solid blue returned distance 0 and
/// passed at threshold 0. Any material, tint, or small-object regression was
/// invisible to it.
///
/// Returns `(distance, changed_pixel_percent)` where `distance` is the mean
/// absolute per-channel difference scaled to 0..=100.
fn pixel_distance(baseline: &[u8], candidate: &[u8]) -> Result<(u32, u32)> {
    const SIZE: u32 = 64;
    // Anti-aliasing and GPU rasterisation differ by a few levels between runs;
    // only count a pixel as changed once it moves beyond that noise floor.
    const CHANNEL_NOISE: i32 = 8;

    let left = normalise(baseline, SIZE)?;
    let right = normalise(candidate, SIZE)?;

    let mut total: u64 = 0;
    let mut changed: u64 = 0;
    for (a, b) in left.pixels().zip(right.pixels()) {
        let mut worst = 0i32;
        for channel in 0..3 {
            let delta = (i32::from(a.0[channel]) - i32::from(b.0[channel])).abs();
            total += delta as u64;
            worst = worst.max(delta);
        }
        if worst > CHANNEL_NOISE {
            changed += 1;
        }
    }

    let samples = u64::from(SIZE * SIZE);
    let distance = ((total * 100) / (samples * 3 * 255)) as u32;
    let changed_percent = ((changed * 100) / samples) as u32;
    Ok((distance, changed_percent))
}

fn normalise(data: &[u8], size: u32) -> Result<RgbImage> {
    let img = image::load_from_memory(data).context("unable to decode image")?;
    Ok(image::imageops::resize(
        &img.to_rgb8(),
        size,
        size,
        FilterType::Triangle,
    ))
}

/// Validates a baseline name.
///
/// This rejects rather than substitutes: mapping every non-alphanumeric
/// character to `_` meant `hero/idle`, `hero idle`, and `hero-idle` all
/// collided on a single baseline file.
fn sanitize_name(name: &str) -> Result<String> {
    if name.is_empty() || name.len() > 64 {
        anyhow::bail!("invalid baseline name");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        anyhow::bail!("invalid baseline name: use letters, digits, '-' and '_' only");
    }
    Ok(name.to_string())
}

pub(crate) fn decode_image_base64(value: &str) -> Result<Vec<u8>> {
    let clean = value.split(',').next_back().unwrap_or(value).trim();
    base64::engine::general_purpose::STANDARD
        .decode(clean)
        .context("invalid base64")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::create_project;
    use image::{Rgb, RgbImage};

    fn png_base64(kind: &str) -> String {
        let mut img = RgbImage::new(32, 32);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let dark = match kind {
                "vertical" => (x / 4) % 2 == 0,
                "horizontal" => (y / 4) % 2 == 0,
                _ => false,
            };
            *p = if dark {
                Rgb([10, 20, 30])
            } else {
                Rgb([220, 230, 240])
            };
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
    }

    #[test]
    fn identical_baseline_passes() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let png = png_base64("vertical");
        save_baseline(root.path(), "demo", "test", &png).unwrap();
        let result = compare_baseline(root.path(), "demo", "test", &png, 4).unwrap();
        assert_eq!(result["distance"], 0);
        assert_eq!(result["pass"], true);
    }

    #[test]
    fn different_baseline_fails() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        save_baseline(root.path(), "demo", "test", &png_base64("vertical")).unwrap();
        let result =
            compare_baseline(root.path(), "demo", "test", &png_base64("horizontal"), 4).unwrap();
        assert_eq!(result["pass"], false);
    }

    fn solid_png(rgb: [u8; 3]) -> String {
        let mut img = RgbImage::new(32, 32);
        for (_, _, p) in img.enumerate_pixels_mut() {
            *p = Rgb(rgb);
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
    }

    #[test]
    fn detects_a_pure_colour_change() {
        // The previous luma dHash returned distance 0 here and passed at
        // threshold 0 — a total colour inversion read as "no change".
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        save_baseline(root.path(), "demo", "solid", &solid_png([255, 0, 0])).unwrap();

        let result =
            compare_baseline(root.path(), "demo", "solid", &solid_png([0, 0, 255]), 0).unwrap();
        assert_eq!(result["pass"], false, "red vs blue must not pass");
        assert!(result["distance"].as_u64().unwrap() > 0);
        assert_eq!(result["changedPixelPercent"], 100);
    }

    #[test]
    fn detects_a_small_localised_change() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        save_baseline(root.path(), "demo", "spot", &solid_png([20, 20, 20])).unwrap();

        let mut img = RgbImage::new(32, 32);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = if x < 6 && y < 6 {
                Rgb([240, 240, 240])
            } else {
                Rgb([20, 20, 20])
            };
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let candidate = base64::engine::general_purpose::STANDARD.encode(cursor.into_inner());

        let result = compare_baseline(root.path(), "demo", "spot", &candidate, 0).unwrap();
        assert_eq!(
            result["pass"], false,
            "a moved/added object must be visible"
        );
        assert!(result["changedPixelPercent"].as_u64().unwrap() >= 2);
    }

    #[test]
    fn baseline_names_are_rejected_not_rewritten() {
        // "hero/idle", "hero idle" and "hero-idle" used to collide on one file.
        assert!(sanitize_name("hero-idle").is_ok());
        assert!(sanitize_name("hero/idle").is_err());
        assert!(sanitize_name("hero idle").is_err());
        assert!(sanitize_name("../../../../etc/passwd").is_err());
        assert!(sanitize_name("").is_err());
    }
}
