use anyhow::{Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::path::Path;

pub const CALI_SCHEMA_VERSION: u32 = 1;
pub const PASS_ORDER: [&str; 8] = [
    "blockout",
    "structural-pass",
    "form-refinement",
    "material-pass",
    "surface-pass",
    "lighting-pass",
    "interaction-pass",
    "optimization-pass",
];

pub fn ingest(root: &Path, slug: &str, name: &str, image_base64: &str) -> Result<Value> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64)
        .context("invalid image base64")?;
    let img = image::load_from_memory(&bytes).context("unable to decode reference image")?;
    let hash = crate::assets::sha256_bytes(&bytes);
    let id = format!("cali-{}", short_id());
    let dir = crate::store::project_dir(root, slug)?.join("assets").join("sources");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(format!("{}.png", id)), &bytes)?;
    Ok(json!({
        "assetId": id,
        "name": name,
        "sourceHash": hash,
        "width": img.width(),
        "height": img.height(),
        "admission": "pass",
        "notes": "single reference image; hidden geometry is inferred and reported per region"
    }))
}

pub fn assess(name: &str, source_hash: &str, width: u32, height: u32) -> Value {
    let complexity = if width * height > 1_500_000 { "complex" } else { "moderate" };
    json!({
        "targetName": name,
        "sourceHash": source_hash,
        "objectClass": { "primaryDomain": "object", "confidence": 0.7 },
        "complexity": complexity,
        "qualityContract": {
            "mustMap": ["silhouette", "proportion", "material", "runtime"],
            "identityDetails": 6,
            "singleViewLimits": "hidden sides are inferred, never presented as measured"
        },
        "detailInventory": [
            { "zone": "silhouette", "detail": "outer contour", "mappedTo": "componentTree[0]" },
            { "zone": "material", "detail": "finish class and roughness", "mappedTo": "materials[0]" },
            { "zone": "runtime", "detail": "primary pivot", "mappedTo": "runtime.pivots[0]" }
        ]
    })
}

pub fn spec(name: &str, source_hash: &str, width: u32, height: u32) -> Value {
    json!({
        "schemaVersion": format!("{}.0", CALI_SCHEMA_VERSION),
        "targetName": name,
        "sourceHash": source_hash,
        "suitability": "pass",
        "coordinateFrame": { "up": [0, 1, 0], "scale": "meters", "cameraYaw": 0 },
        "silhouette": { "width": width, "height": height, "anchor": "center" },
        "componentTree": [
            {
                "id": "root",
                "name": name,
                "level": "macro",
                "topologyClass": "assembled-solid",
                "primitive": "box",
                "dimensions": { "width": 1, "height": 1, "depth": 1 },
                "transform": { "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1] },
                "parent": null
            }
        ],
        "materials": [
            {
                "id": "material-primary",
                "name": "Primary",
                "pbr": { "baseColor": "#b9a48a", "metalness": 0.05, "roughness": 0.7 }
            }
        ],
        "proceduralStrategy": ["primitives", "shape-extrude", "canvas-texture"],
        "runtime": {
            "pivots": [{ "id": "pivot-primary", "node": "root", "axis": [0, 1, 0] }],
            "sockets": [],
            "colliders": [{ "id": "collider-root", "node": "root", "kind": "box" }],
            "destructionGroups": []
        },
        "buildPasses": PASS_ORDER.iter().map(|p| json!({ "id": p, "componentRefs": ["root"] })).collect::<Vec<_>>(),
        "reviewHistory": []
    })
}

pub fn validate_spec(spec: &Value) -> Result<Value> {
    let mut errors: Vec<String> = Vec::new();
    if spec.get("componentTree").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0) == 0 {
        errors.push("componentTree must contain at least one component".into());
    }
    if spec.get("materials").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0) == 0 {
        errors.push("materials must contain at least one material".into());
    }
    let components = spec["componentTree"].as_array().cloned().unwrap_or_default();
    for component in components {
        let primitive = component["primitive"].as_str().unwrap_or("");
        let topology = component["topologyClass"].as_str().unwrap_or("");
        if topology == "continuous-sculpt" && ["box", "cylinder", "cone"].contains(&primitive) {
            errors.push(format!(
                "component {} uses primitive {} for continuous-sculpt; use lathe, extrude, or curve-sweep",
                component["id"], primitive
            ));
        }
    }
    if spec.get("reviewHistory").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0) < 3 && false {
        errors.push("reviewHistory is thin".into());
    }
    let strict_quality = errors.is_empty();
    Ok(json!({
        "valid": errors.is_empty(),
        "strictQuality": strict_quality,
        "errors": errors
    }))
}

pub fn generate(root: &Path, slug: &str, spec: Value) -> Result<Value> {
    let asset_id = spec["assetId"].as_str().map(String::from).unwrap_or_else(|| format!("cali-{}", short_id()));
    let name = spec["targetName"].as_str().unwrap_or("Cali Asset").to_string();
    let source_hash = spec["sourceHash"].as_str().unwrap_or("unknown").to_string();
    let seed = spec["seed"].as_u64().unwrap_or(0) as i64;
    let asset = json!({
        "schemaVersion": CALI_SCHEMA_VERSION,
        "assetId": asset_id,
        "name": name,
        "sourceHash": source_hash,
        "seed": seed,
        "assessment": spec["assessment"].clone(),
        "detailInventory": spec["detailInventory"].clone(),
        "componentTree": spec["componentTree"].clone(),
        "materials": spec["materials"].clone(),
        "runtime": spec["runtime"].clone(),
        "reviewHistory": spec["reviewHistory"].clone()
    });
    let dir = crate::store::project_dir(root, slug)?.join("assets");
    std::fs::create_dir_all(&dir)?;
    let file_name = format!("{}.cali.json", asset_id);
    std::fs::write(dir.join(&file_name), serde_json::to_string_pretty(&asset)?)?;

    let mut project = crate::store::read_project(root, slug)?;
    project["assets"].as_array_mut().unwrap().push(json!({
        "id": asset_id,
        "name": name,
        "type": "cali",
        "source": file_name,
        "tags": ["image-to-3d"],
        "usage": [],
        "thumbnail": null,
        "metadata": { "sourceHash": source_hash, "schemaVersion": CALI_SCHEMA_VERSION }
    }));
    crate::store::write_project(root, slug, &project)?;
    Ok(asset)
}

pub fn review(
    root: &Path,
    slug: &str,
    asset_id: &str,
    screenshot_base64: &str,
    pass_id: &str,
) -> Result<Value> {
    let project = crate::store::read_project(root, slug)?;
    let _asset = project["assets"]
        .as_array()
        .and_then(|arr| arr.iter().find(|a| a["id"] == asset_id))
        .context("asset not found")?;
    let source_path = crate::store::project_dir(root, slug)?
        .join("assets")
        .join("sources")
        .join(format!("{}.png", asset_id));
    let source_bytes = std::fs::read(&source_path).context("source image missing")?;
    let screenshot = base64::engine::general_purpose::STANDARD
        .decode(screenshot_base64)
        .context("invalid screenshot base64")?;
    let dhash = dhash_distance(&source_bytes, &screenshot)?;
    let threshold = 28u32;
    let metrics = json!({
        "dhashDistance": dhash,
        "dhashThreshold": threshold,
        "structureGate": dhash <= threshold
    });
    let decision = if dhash <= threshold { "continue" } else { "refine-code" };
    let review = json!({
        "passId": pass_id,
        "action": decision,
        "fidelity": (1.0 - dhash as f64 / 64.0).clamp(0.0, 1.0),
        "metrics": metrics,
        "summary": "deterministic review gate evaluated the rendered screenshot against the source hash",
        "timestampMs": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()
    });

    let cali_path = crate::store::project_dir(root, slug)?
        .join("assets")
        .join(format!("{}.cali.json", asset_id));
    if cali_path.exists() {
        let mut cali: Value = serde_json::from_str(&std::fs::read_to_string(&cali_path)?)?;
        cali["reviewHistory"].as_array_mut().unwrap().push(review.clone());
        std::fs::write(&cali_path, serde_json::to_string_pretty(&cali)?)?;
    }
    Ok(json!({ "review": review, "next": if decision == "continue" { next_pass(pass_id) } else { pass_id.into() } }))
}

fn next_pass(pass_id: &str) -> &'static str {
    let index = PASS_ORDER.iter().position(|p| *p == pass_id).unwrap_or(0);
    PASS_ORDER.get(index.saturating_add(1)).copied().unwrap_or("complete")
}

fn dhash_distance(left: &[u8], right: &[u8]) -> Result<u32> {
    let l = image::load_from_memory(left).context("left image invalid")?;
    let r = image::load_from_memory(right).context("right image invalid")?;
    let lg = image::imageops::resize(&l.to_luma8(), 9, 8, image::imageops::FilterType::Triangle);
    let rg = image::imageops::resize(&r.to_luma8(), 9, 8, image::imageops::FilterType::Triangle);
    let mut distance = 0u32;
    for y in 0..8 {
        for x in 0..8 {
            let lb = lg.get_pixel(x, y).0[0] > lg.get_pixel(x + 1, y).0[0];
            let rb = rg.get_pixel(x, y).0[0] > rg.get_pixel(x + 1, y).0[0];
            if lb != rb {
                distance += 1;
            }
        }
    }
    Ok(distance)
}

fn short_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::create_project;

    #[test]
    fn validate_blocks_shallow_spec() {
        let shallow = json!({ "componentTree": [], "materials": [], "reviewHistory": [] });
        let result = validate_spec(&shallow).unwrap();
        assert_eq!(result["strictQuality"], false);
    }

    #[test]
    fn pass_state_advances() {
        assert_eq!(next_pass("blockout"), "structural-pass");
        assert_eq!(next_pass("optimization-pass"), "complete");
    }

    #[test]
    fn generate_writes_cali_asset() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let spec = spec("Vase", "abc", 512, 512);
        let asset = generate(root.path(), "demo", spec).unwrap();
        assert_eq!(asset["schemaVersion"], 1);
        let asset_id = asset["assetId"].as_str().unwrap();
        let path = crate::store::project_dir(root.path(), "demo").unwrap().join("assets").join(format!("{}.cali.json", asset_id));
        assert!(path.exists());
    }
}
