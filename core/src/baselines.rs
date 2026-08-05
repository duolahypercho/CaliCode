use anyhow::{Context, Result};
use base64::Engine;
use image::imageops::FilterType;
use image::GrayImage;
use serde_json::{json, Value};
use std::path::Path;

pub fn save_baseline(root: &Path, slug: &str, name: &str, image_base64: &str) -> Result<Value> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64)
        .context("invalid base64")?;
    let dir = crate::store::project_dir(root, slug)?.join("baselines");
    std::fs::create_dir_all(&dir)?;
    let file_name = format!("{}.png", sanitize_name(name));
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
    let file_name = format!("{}.png", sanitize_name(name));
    let path = crate::store::project_dir(root, slug)?.join("baselines").join(&file_name);
    if !path.exists() {
        anyhow::bail!("baseline {} not found", name);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64)
        .context("invalid base64")?;
    let left = gray_hash(&std::fs::read(&path)?)?;
    let right = gray_hash(&bytes)?;
    let distance = hamming_distance(&left, &right);
    Ok(json!({
        "distance": distance,
        "threshold": threshold,
        "pass": distance <= threshold,
        "baseline": file_name
    }))
}

fn gray_hash(data: &[u8]) -> Result<Vec<u8>> {
    let img = image::load_from_memory(data).context("unable to decode image")?;
    let gray = img.to_luma8();
    let resized: GrayImage = image::imageops::resize(&gray, 9, 8, FilterType::Triangle);
    let mut hash = Vec::with_capacity(64);
    for y in 0..8 {
        for x in 0..8 {
            let left = resized.get_pixel(x, y).0[0];
            let right = resized.get_pixel(x + 1, y).0[0];
            hash.push(if left > right { 1u8 } else { 0u8 });
        }
    }
    Ok(hash)
}

fn hamming_distance(a: &[u8], b: &[u8]) -> u32 {
    a.iter().zip(b).filter(|(x, y)| x != y).count() as u32
}

fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
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
            *p = if dark { Rgb([10, 20, 30]) } else { Rgb([220, 230, 240]) };
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
        let result = compare_baseline(root.path(), "demo", "test", &png_base64("horizontal"), 4).unwrap();
        assert_eq!(result["pass"], false);
    }
}
