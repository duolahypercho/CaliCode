use crate::config::AppConfig;
use crate::model;
use anyhow::{Context, Result};
#[allow(unused_imports)]
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
    let bytes =
        crate::baselines::decode_image_base64(image_base64).context("invalid image base64")?;
    let img = image::load_from_memory(&bytes).context("unable to decode reference image")?;
    let hash = crate::assets::sha256_bytes(&bytes);
    let id = format!("cali-{}", short_id());
    let dir = crate::store::project_dir(root, slug)?
        .join("assets")
        .join("sources");
    std::fs::create_dir_all(&dir)?;
    // The source is saved even on a failed admission — the agent decides what
    // to do with the notes; ingest never hard-errors on image quality.
    std::fs::write(dir.join(format!("{}.png", id)), &bytes)?;

    let (admission, mut notes, blur_score, mask_coverage) = match crate::image_mesh::admit(&bytes) {
        Ok(check) => {
            let level = if !check.pass {
                "fail"
            } else if check.notes.is_empty() {
                "pass"
            } else {
                "warn"
            };
            (
                level,
                check.notes,
                json!(check.blur_score),
                json!(check.mask_coverage),
            )
        }
        Err(error) => (
            "warn",
            vec![format!("admission heuristics unavailable: {error}")],
            Value::Null,
            Value::Null,
        ),
    };
    notes
        .push("single reference image; hidden geometry is inferred and reported per region".into());
    Ok(json!({
        "assetId": id,
        "name": name,
        "sourceHash": hash,
        "width": img.width(),
        "height": img.height(),
        "admission": admission,
        "blurScore": blur_score,
        "maskCoverage": mask_coverage,
        "notes": notes.join("; ")
    }))
}

pub fn assess(name: &str, source_hash: &str, width: u32, height: u32) -> Value {
    let complexity = if width * height > 1_500_000 {
        "complex"
    } else {
        "moderate"
    };
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
    if spec
        .get("componentTree")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0)
        == 0
    {
        errors.push("componentTree must contain at least one component".into());
    }
    if spec
        .get("materials")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0)
        == 0
    {
        errors.push("materials must contain at least one material".into());
    }
    let components = spec["componentTree"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for component in components {
        let primitive = component["primitive"].as_str().unwrap_or("");
        let topology = component["topologyClass"].as_str().unwrap_or("");
        // Group nodes: no primitive, rendered as a bare Group by the client.
        if primitive.is_empty() {
            if topology != "group" {
                errors.push(format!(
                    "component {} has no primitive; only topologyClass \"group\" nodes may omit it",
                    component["id"]
                ));
            }
            continue;
        }
        if primitive == "mesh" {
            validate_mesh_payload(&component, &mut errors);
            continue;
        }
        if topology == "continuous-sculpt" && ["box", "cylinder", "cone"].contains(&primitive) {
            errors.push(format!(
                "component {} uses primitive {} for continuous-sculpt; use the image3d_mesh tool \
                 (lathe mode) or a mesh primitive with explicit geometry",
                component["id"], primitive
            ));
        }
    }
    let mut warnings: Vec<String> = Vec::new();
    if spec
        .get("reviewHistory")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0)
        < 1
    {
        warnings.push("reviewHistory is empty; run image3d_review after rendering".into());
    }
    let strict_quality = errors.is_empty() && warnings.is_empty();
    Ok(json!({
        "valid": errors.is_empty(),
        "strictQuality": strict_quality,
        "errors": errors,
        "warnings": warnings
    }))
}

/// Structural checks for `primitive: "mesh"` components:
/// positions in xyz triples, indices in range, uvs matching the vertex count.
fn validate_mesh_payload(component: &Value, errors: &mut Vec<String>) {
    let id = &component["id"];
    let Some(mesh) = component.get("mesh").filter(|m| m.is_object()) else {
        errors.push(format!(
            "component {id} uses primitive mesh but has no mesh payload"
        ));
        return;
    };
    let positions_len = mesh["positions"].as_array().map(|a| a.len()).unwrap_or(0);
    if positions_len == 0 || positions_len % 3 != 0 {
        errors.push(format!(
            "component {id} mesh.positions must be a non-empty flat array of xyz triples"
        ));
        return;
    }
    let vertex_count = (positions_len / 3) as u64;
    match mesh["indices"].as_array() {
        Some(indices) if !indices.is_empty() && indices.len() % 3 == 0 => {
            if indices
                .iter()
                .any(|i| i.as_u64().map(|i| i >= vertex_count).unwrap_or(true))
            {
                errors.push(format!(
                    "component {id} mesh.indices reference vertices outside 0..{vertex_count}"
                ));
            }
        }
        _ => errors.push(format!(
            "component {id} mesh.indices must be a non-empty array of triangle index triples"
        )),
    }
    if let Some(uvs) = mesh.get("uvs").and_then(Value::as_array) {
        if uvs.len() as u64 != vertex_count * 2 {
            errors.push(format!(
                "component {id} mesh.uvs length {} does not match {} vertices",
                uvs.len(),
                vertex_count
            ));
        }
    }
}

pub fn generate(root: &Path, slug: &str, spec: Value) -> Result<Value> {
    let asset_id = spec["assetId"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| format!("cali-{}", short_id()));
    let name = spec["targetName"]
        .as_str()
        .unwrap_or("Cali Asset")
        .to_string();
    let source_hash = spec["sourceHash"].as_str().unwrap_or("unknown").to_string();
    let seed = spec["seed"].as_u64().unwrap_or(0) as i64;
    // Echo the spec's schemaVersion verbatim: specs carry either the string
    // "1.0" or the integer 1, and rewriting one into the other made the
    // written .cali.json disagree with the spec that produced it. The
    // validator accepts both forms.
    let schema_version = spec
        .get("schemaVersion")
        .cloned()
        .unwrap_or_else(|| json!(CALI_SCHEMA_VERSION));
    let asset = json!({
        "schemaVersion": schema_version,
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
        // Keep the complete cali payload beside the registry metadata. The
        // browser can reopen a project without rereading a sidecar file, and
        // mesh components retain their real BufferGeometry instead of
        // degrading to the procedural fallback.
        "metadata": {
            "sourceHash": source_hash,
            "schemaVersion": asset["schemaVersion"].clone(),
            "cali": asset.clone()
        }
    }));
    crate::store::write_project(root, slug, &project)?;
    Ok(asset)
}

/// Convert an image (already meshed by `image_mesh::image_to_mesh`) into a
/// registered `.cali` asset. Writes the `.cali.json` and the project registry
/// through the same `generate()` path as spec-authored assets.
pub fn generate_mesh_asset(
    root: &Path,
    slug: &str,
    name: &str,
    source_hash: &str,
    mesh: &crate::image_mesh::MeshResult,
) -> Result<Value> {
    let spec = crate::image_mesh::mesh_to_cali_spec(name, source_hash, mesh);
    let asset = generate(root, slug, spec)?;
    Ok(json!({
        "assetId": asset["assetId"],
        "name": asset["name"],
        "mode": mesh.mode.as_str(),
        "stats": {
            "vertices": mesh.stats.vertices,
            "triangles": mesh.stats.triangles,
            "maskCoverage": mesh.stats.mask_coverage,
            "contourPoints": mesh.stats.contour_points
        },
        "asset": asset
    }))
}

/// Resolve the raw bytes of an image asset the agent points `image3d_mesh` at.
/// Every candidate is checked against the registry/sidecar SHA-256 identity;
/// a filename or the first file in `assets/sources` is never enough.
pub fn load_source_bytes(root: &Path, slug: &str, asset_id: &str) -> Result<Vec<u8>> {
    locate_source_image(root, slug, asset_id)
}

/// Persist an inline image source before a mesh is generated.
///
/// Mesh assets keep their `.cali.json` as the registry source so the live
/// editor can reopen the generated geometry. The reference bytes therefore
/// live in the source cache, keyed by their content hash, rather than as a
/// second project asset. The hash-keyed path makes repeated inline calls
/// idempotent and lets review resolve the exact bytes even when other source
/// files are present.
pub fn register_source_bytes(root: &Path, slug: &str, bytes: &[u8]) -> Result<String> {
    let hash = crate::assets::sha256_bytes(bytes);
    let source_dir = crate::store::project_dir(root, slug)?
        .join("assets")
        .join("sources");
    std::fs::create_dir_all(&source_dir)?;
    let path = source_dir.join(format!("{hash}.png"));

    if path.is_file() {
        let existing = std::fs::read(&path)?;
        let existing_hash = crate::assets::sha256_bytes(&existing);
        if existing_hash != hash {
            anyhow::bail!(
                "source cache collision at {}; expected SHA-256 {hash}, found {existing_hash}",
                path.display()
            );
        }
        return Ok(hash);
    }

    // Commit the source with the same temp-file + rename pattern as project
    // state. A crash cannot leave a hash-keyed file that review might trust.
    let temp_path = source_dir.join(format!(".{hash}.{}.tmp", short_id()));
    std::fs::write(&temp_path, bytes)?;
    if let Err(error) = std::fs::rename(&temp_path, &path) {
        let _ = std::fs::remove_file(&temp_path);
        // Another concurrent mesh call may have committed the same source
        // between the existence check and rename; verify it before failing.
        if path.is_file() {
            let existing = std::fs::read(&path)?;
            let existing_hash = crate::assets::sha256_bytes(&existing);
            if existing_hash == hash {
                return Ok(hash);
            }
        }
        return Err(error.into());
    }
    Ok(hash)
}

pub async fn review(
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
    let source_bytes = locate_source_image(root, slug, asset_id)?;
    let screenshot = crate::baselines::decode_image_base64(screenshot_base64)
        .context("invalid screenshot base64")?;
    // Two cheap deterministic metrics, both of which must pass. The previous
    // gate was dHash alone at 28/64 — ~44% of bits could differ and still
    // pass, which admitted almost anything.
    let dhash = dhash_distance(&source_bytes, &screenshot)?;
    let dhash_threshold = 20u32;
    let luma_mad = luma_mad(&source_bytes, &screenshot)?;
    let luma_threshold = 0.25f64;
    let gate = dhash <= dhash_threshold && luma_mad <= luma_threshold;
    let metrics = json!({
        "dhashDistance": dhash,
        "dhashThreshold": dhash_threshold,
        "lumaMad": luma_mad,
        "lumaMadThreshold": luma_threshold,
        "structureGate": gate
    });
    let mut decision = if gate { "continue" } else { "refine-code" };
    let mut vision: Option<Value> = None;
    if let Some(config) = app_config() {
        let vision_prompt = "You are reviewing a reconstructed 3D game asset. The first image is \
            the reference; the second is a screenshot of the reconstruction. Judge silhouette, \
            proportion, and material fidelity. Reply with a single word: PASS or FAIL.";
        // Attach the actual images as OpenAI-style multimodal content parts.
        // model::chat forwards messages verbatim, so array-form content
        // reaches the provider untouched.
        let reference_b64 = base64::engine::general_purpose::STANDARD.encode(&source_bytes);
        let screenshot_b64 = base64::engine::general_purpose::STANDARD.encode(&screenshot);
        let multimodal = json!({
            "role": "user",
            "content": [
                { "type": "text", "text": vision_prompt },
                { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{reference_b64}") } },
                { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{screenshot_b64}") } }
            ]
        });
        // Providers without vision reject array content with a 4xx. There is
        // no text-only fallback: a model that cannot see the images has no
        // basis to judge them, so asking anyway would rubber-stamp a PASS.
        // The vision pass is skipped (reported as skipped, never as passed)
        // and the deterministic gate's decision stands.
        let attempt = model::chat(&config, &[multimodal], None, None).await;
        let (vision_value, vision_decision) = fold_vision(
            attempt.map(|result| result.content),
            decision,
            &config.model.provider,
            &config.model.default,
        );
        decision = vision_decision;
        vision = Some(vision_value);
    }
    let vision_ran = vision
        .as_ref()
        .is_some_and(|value| value.get("verdict").is_some());
    let review = json!({
        "passId": pass_id,
        "action": decision,
        "fidelity": (1.0 - (dhash as f64 / 64.0).max(luma_mad)).clamp(0.0, 1.0),
        "metrics": metrics,
        "summary": if vision_ran { "deterministic gate plus native vision review evaluated the reconstruction" } else { "deterministic review gate evaluated the rendered screenshot against the source hash" },
        "vision": vision,
        "timestampMs": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()
    });

    let cali_path = crate::store::project_dir(root, slug)?
        .join("assets")
        .join(format!("{}.cali.json", asset_id));
    if cali_path.exists() {
        let mut cali: Value = serde_json::from_str(&std::fs::read_to_string(&cali_path)?)?;
        cali["reviewHistory"]
            .as_array_mut()
            .unwrap()
            .push(review.clone());
        std::fs::write(&cali_path, serde_json::to_string_pretty(&cali)?)?;
    }
    Ok(
        json!({ "review": review, "next": if decision == "continue" { next_pass(pass_id) } else { pass_id } }),
    )
}

fn locate_source_image(root: &Path, slug: &str, asset_id: &str) -> Result<Vec<u8>> {
    let project_dir = crate::store::project_dir(root, slug)?;
    let assets_dir = project_dir.join("assets");
    let source_dir = assets_dir.join("sources");
    let project = crate::store::read_project(root, slug)?;
    let asset = project["assets"]
        .as_array()
        .and_then(|arr| arr.iter().find(|a| a["id"] == asset_id))
        .context("asset not found")?;
    let source_hash = source_hash_for_asset(root, slug, asset_id, asset)?;
    let mut registry_mismatches = Vec::new();

    for path in registry_source_candidates(root, slug, asset)? {
        if !path.is_file() || is_cali_sidecar(&path) {
            continue;
        }
        let bytes = std::fs::read(&path)?;
        let actual_hash = crate::assets::sha256_bytes(&bytes);
        if actual_hash == source_hash {
            return Ok(bytes);
        }
        registry_mismatches.push(format!("{} ({actual_hash})", path.display()));
    }
    if !registry_mismatches.is_empty() {
        anyhow::bail!(
            "source image for asset {asset_id} has a registry-path hash mismatch; expected \
             SHA-256 {source_hash}; {}",
            registry_mismatches.join(", ")
        );
    }

    let direct_candidates = [
        source_dir.join(format!("{asset_id}.png")),
        assets_dir.join(format!("{asset_id}.png")),
    ];
    let mut mismatches = Vec::new();
    for path in direct_candidates {
        if !path.is_file() {
            continue;
        }
        let bytes = std::fs::read(&path)?;
        let actual_hash = crate::assets::sha256_bytes(&bytes);
        if actual_hash == source_hash {
            return Ok(bytes);
        }
        mismatches.push(format!("{} ({actual_hash})", path.display()));
    }

    // Ingested references are stored under opaque asset ids. The directory may
    // contain decoys, so scan it only by computed content hash, never by name.
    if source_dir.is_dir() {
        let mut entries = std::fs::read_dir(&source_dir)?
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_file() && !is_cali_sidecar(path))
            .collect::<Vec<_>>();
        entries.sort();
        for path in entries {
            let bytes = std::fs::read(&path)?;
            let actual_hash = crate::assets::sha256_bytes(&bytes);
            if actual_hash == source_hash {
                return Ok(bytes);
            }
            mismatches.push(format!("{} ({actual_hash})", path.display()));
        }
    }

    let detail = if mismatches.is_empty() {
        "no candidate source file was found".to_string()
    } else {
        format!("candidate hashes did not match: {}", mismatches.join(", "))
    };
    anyhow::bail!(
        "source image for asset {asset_id} is unavailable; expected SHA-256 {source_hash}; {detail}"
    )
}

fn source_hash_for_asset(root: &Path, slug: &str, asset_id: &str, asset: &Value) -> Result<String> {
    if let Some(hash) = declared_source_hash(asset) {
        return Ok(hash.to_string());
    }

    // Older registry entries may omit metadata but still point at an image or
    // a `.cali.json` sidecar. Derive identity from that exact file only; do
    // not guess from an unrelated source in the directory.
    for path in registry_source_candidates(root, slug, asset)? {
        if !path.is_file() {
            continue;
        }
        if is_cali_sidecar(&path) {
            let Ok(sidecar) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(sidecar) = serde_json::from_str::<Value>(&sidecar) else {
                continue;
            };
            if let Some(hash) = declared_source_hash(&sidecar) {
                return Ok(hash.to_string());
            }
        } else {
            return crate::assets::sha256_file(&path);
        }
    }

    anyhow::bail!("asset {asset_id} has no source SHA-256 identity")
}

fn declared_source_hash(value: &Value) -> Option<&str> {
    [
        value.pointer("/metadata/sourceHash"),
        value.pointer("/metadata/cali/sourceHash"),
        value.get("sourceHash"),
        value.pointer("/metadata/sha256"),
    ]
    .into_iter()
    .filter_map(|value| value.and_then(Value::as_str))
    .map(str::trim)
    .find(|hash| !hash.is_empty() && *hash != "unknown")
}

fn registry_source_candidates(
    root: &Path,
    slug: &str,
    asset: &Value,
) -> Result<Vec<std::path::PathBuf>> {
    let project_dir = crate::store::project_dir(root, slug)?;
    let mut paths = Vec::new();
    let mut push_unique = |path| {
        if !paths.contains(&path) {
            paths.push(path);
        }
    };

    if let Some(source) = asset["source"].as_str() {
        if !source.starts_with("procedural:") {
            if let Ok((_, path)) =
                crate::tools::resolve_game_file(root, slug, &format!("assets/{source}"))
            {
                push_unique(path);
            }
            if let Ok(path) = crate::store::safe_join(&project_dir, &format!("assets/{source}")) {
                push_unique(path);
            }
        }
    }
    Ok(paths)
}

fn is_cali_sidecar(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".cali.json"))
}

/// Fold the vision attempt into the review. `Err` means the images could not
/// be attached (or the provider call failed): the pass is reported as skipped
/// — never as a pass — and the deterministic gate's decision stands. Only a
/// verdict from a model that actually saw the images may change the decision.
fn fold_vision(
    attempt: Result<String>,
    gate_decision: &'static str,
    provider: &str,
    model: &str,
) -> (Value, &'static str) {
    match attempt {
        Ok(content) => {
            // Take the FIRST standalone PASS/FAIL token (word-boundary,
            // case-insensitive). Contains-based matching mis-read verbose
            // replies like "PASS — silhouette does not fail" as failures.
            let verdict = content
                .split(|c: char| !c.is_ascii_alphanumeric())
                .find_map(|token| match token.to_ascii_lowercase().as_str() {
                    "pass" => Some("pass"),
                    "fail" => Some("fail"),
                    _ => None,
                });
            match verdict {
                Some(verdict) => {
                    let decision = if verdict == "fail" {
                        "refine-code"
                    } else {
                        "continue"
                    };
                    (
                        json!({
                            "provider": provider,
                            "model": model,
                            "imagesAttached": true,
                            "verdict": verdict,
                            "raw": content
                        }),
                        decision,
                    )
                }
                None => {
                    // Unparseable reply: reported distinctly (like a skip —
                    // no verdict), and the gate's decision stands.
                    tracing::warn!("vision review verdict unparseable; keeping gate decision");
                    (
                        json!({
                            "provider": provider,
                            "model": model,
                            "imagesAttached": true,
                            "skipped": true,
                            "reason": "verdict unparseable: no standalone PASS/FAIL token",
                            "raw": content
                        }),
                        gate_decision,
                    )
                }
            }
        }
        Err(error) => {
            tracing::warn!("vision review skipped (images could not be attached): {error}");
            (
                json!({
                    "skipped": true,
                    "reason": format!("images could not be attached: {error}")
                }),
                gate_decision,
            )
        }
    }
}

fn app_config() -> Option<AppConfig> {
    match crate::config::load() {
        Ok(config) => Some(config),
        Err(error) => {
            tracing::warn!("vision review could not load config: {}", error);
            None
        }
    }
}

fn next_pass(pass_id: &str) -> &'static str {
    let index = PASS_ORDER.iter().position(|p| *p == pass_id).unwrap_or(0);
    PASS_ORDER
        .get(index.saturating_add(1))
        .copied()
        .unwrap_or("complete")
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

/// Mean absolute luma difference on 32x32 thumbnails, normalised to 0..=1.
/// Complements dHash: dHash sees only gradient direction, this sees level.
fn luma_mad(left: &[u8], right: &[u8]) -> Result<f64> {
    const SIZE: u32 = 32;
    let l = image::load_from_memory(left).context("left image invalid")?;
    let r = image::load_from_memory(right).context("right image invalid")?;
    let lg = image::imageops::resize(
        &l.to_luma8(),
        SIZE,
        SIZE,
        image::imageops::FilterType::Triangle,
    );
    let rg = image::imageops::resize(
        &r.to_luma8(),
        SIZE,
        SIZE,
        image::imageops::FilterType::Triangle,
    );
    let mut total: u64 = 0;
    for (a, b) in lg.pixels().zip(rg.pixels()) {
        total += (i32::from(a.0[0]) - i32::from(b.0[0])).unsigned_abs() as u64;
    }
    Ok(total as f64 / (u64::from(SIZE * SIZE) * 255) as f64)
}

// ---------------------------------------------------------------------------
// glTF export with real geometry
// ---------------------------------------------------------------------------

/// Export a cali asset as glTF 2.0 with real embedded geometry.
///
/// Mesh components (`primitive: "mesh"`) become glTF meshes with base64
/// buffers for POSITION / TEXCOORD_0 / indices; other components become named
/// empty nodes (no fabricated geometry or material claims). Replaces the old
/// stub in `assets.rs` that emitted a node and a fake material only.
pub fn export_gltf(root: &Path, slug: &str, asset_id: &str) -> Result<Value> {
    let project = crate::store::read_project(root, slug)?;
    let asset = project["assets"]
        .as_array()
        .and_then(|arr| arr.iter().find(|a| a["id"] == asset_id))
        .context("asset not found")?;
    let asset_name = asset["name"].as_str().unwrap_or(asset_id).to_string();

    // Load the .cali spec when there is one; non-cali assets export a stub.
    let project_dir = crate::store::project_dir(root, slug)?;
    let cali: Option<Value> = asset["source"]
        .as_str()
        .and_then(|source| crate::store::safe_join(&project_dir, &format!("assets/{source}")).ok())
        .filter(|path| path.is_file())
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok());

    let mut buffer: Vec<u8> = Vec::new();
    let mut buffer_views: Vec<Value> = Vec::new();
    let mut accessors: Vec<Value> = Vec::new();
    let mut meshes: Vec<Value> = Vec::new();
    let mut materials: Vec<Value> = Vec::new();
    let mut nodes: Vec<Value> = Vec::new();

    let components = cali
        .as_ref()
        .and_then(|c| c["componentTree"].as_array().cloned())
        .unwrap_or_default();
    let cali_materials = cali
        .as_ref()
        .and_then(|c| c["materials"].as_array().cloned())
        .unwrap_or_default();

    let mut material_index: std::collections::HashMap<String, usize> = Default::default();
    for material in &cali_materials {
        let id = material["id"].as_str().unwrap_or("").to_string();
        let pbr = &material["pbr"];
        let base = hex_to_rgba(pbr["baseColor"].as_str().unwrap_or("#ffffff"));
        material_index.insert(id, materials.len());
        materials.push(json!({
            "name": material["name"].as_str().unwrap_or("Material"),
            "pbrMetallicRoughness": {
                "baseColorFactor": base,
                "metallicFactor": pbr["metalness"].as_f64().unwrap_or(0.0),
                "roughnessFactor": pbr["roughness"].as_f64().unwrap_or(0.8)
            }
        }));
    }

    for component in &components {
        let node_name = component["name"].as_str().unwrap_or("component");
        let translation = component["transform"]["position"].clone();
        let mut node = json!({ "name": node_name });
        if translation.is_array() {
            node["translation"] = translation;
        }
        let mesh = component.get("mesh").filter(|m| m.is_object());
        if component["primitive"].as_str() == Some("mesh") {
            if let Some(mesh_payload) = mesh {
                if let Some(mesh_index) = push_mesh(
                    mesh_payload,
                    node_name,
                    component["materialId"]
                        .as_str()
                        .and_then(|id| material_index.get(id).copied()),
                    &mut buffer,
                    &mut buffer_views,
                    &mut accessors,
                    &mut meshes,
                ) {
                    node["mesh"] = json!(mesh_index);
                }
            }
        }
        nodes.push(node);
    }
    if nodes.is_empty() {
        nodes.push(json!({ "name": asset_name, "translation": [0, 0, 0] }));
    }

    let mut gltf = json!({
        "asset": { "version": "2.0", "generator": "cali-core" },
        "scene": 0,
        "scenes": [{ "nodes": (0..nodes.len()).collect::<Vec<_>>() }],
        "nodes": nodes
    });
    if !materials.is_empty() {
        gltf["materials"] = json!(materials);
    }
    if !meshes.is_empty() {
        gltf["meshes"] = json!(meshes);
        gltf["accessors"] = json!(accessors);
        gltf["bufferViews"] = json!(buffer_views);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&buffer);
        gltf["buffers"] = json!([{
            "byteLength": buffer.len(),
            "uri": format!("data:application/octet-stream;base64,{encoded}")
        }]);
    }

    let dir = project_dir.join("assets");
    std::fs::create_dir_all(&dir)?;
    let file_name = format!("{}.gltf", asset_id);
    std::fs::write(dir.join(&file_name), serde_json::to_string_pretty(&gltf)?)?;
    Ok(json!({ "path": format!("assets/{}", file_name), "gltf": gltf }))
}

/// Append one mesh's data to the shared buffer; returns the mesh index.
fn push_mesh(
    mesh: &Value,
    name: &str,
    material: Option<usize>,
    buffer: &mut Vec<u8>,
    buffer_views: &mut Vec<Value>,
    accessors: &mut Vec<Value>,
    meshes: &mut Vec<Value>,
) -> Option<usize> {
    let positions: Vec<f32> = mesh["positions"]
        .as_array()?
        .iter()
        .map(|v| v.as_f64().unwrap_or(0.0) as f32)
        .collect();
    let indices: Vec<u32> = mesh["indices"]
        .as_array()?
        .iter()
        .map(|v| v.as_u64().unwrap_or(0) as u32)
        .collect();
    if positions.is_empty() || !positions.len().is_multiple_of(3) || indices.is_empty() {
        return None;
    }
    let uvs: Vec<f32> = mesh["uvs"]
        .as_array()
        .map(|a| a.iter().map(|v| v.as_f64().unwrap_or(0.0) as f32).collect())
        .unwrap_or_default();

    let mut min = [f32::MAX; 3];
    let mut max = [f32::MIN; 3];
    for chunk in positions.chunks_exact(3) {
        for axis in 0..3 {
            min[axis] = min[axis].min(chunk[axis]);
            max[axis] = max[axis].max(chunk[axis]);
        }
    }

    // POSITION view + accessor (target 34962 ARRAY_BUFFER).
    let position_accessor = accessors.len();
    let offset = buffer.len();
    for value in &positions {
        buffer.extend_from_slice(&value.to_le_bytes());
    }
    buffer_views.push(json!({
        "buffer": 0, "byteOffset": offset, "byteLength": positions.len() * 4, "target": 34962
    }));
    accessors.push(json!({
        "bufferView": buffer_views.len() - 1, "componentType": 5126,
        "count": positions.len() / 3, "type": "VEC3",
        "min": min, "max": max
    }));

    // TEXCOORD_0 when present and consistent.
    let uv_accessor = if !uvs.is_empty() && uvs.len() / 2 == positions.len() / 3 {
        let offset = buffer.len();
        for value in &uvs {
            buffer.extend_from_slice(&value.to_le_bytes());
        }
        buffer_views.push(json!({
            "buffer": 0, "byteOffset": offset, "byteLength": uvs.len() * 4, "target": 34962
        }));
        accessors.push(json!({
            "bufferView": buffer_views.len() - 1, "componentType": 5126,
            "count": uvs.len() / 2, "type": "VEC2"
        }));
        Some(accessors.len() - 1)
    } else {
        None
    };

    // Indices (target 34963 ELEMENT_ARRAY_BUFFER, u32 = componentType 5125).
    let index_accessor = accessors.len();
    let offset = buffer.len();
    for value in &indices {
        buffer.extend_from_slice(&value.to_le_bytes());
    }
    buffer_views.push(json!({
        "buffer": 0, "byteOffset": offset, "byteLength": indices.len() * 4, "target": 34963
    }));
    accessors.push(json!({
        "bufferView": buffer_views.len() - 1, "componentType": 5125,
        "count": indices.len(), "type": "SCALAR"
    }));

    let mut primitive = json!({
        "attributes": { "POSITION": position_accessor },
        "indices": index_accessor
    });
    if let Some(uv) = uv_accessor {
        primitive["attributes"]["TEXCOORD_0"] = json!(uv);
    }
    if let Some(material) = material {
        primitive["material"] = json!(material);
    }
    meshes.push(json!({ "name": name, "primitives": [primitive] }));
    Some(meshes.len() - 1)
}

fn hex_to_rgba(hex: &str) -> [f64; 4] {
    let hex = hex.trim_start_matches('#');
    if hex.len() != 6 {
        return [1.0, 1.0, 1.0, 1.0];
    }
    let channel = |i: usize| {
        u8::from_str_radix(&hex[i..i + 2], 16)
            .map(|v| (v as f64 / 255.0).powf(2.2)) // sRGB hex -> linear factor
            .unwrap_or(1.0)
    };
    [channel(0), channel(2), channel(4), 1.0]
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
    fn vision_fold_skips_when_images_cannot_attach() {
        // No text-only fallback: a blind model is never asked, the pass is
        // reported as skipped, and the gate's decision survives unchanged.
        let (vision, decision) = fold_vision(
            Err(anyhow::anyhow!("provider rejected image content")),
            "refine-code",
            "prov",
            "model",
        );
        assert_eq!(vision["skipped"], true);
        assert!(vision.get("verdict").is_none(), "skipped is not a verdict");
        assert_eq!(decision, "refine-code");

        // A passing gate is likewise left alone — skipped is not a pass.
        let (vision, decision) =
            fold_vision(Err(anyhow::anyhow!("boom")), "continue", "prov", "model");
        assert_eq!(vision["skipped"], true);
        assert_eq!(decision, "continue");
    }

    #[test]
    fn vision_fold_applies_verdicts_only_from_attached_images() {
        let (vision, decision) = fold_vision(Ok("PASS".into()), "refine-code", "prov", "model");
        assert_eq!(vision["imagesAttached"], true);
        assert_eq!(vision["verdict"], "pass");
        assert_eq!(decision, "continue");

        let (vision, decision) = fold_vision(Ok("FAIL".into()), "continue", "prov", "model");
        assert_eq!(vision["verdict"], "fail");
        assert_eq!(decision, "refine-code");

        // Garbage output leaves the deterministic decision alone and is
        // reported distinctly as skipped, with no verdict.
        let (vision, decision) = fold_vision(Ok("shrug".into()), "refine-code", "prov", "model");
        assert_eq!(decision, "refine-code");
        assert_eq!(vision["skipped"], true);
        assert!(vision.get("verdict").is_none(), "unparsed is not a verdict");
        let (_, decision) = fold_vision(Ok("utter nonsense".into()), "continue", "prov", "model");
        assert_eq!(decision, "continue");
    }

    #[test]
    fn vision_fold_parses_first_standalone_verdict_token() {
        // Verbose replies must key off the first standalone token, not any
        // substring: "PASS — silhouette does not fail" is a pass.
        let (vision, decision) = fold_vision(
            Ok("PASS — silhouette does not fail".into()),
            "refine-code",
            "prov",
            "model",
        );
        assert_eq!(vision["verdict"], "pass");
        assert_eq!(decision, "continue");

        let (vision, decision) = fold_vision(
            Ok("FAIL: proportions are off".into()),
            "continue",
            "prov",
            "model",
        );
        assert_eq!(vision["verdict"], "fail");
        assert_eq!(decision, "refine-code");

        // Embedded substrings ("passable", "failure") are not tokens.
        let (vision, decision) = fold_vision(
            Ok("passable but a failure overall".into()),
            "refine-code",
            "prov",
            "model",
        );
        assert_eq!(vision["skipped"], true);
        assert_eq!(decision, "refine-code");
    }

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
        // schemaVersion is echoed verbatim: spec() emits the string "1.0".
        let asset = generate(root.path(), "demo", spec).unwrap();
        assert_eq!(asset["schemaVersion"], "1.0");
        let asset_id = asset["assetId"].as_str().unwrap();
        let path = crate::store::project_dir(root.path(), "demo")
            .unwrap()
            .join("assets")
            .join(format!("{}.cali.json", asset_id));
        assert!(path.exists());
    }

    #[test]
    fn locate_source_image_finds_source_by_hash() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let mut img = image::RgbImage::new(16, 16);
        for (_, _, p) in img.enumerate_pixels_mut() {
            *p = image::Rgb([90, 140, 60]);
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let png = base64::engine::general_purpose::STANDARD.encode(cursor.into_inner());
        let ingested = ingest(root.path(), "demo", "Vase", &png).unwrap();
        let source_hash = ingested["sourceHash"].as_str().unwrap();
        let mut spec = spec("Vase", source_hash, 1, 1);
        spec["assetId"] = ingested["assetId"].clone();
        let asset = generate(root.path(), "demo", spec).unwrap();
        let found =
            locate_source_image(root.path(), "demo", asset["assetId"].as_str().unwrap()).unwrap();
        assert!(!found.is_empty());
    }

    #[test]
    fn locate_source_image_matches_exact_hash_among_decoys() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let mut img = image::RgbImage::new(16, 16);
        for (_, _, p) in img.enumerate_pixels_mut() {
            *p = image::Rgb([30, 120, 200]);
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let png = base64::engine::general_purpose::STANDARD.encode(cursor.into_inner());
        let ingested = ingest(root.path(), "demo", "Vase", &png).unwrap();
        let source_hash = ingested["sourceHash"].as_str().unwrap();
        let mut spec = spec("Vase", source_hash, 16, 16);
        spec["assetId"] = ingested["assetId"].clone();
        let asset = generate(root.path(), "demo", spec).unwrap();
        let asset_id = asset["assetId"].as_str().unwrap();

        let project_dir = crate::store::project_dir(root.path(), "demo").unwrap();
        let source_dir = project_dir.join("assets").join("sources");
        let exact_path = source_dir.join(format!("{}.png", ingested["assetId"].as_str().unwrap()));
        let retained_exact = source_dir.join("exact-reference.bin");
        std::fs::rename(&exact_path, &retained_exact).unwrap();
        std::fs::write(source_dir.join("decoy.png"), b"not-the-reference").unwrap();

        let found = locate_source_image(root.path(), "demo", asset_id).unwrap();
        assert_eq!(
            found,
            crate::baselines::decode_image_base64(&png).unwrap(),
            "a decoy must not win source lookup"
        );
    }

    #[test]
    fn locate_source_image_rejects_a_mismatched_source_hash() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let png = subject_png(64, 12);
        let ingested = ingest(root.path(), "demo", "Vase", &png).unwrap();
        let mut spec = spec("Vase", ingested["sourceHash"].as_str().unwrap(), 64, 64);
        spec["assetId"] = ingested["assetId"].clone();
        let asset = generate(root.path(), "demo", spec).unwrap();
        let source_path = crate::store::project_dir(root.path(), "demo")
            .unwrap()
            .join("assets")
            .join("sources")
            .join(format!("{}.png", ingested["assetId"].as_str().unwrap()));
        std::fs::write(source_path, b"mutated-reference").unwrap();

        let error = locate_source_image(root.path(), "demo", asset["assetId"].as_str().unwrap())
            .unwrap_err()
            .to_string();
        assert!(error.contains("expected SHA-256"), "{error}");
        assert!(
            error.contains(ingested["sourceHash"].as_str().unwrap()),
            "{error}"
        );
    }

    #[test]
    fn locate_source_image_rejects_missing_source_identity() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let png = subject_png(64, 12);
        let ingested = ingest(root.path(), "demo", "Vase", &png).unwrap();
        let mut spec = spec("Vase", ingested["sourceHash"].as_str().unwrap(), 64, 64);
        spec["assetId"] = ingested["assetId"].clone();
        let asset = generate(root.path(), "demo", spec).unwrap();
        let asset_id = asset["assetId"].as_str().unwrap();

        let project_dir = crate::store::project_dir(root.path(), "demo").unwrap();
        let mut project = crate::store::read_project(root.path(), "demo").unwrap();
        for entry in project["assets"].as_array_mut().unwrap() {
            if entry["id"] == asset_id {
                entry["metadata"]["sourceHash"] = Value::Null;
                entry["metadata"]["cali"]["sourceHash"] = Value::Null;
            }
        }
        crate::store::write_project(root.path(), "demo", &project).unwrap();
        let cali_path = project_dir
            .join("assets")
            .join(format!("{asset_id}.cali.json"));
        let mut cali: Value =
            serde_json::from_str(&std::fs::read_to_string(&cali_path).unwrap()).unwrap();
        cali["sourceHash"] = Value::Null;
        std::fs::write(&cali_path, serde_json::to_string_pretty(&cali).unwrap()).unwrap();

        let error = locate_source_image(root.path(), "demo", asset_id)
            .unwrap_err()
            .to_string();
        assert!(error.contains("no source SHA-256 identity"), "{error}");
    }

    #[test]
    fn locate_source_image_resolves_a_project_asset() {
        // This previously hardcoded /Users/ziwenxu/.cali/projects and an asset
        // id that only existed on one machine, so it passed locally and failed
        // everywhere else — the first thing CI caught once it started running.
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let mut img = image::RgbImage::new(16, 16);
        for (_, _, p) in img.enumerate_pixels_mut() {
            *p = image::Rgb([200, 90, 40]);
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        let png = base64::engine::general_purpose::STANDARD.encode(cursor.into_inner());

        let ingested = ingest(root.path(), "demo", "Probe", &png).unwrap();
        let mut spec = spec("Probe", ingested["sourceHash"].as_str().unwrap(), 16, 16);
        spec["assetId"] = ingested["assetId"].clone();
        let asset = generate(root.path(), "demo", spec).unwrap();

        let found =
            locate_source_image(root.path(), "demo", asset["assetId"].as_str().unwrap()).unwrap();
        assert!(
            !found.is_empty(),
            "the ingested source image must be locatable"
        );
    }

    fn subject_png(size: u32, margin: u32) -> String {
        let mut img = image::RgbImage::new(size, size);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let inside = x >= margin && x < size - margin && y >= margin && y < size - margin;
            *p = if inside {
                image::Rgb([235, 235, 235])
            } else {
                image::Rgb([12, 12, 12])
            };
        }
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        base64::engine::general_purpose::STANDARD.encode(cursor.into_inner())
    }

    #[test]
    fn ingest_gates_admission() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        // Clean subject passes.
        let good = ingest(root.path(), "demo", "Crate", &subject_png(256, 48)).unwrap();
        assert_eq!(good["admission"], "pass", "notes: {}", good["notes"]);
        assert!(good["blurScore"].as_f64().unwrap() > 0.0);
        // Tiny image fails but still ingests (asset id + saved source).
        let bad = ingest(root.path(), "demo", "Tiny", &subject_png(32, 8)).unwrap();
        assert_eq!(bad["admission"], "fail");
        assert!(bad["assetId"].as_str().is_some());
        assert!(bad["notes"].as_str().unwrap().contains("resolution"));
    }

    #[test]
    fn validator_accepts_mesh_and_group_components() {
        let spec = json!({
            "componentTree": [
                { "id": "g", "name": "Group", "topologyClass": "group",
                  "transform": {}, "parent": null },
                { "id": "m", "name": "Mesh", "primitive": "mesh",
                  "mesh": { "positions": [0,0,0, 1,0,0, 0,1,0],
                            "indices": [0,1,2], "uvs": [0,0, 1,0, 0,1] },
                  "parent": "g" }
            ],
            "materials": [{ "id": "mat", "pbr": {} }],
            "reviewHistory": [{}]
        });
        let result = validate_spec(&spec).unwrap();
        assert_eq!(result["valid"], true, "errors: {}", result["errors"]);
    }

    #[test]
    fn validator_rejects_bad_mesh_payloads() {
        let bad_cases = [
            json!({ "id": "m", "primitive": "mesh" }), // no payload
            json!({ "id": "m", "primitive": "mesh",
                    "mesh": { "positions": [0,0], "indices": [0,1,2] } }), // not triples
            json!({ "id": "m", "primitive": "mesh",
                    "mesh": { "positions": [0,0,0, 1,0,0, 0,1,0], "indices": [0,1,9] } }), // oob
            json!({ "id": "m", "primitive": "mesh",
                    "mesh": { "positions": [0,0,0, 1,0,0, 0,1,0],
                              "indices": [0,1,2], "uvs": [0,0] } }), // uv mismatch
            json!({ "id": "m" }),                      // no primitive, not a group
        ];
        for component in bad_cases {
            let spec = json!({
                "componentTree": [component],
                "materials": [{ "id": "mat" }],
                "reviewHistory": [{}]
            });
            let result = validate_spec(&spec).unwrap();
            assert_eq!(result["valid"], false, "spec should fail: {spec}");
        }
    }

    #[test]
    fn validator_warns_on_empty_review_history_without_failing() {
        let spec = json!({
            "componentTree": [{ "id": "g", "topologyClass": "group" }],
            "materials": [{ "id": "mat" }],
            "reviewHistory": []
        });
        let result = validate_spec(&spec).unwrap();
        assert_eq!(result["valid"], true);
        assert_eq!(result["strictQuality"], false);
        assert!(!result["warnings"].as_array().unwrap().is_empty());
    }

    fn png_bytes(rgb: [u8; 3]) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(64, 64, image::Rgb(rgb));
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        cursor.into_inner()
    }

    #[test]
    fn luma_mad_separates_levels_dhash_cannot() {
        // Solid dark vs solid bright: identical gradients (dHash 0) but a
        // huge level difference the MAD metric must catch.
        let dark = png_bytes([20, 20, 20]);
        let bright = png_bytes([230, 230, 230]);
        assert_eq!(dhash_distance(&dark, &bright).unwrap(), 0);
        let mad = luma_mad(&dark, &bright).unwrap();
        assert!(mad > 0.25, "mad {mad} must fail the 0.25 gate");
        assert!(luma_mad(&dark, &dark).unwrap() < 0.01);
    }

    #[test]
    fn mesh_asset_generates_and_exports_real_gltf() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let image = crate::baselines::decode_image_base64(&subject_png(128, 24)).unwrap();
        let mesh =
            crate::image_mesh::image_to_mesh(&image, &crate::image_mesh::MeshOptions::default())
                .unwrap();
        let generated =
            generate_mesh_asset(root.path(), "demo", "Crate", "hash123", &mesh).unwrap();
        let asset_id = generated["assetId"].as_str().unwrap();
        assert!(generated["stats"]["triangles"].as_u64().unwrap() > 0);
        let cali_path = crate::store::project_dir(root.path(), "demo")
            .unwrap()
            .join("assets")
            .join(format!("{asset_id}.cali.json"));
        assert!(cali_path.exists());
        let reopened = crate::store::read_project(root.path(), "demo").unwrap();
        let registry_asset = reopened["assets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == asset_id)
            .expect("generated asset remains in the project registry");
        assert_eq!(registry_asset["metadata"]["cali"]["assetId"], asset_id);
        assert_eq!(
            registry_asset["metadata"]["cali"]["componentTree"][0]["primitive"],
            "mesh"
        );
        assert!(
            registry_asset["metadata"]["cali"]["componentTree"][0]["mesh"]["positions"]
                .as_array()
                .is_some_and(|positions| !positions.is_empty()),
            "reopened registry metadata must retain the generated mesh buffers"
        );

        // Export carries real geometry: buffers, accessors, mesh primitives.
        let exported = export_gltf(root.path(), "demo", asset_id).unwrap();
        let gltf = &exported["gltf"];
        assert_eq!(gltf["asset"]["version"], "2.0");
        assert!(gltf["meshes"].as_array().unwrap().len() == 1);
        assert!(gltf["buffers"][0]["uri"]
            .as_str()
            .unwrap()
            .starts_with("data:application/octet-stream;base64,"));
        let accessor_count = gltf["accessors"].as_array().unwrap().len();
        assert!(accessor_count >= 3, "POSITION + TEXCOORD_0 + indices");
        let primitive = &gltf["meshes"][0]["primitives"][0];
        assert!(primitive["attributes"]["POSITION"].is_number());
        assert!(primitive["attributes"]["TEXCOORD_0"].is_number());
        assert!(primitive["indices"].is_number());
    }

    #[test]
    fn export_gltf_without_mesh_components_stays_a_named_stub() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let spec = spec("Vase", "abc", 64, 64);
        let asset = generate(root.path(), "demo", spec).unwrap();
        let exported =
            export_gltf(root.path(), "demo", asset["assetId"].as_str().unwrap()).unwrap();
        let gltf = &exported["gltf"];
        assert_eq!(gltf["asset"]["version"], "2.0");
        assert!(gltf["meshes"].is_null(), "no fabricated geometry");
        assert!(gltf["nodes"][0]["name"].is_string());
    }

    #[test]
    fn load_source_bytes_resolves_registry_and_ingest_sources() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        // Registry-source path: an imported image asset.
        let png_b64 = subject_png(64, 12);
        let png_bytes = crate::baselines::decode_image_base64(&png_b64).unwrap();
        let imported =
            crate::assets::import_file(root.path(), "demo", "Ref", &png_b64, "image/png", vec![])
                .unwrap();
        let bytes =
            load_source_bytes(root.path(), "demo", imported["id"].as_str().unwrap()).unwrap();
        assert_eq!(bytes, png_bytes);
        // Ingest-source fallback: a cali asset whose source is the spec file.
        let ingested = ingest(root.path(), "demo", "Vase", &png_b64).unwrap();
        let mut vase_spec = spec("Vase", ingested["sourceHash"].as_str().unwrap(), 64, 64);
        vase_spec["assetId"] = ingested["assetId"].clone();
        let asset = generate(root.path(), "demo", vase_spec).unwrap();
        let bytes =
            load_source_bytes(root.path(), "demo", asset["assetId"].as_str().unwrap()).unwrap();
        assert_eq!(bytes, png_bytes);
    }

    #[test]
    fn load_source_bytes_rejects_registry_source_hash_mismatch() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let png_b64 = subject_png(64, 12);
        let imported =
            crate::assets::import_file(root.path(), "demo", "Ref", &png_b64, "image/png", vec![])
                .unwrap();
        let path = crate::store::project_dir(root.path(), "demo")
            .unwrap()
            .join("assets")
            .join(imported["source"].as_str().unwrap());
        std::fs::write(path, b"mutated-reference").unwrap();

        let error = load_source_bytes(root.path(), "demo", imported["id"].as_str().unwrap())
            .unwrap_err()
            .to_string();
        assert!(error.contains("expected SHA-256"), "{error}");
    }
}
