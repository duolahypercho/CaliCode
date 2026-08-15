//! Asset search and pick across three sources:
//!
//! - `local`: the project's own registry (`project.json` `assets[]` plus the
//!   `.cali.json` component/material names for cali assets);
//! - `library`: the client-published asset-repo catalogue (pushed via the
//!   `asset_catalog_publish` RPC, held in `AppState.asset_catalog`);
//! - `polyhaven`: PolyHaven's free keyless CC0 catalogue
//!   (<https://api.polyhaven.com>), models downloadable as glTF.
//!
//! Network access is isolated behind the [`Fetch`] trait so tests never touch
//! the network; the PolyHaven asset list is cached in-process for 15 minutes.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const POLYHAVEN_API: &str = "https://api.polyhaven.com";
const POLYHAVEN_CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const POLYHAVEN_TIMEOUT: Duration = Duration::from_secs(10);
/// Total download cap for one polyhaven pick (gltf + bin + textures).
const POLYHAVEN_MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const DEFAULT_SOURCES: [&str; 3] = ["local", "library", "polyhaven"];

// ---------------------------------------------------------------------------
// Fetch abstraction (prod = reqwest; tests = stub)
// ---------------------------------------------------------------------------

#[async_trait::async_trait]
pub trait Fetch: Send + Sync {
    async fn get_json(&self, url: &str) -> Result<Value>;
    async fn get_bytes(&self, url: &str) -> Result<Vec<u8>>;
}

pub struct HttpFetch;

#[async_trait::async_trait]
impl Fetch for HttpFetch {
    async fn get_json(&self, url: &str) -> Result<Value> {
        let client = reqwest::Client::builder()
            .timeout(POLYHAVEN_TIMEOUT)
            .build()?;
        let response = client
            .get(url)
            .send()
            .await
            .with_context(|| format!("GET {url} failed"))?;
        if !response.status().is_success() {
            anyhow::bail!("GET {url} returned {}", response.status());
        }
        Ok(response.json().await?)
    }

    async fn get_bytes(&self, url: &str) -> Result<Vec<u8>> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()?;
        let response = client
            .get(url)
            .send()
            .await
            .with_context(|| format!("GET {url} failed"))?;
        if !response.status().is_success() {
            anyhow::bail!("GET {url} returned {}", response.status());
        }
        Ok(response.bytes().await?.to_vec())
    }
}

// ---------------------------------------------------------------------------
// Query / scoring (pure)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Query {
    tokens: Vec<String>,
}

impl Query {
    pub fn parse(query: &str) -> Self {
        let tokens = query
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| !t.is_empty())
            .map(String::from)
            .collect();
        Self { tokens }
    }

    /// Lowercase token match over the haystack. Score = matched-token ratio
    /// with a +0.25-weighted whole-word bonus, clamped to 1.0. Returns `None`
    /// when no token matches (or the query has no tokens).
    pub fn score(&self, haystack: &str) -> Option<f64> {
        if self.tokens.is_empty() {
            return None;
        }
        let lower = haystack.to_lowercase();
        let words: Vec<&str> = lower
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .collect();
        let mut matched = 0usize;
        let mut whole = 0usize;
        for token in &self.tokens {
            if words.iter().any(|w| w == token) {
                matched += 1;
                whole += 1;
            } else if lower.contains(token.as_str()) {
                matched += 1;
            }
        }
        if matched == 0 {
            return None;
        }
        // Normalised by the best possible score so a full whole-word match is
        // exactly 1.0 and substring-only matches always rank below it.
        let total = self.tokens.len() as f64;
        let score = (matched as f64 + 0.25 * whole as f64) / (total * 1.25);
        Some(score)
    }
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/// Search across sources. `catalog` is the published library catalogue
/// (a clone of `AppState.asset_catalog`). `slug` is required for local hits;
/// when absent the local source is skipped and noted.
///
/// Result: `{ results: [hit...], sources: { local, library, polyhaven }, .. }`
/// where every hit is
/// `{ source, id, name, type, score, tags, detail, pick: {source, id} }`.
pub async fn search(
    catalog: &[Value],
    root: &Path,
    slug: Option<&str>,
    query: &str,
    sources: &[String],
    types: &[String],
    limit: usize,
) -> Result<Value> {
    search_with(
        &HttpFetch, catalog, root, slug, query, sources, types, limit, true,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn search_with<F: Fetch>(
    fetcher: &F,
    catalog: &[Value],
    root: &Path,
    slug: Option<&str>,
    query: &str,
    sources: &[String],
    types: &[String],
    limit: usize,
    use_cache: bool,
) -> Result<Value> {
    let limit = limit.clamp(1, 50);
    let q = Query::parse(query);
    let want = |source: &str| sources.iter().any(|s| s == source);

    let mut hits: Vec<Value> = Vec::new();
    let mut counts = serde_json::Map::new();
    let mut polyhaven_error: Option<String> = None;
    let mut local_note: Option<String> = None;

    if want("local") {
        match slug {
            Some(slug) => {
                let local = search_local(root, slug, &q, types)?;
                counts.insert("local".into(), json!(local.len()));
                hits.extend(local);
            }
            None => {
                counts.insert("local".into(), json!(0));
                local_note = Some("local search skipped: no slug provided".into());
            }
        }
    }
    if want("library") {
        let installed = installed_repos(root, slug);
        let library = search_library(catalog, &installed, &q, types);
        counts.insert("library".into(), json!(library.len()));
        hits.extend(library);
    }
    if want("polyhaven") {
        match search_polyhaven(fetcher, &q, types, use_cache).await {
            Ok(ph) => {
                counts.insert("polyhaven".into(), json!(ph.len()));
                hits.extend(ph);
            }
            Err(error) => {
                counts.insert("polyhaven".into(), json!(0));
                polyhaven_error = Some(error.to_string());
            }
        }
    }

    hits.sort_by(|a, b| {
        b["score"]
            .as_f64()
            .unwrap_or(0.0)
            .partial_cmp(&a["score"].as_f64().unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(limit);

    let mut result = json!({ "results": hits, "sources": counts });
    if let Some(error) = polyhaven_error {
        result["polyhavenError"] = json!(error);
    }
    if let Some(note) = local_note {
        result["note"] = json!(note);
    }
    Ok(result)
}

fn type_allowed(types: &[String], asset_type: &str) -> bool {
    types.is_empty() || types.iter().any(|t| t == asset_type)
}

fn json_str_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn search_local(root: &Path, slug: &str, q: &Query, types: &[String]) -> Result<Vec<Value>> {
    let project = crate::store::read_project(root, slug)?;
    let project_dir = crate::store::project_dir(root, slug)?;
    let mut hits = Vec::new();
    for asset in project["assets"].as_array().cloned().unwrap_or_default() {
        let asset_type = asset["type"].as_str().unwrap_or("procedural");
        if !type_allowed(types, asset_type) {
            continue;
        }
        let name = asset["name"].as_str().unwrap_or("");
        let tags = json_str_list(&asset["tags"]);
        let mut haystack = format!("{} {} {}", name, tags.join(" "), asset_type);
        // Cali assets: include component and material names from the spec.
        if asset_type == "cali" {
            if let Some(source) = asset["source"].as_str() {
                if let Ok(path) = crate::store::safe_join(&project_dir, &format!("assets/{source}"))
                {
                    if let Ok(text) = std::fs::read_to_string(path) {
                        if let Ok(cali) = serde_json::from_str::<Value>(&text) {
                            for component in cali["componentTree"].as_array().into_iter().flatten()
                            {
                                if let Some(n) = component["name"].as_str() {
                                    haystack.push(' ');
                                    haystack.push_str(n);
                                }
                            }
                            for material in cali["materials"].as_array().into_iter().flatten() {
                                if let Some(n) = material["name"].as_str() {
                                    haystack.push(' ');
                                    haystack.push_str(n);
                                }
                            }
                        }
                    }
                }
            }
        }
        let Some(score) = q.score(&haystack) else {
            continue;
        };
        let id = asset["id"].as_str().unwrap_or("");
        hits.push(json!({
            "source": "local",
            "id": id,
            "name": name,
            "type": asset_type,
            "score": round3(score),
            "tags": tags,
            "detail": { "source": asset["source"], "usage": asset["usage"] },
            "pick": { "source": "local", "id": id }
        }));
    }
    Ok(hits)
}

/// What this game has installed, repo id -> attachment. Empty when there is no
/// project in context, which correctly leaves every catalogue entry uninstalled.
fn installed_repos(root: &Path, slug: Option<&str>) -> serde_json::Map<String, Value> {
    let Some(slug) = slug else {
        return serde_json::Map::new();
    };
    let Ok(project) = crate::store::read_project(root, slug) else {
        return serde_json::Map::new();
    };
    project["settings"]["assetRepos"]
        .as_object()
        .cloned()
        .unwrap_or_default()
}

/// The catalogue is a storefront: every game can *see* every repo, but only one
/// it has installed carries a usable `url`. Repos are metadata-only pointers, so
/// the url is the actionable payload — handing it out for an uninstalled repo
/// would let the agent build against something this project never took on.
fn search_library(
    catalog: &[Value],
    installed: &serde_json::Map<String, Value>,
    q: &Query,
    types: &[String],
) -> Vec<Value> {
    let mut hits = Vec::new();
    for entry in catalog {
        let category = entry["category"].as_str().unwrap_or("");
        if !types.is_empty() && !types.iter().any(|t| t == category) {
            continue;
        }
        let name = entry["name"].as_str().unwrap_or("");
        let description = entry["description"].as_str().unwrap_or("");
        let tags = json_str_list(&entry["tags"]);
        let haystack = format!("{} {} {} {}", name, description, tags.join(" "), category);
        let Some(score) = q.score(&haystack) else {
            continue;
        };
        let id = entry["id"].as_str().unwrap_or("");
        let attachment = installed.get(id);
        let mut detail = json!({
            "license": entry["license"],
            "description": description,
            "settings": entry["settings"]
        });
        if let Some(attachment) = attachment {
            detail["url"] = entry["url"].clone();
            // This game's tuned values. Reporting the catalogue defaults here
            // would misdescribe every project that changed one.
            detail["currentSettings"] = attachment
                .get("settings")
                .cloned()
                .unwrap_or_else(|| json!({}));
        }
        let mut hit = json!({
            "source": "library",
            "id": id,
            "name": name,
            "type": category,
            "score": round3(score),
            "tags": tags,
            "installed": attachment.is_some(),
            "detail": detail,
            "pick": { "source": "library", "id": id }
        });
        if attachment.is_none() {
            hit["hint"] = json!(format!(
                "not installed in this game; asset_pick source=library id={id} installs it and returns the url"
            ));
        }
        hits.push(hit);
    }
    hits
}

/// Map requested types to PolyHaven list types. Defaults to models only.
fn polyhaven_types(types: &[String]) -> Vec<&'static str> {
    if types.is_empty() {
        return vec!["models"];
    }
    let mut out: Vec<&'static str> = Vec::new();
    for t in types {
        let mapped = match t.as_str() {
            "model" | "gltf" => Some("models"),
            "texture" => Some("textures"),
            "hdri" => Some("hdris"),
            _ => None,
        };
        if let Some(mapped) = mapped {
            if !out.contains(&mapped) {
                out.push(mapped);
            }
        }
    }
    out
}

fn polyhaven_cache() -> &'static Mutex<HashMap<String, (Instant, Value)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Value)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn polyhaven_list<F: Fetch>(fetcher: &F, list_type: &str, use_cache: bool) -> Result<Value> {
    if use_cache {
        if let Ok(cache) = polyhaven_cache().lock() {
            if let Some((at, value)) = cache.get(list_type) {
                if at.elapsed() < POLYHAVEN_CACHE_TTL {
                    return Ok(value.clone());
                }
            }
        }
    }
    let url = format!("{POLYHAVEN_API}/assets?t={list_type}");
    let value = tokio::time::timeout(POLYHAVEN_TIMEOUT, fetcher.get_json(&url))
        .await
        .map_err(|_| anyhow::anyhow!("polyhaven list request timed out"))??;
    if use_cache {
        if let Ok(mut cache) = polyhaven_cache().lock() {
            cache.insert(list_type.to_string(), (Instant::now(), value.clone()));
        }
    }
    Ok(value)
}

async fn search_polyhaven<F: Fetch>(
    fetcher: &F,
    q: &Query,
    types: &[String],
    use_cache: bool,
) -> Result<Vec<Value>> {
    let mut hits = Vec::new();
    for list_type in polyhaven_types(types) {
        let hit_type = match list_type {
            "textures" => "texture",
            "hdris" => "hdri",
            _ => "model",
        };
        let list = polyhaven_list(fetcher, list_type, use_cache).await?;
        let Some(entries) = list.as_object() else {
            continue;
        };
        for (id, entry) in entries {
            let name = entry["name"].as_str().unwrap_or(id);
            let categories = json_str_list(&entry["categories"]);
            let tags = json_str_list(&entry["tags"]);
            let haystack = format!(
                "{} {} {} {}",
                name,
                id.replace('_', " "),
                categories.join(" "),
                tags.join(" ")
            );
            let Some(score) = q.score(&haystack) else {
                continue;
            };
            hits.push(json!({
                "source": "polyhaven",
                "id": id,
                "name": name,
                "type": hit_type,
                "score": round3(score),
                "tags": tags,
                "detail": {
                    "categories": categories,
                    "downloadCount": entry["download_count"],
                    "license": "CC0-1.0"
                },
                "pick": { "source": "polyhaven", "id": id }
            }));
        }
    }
    Ok(hits)
}

// ---------------------------------------------------------------------------
// pick
// ---------------------------------------------------------------------------

/// Import a picked hit into the project. Returns the registered asset entry
/// (`local`), the attach record (`library`), or the new registry entry with
/// download stats (`polyhaven`).
pub async fn pick(
    catalog: &[Value],
    root: &Path,
    slug: &str,
    source: &str,
    id: &str,
    name: Option<&str>,
    options: &Value,
) -> Result<Value> {
    pick_with(&HttpFetch, catalog, root, slug, source, id, name, options).await
}

#[allow(clippy::too_many_arguments)]
pub async fn pick_with<F: Fetch>(
    fetcher: &F,
    catalog: &[Value],
    root: &Path,
    slug: &str,
    source: &str,
    id: &str,
    name: Option<&str>,
    options: &Value,
) -> Result<Value> {
    match source {
        "local" => pick_local(root, slug, id),
        "library" => pick_library(catalog, root, slug, id),
        "polyhaven" => pick_polyhaven(fetcher, root, slug, id, name, options).await,
        other => anyhow::bail!("unknown pick source {other}; use local, library, polyhaven"),
    }
}

/// Local assets already live in the project: idempotent no-op returning the
/// existing registry entry.
fn pick_local(root: &Path, slug: &str, id: &str) -> Result<Value> {
    let project = crate::store::read_project(root, slug)?;
    let asset = project["assets"]
        .as_array()
        .and_then(|arr| arr.iter().find(|a| a["id"] == id))
        .with_context(|| format!("asset {id} not found in project {slug}"))?;
    Ok(json!({ "attached": false, "alreadyPresent": true, "asset": asset }))
}

/// Core-side mirror of the client's `attachRepo`: seed defaults from the
/// published settings schema, no-op when already attached, error on unknown id.
fn pick_library(catalog: &[Value], root: &Path, slug: &str, id: &str) -> Result<Value> {
    let entry = catalog
        .iter()
        .find(|e| e["id"] == id)
        .with_context(|| format!("library repo {id} not in the published catalogue"))?;
    let mut defaults = serde_json::Map::new();
    for setting in entry["settings"].as_array().into_iter().flatten() {
        if let Some(key) = setting["key"].as_str() {
            defaults.insert(key.to_string(), setting["default"].clone());
        }
    }
    let mut project = crate::store::read_project(root, slug)?;
    if !project["settings"].is_object() {
        project["settings"] = json!({});
    }
    if !project["settings"]["assetRepos"].is_object() {
        project["settings"]["assetRepos"] = json!({});
    }
    let repos = project["settings"]["assetRepos"].as_object_mut().unwrap();
    if let Some(existing) = repos.get(id) {
        let settings = existing["settings"].clone();
        return Ok(
            json!({ "attached": false, "alreadyPresent": true, "repoId": id, "settings": settings }),
        );
    }
    repos.insert(id.to_string(), json!({ "settings": defaults }));
    let settings = repos[id]["settings"].clone();
    crate::store::write_project(root, slug, &project)?;
    Ok(json!({ "attached": true, "repoId": id, "settings": settings }))
}

async fn pick_polyhaven<F: Fetch>(
    fetcher: &F,
    root: &Path,
    slug: &str,
    id: &str,
    name: Option<&str>,
    options: &Value,
) -> Result<Value> {
    let resolution = options
        .get("resolution")
        .and_then(Value::as_str)
        .unwrap_or("1k");
    let files_url = format!("{POLYHAVEN_API}/files/{id}");
    let files = tokio::time::timeout(POLYHAVEN_TIMEOUT, fetcher.get_json(&files_url))
        .await
        .map_err(|_| anyhow::anyhow!("polyhaven files request timed out"))??;
    let gltf_group = files
        .get("gltf")
        .and_then(Value::as_object)
        .with_context(|| format!("polyhaven asset {id} has no glTF download"))?;
    let entry = gltf_group
        .get(resolution)
        .or_else(|| gltf_group.values().next())
        .with_context(|| format!("polyhaven asset {id} has no glTF files"))?;
    // Shape: { url, size, include: { "relative/path": { url, size } } }.
    let main_url = entry["url"]
        .as_str()
        .with_context(|| format!("polyhaven glTF entry for {id} has no url"))?;
    let main_name = main_url
        .rsplit('/')
        .next()
        .unwrap_or("model.gltf")
        .to_string();

    // Pre-check declared sizes against the cap.
    let mut declared: u64 = entry["size"].as_u64().unwrap_or(0);
    let mut downloads: Vec<(String, String)> = vec![(main_name.clone(), main_url.to_string())];
    for (rel, file) in entry["include"].as_object().into_iter().flatten() {
        declared += file["size"].as_u64().unwrap_or(0);
        let url = file["url"]
            .as_str()
            .with_context(|| format!("include entry {rel} has no url"))?;
        downloads.push((rel.clone(), url.to_string()));
    }
    if declared > POLYHAVEN_MAX_BYTES {
        anyhow::bail!(
            "polyhaven download for {id} at {resolution} is {declared} bytes; cap is {POLYHAVEN_MAX_BYTES}. Try a lower resolution."
        );
    }

    let dest = crate::store::project_dir(root, slug)?
        .join("assets")
        .join("polyhaven")
        .join(sanitize_component(id)?);
    std::fs::create_dir_all(&dest)?;

    let mut total: u64 = 0;
    for (rel, url) in &downloads {
        // `include` keys are attacker-controllable relative paths; resolve
        // through safe_join so `../` can never escape the asset directory.
        let path = crate::store::safe_join(&dest, rel)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = fetcher.get_bytes(url).await?;
        total += bytes.len() as u64;
        if total > POLYHAVEN_MAX_BYTES {
            anyhow::bail!(
                "polyhaven download for {id} exceeded the {POLYHAVEN_MAX_BYTES}-byte cap"
            );
        }
        std::fs::write(&path, &bytes)?;
    }

    let display_name = name.map(String::from).unwrap_or_else(|| {
        id.replace('_', " ")
            .split_whitespace()
            .map(|w| {
                let mut chars = w.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    });
    let mut tags: Vec<String> = vec!["polyhaven".into()];
    tags.extend(json_str_list(&options["tags"]));
    let asset_id = format!("asset-{}", short_id());
    let registry_entry = json!({
        "id": asset_id,
        "name": display_name,
        "type": "gltf",
        "source": format!("polyhaven/{}/{}", id, main_name),
        "tags": tags,
        "usage": [],
        "thumbnail": null,
        "metadata": {
            "polyhavenId": id,
            "license": "CC0-1.0",
            "resolution": resolution,
            "bytes": total,
            "files": downloads.len()
        }
    });
    let mut project = crate::store::read_project(root, slug)?;
    project["assets"]
        .as_array_mut()
        .context("project has no assets array")?
        .push(registry_entry.clone());
    crate::store::write_project(root, slug, &project)?;
    Ok(registry_entry)
}

/// A single path component: no separators, no traversal.
fn sanitize_component(value: &str) -> Result<String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        anyhow::bail!("invalid asset id {value}");
    }
    Ok(value.to_string())
}

/// Validate an `asset_catalog_publish` payload into the stored entry list.
/// Whole-set replacement semantics; entries must be objects with a string id.
pub fn normalize_catalog_entries(entries: &Value) -> Result<Vec<Value>> {
    let list = entries
        .as_array()
        .context("entries must be an array of catalogue objects")?;
    let mut out = Vec::with_capacity(list.len());
    for entry in list {
        if !entry.is_object() || entry["id"].as_str().map(str::is_empty).unwrap_or(true) {
            anyhow::bail!("every catalogue entry needs a non-empty string id");
        }
        out.push(entry.clone());
    }
    Ok(out)
}

fn short_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", now)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::create_project;
    use std::collections::HashMap as Map;

    struct StubFetch {
        json: Map<String, Value>,
        bytes: Map<String, Vec<u8>>,
    }

    #[async_trait::async_trait]
    impl Fetch for StubFetch {
        async fn get_json(&self, url: &str) -> Result<Value> {
            self.json
                .get(url)
                .cloned()
                .with_context(|| format!("stub has no json for {url}"))
        }
        async fn get_bytes(&self, url: &str) -> Result<Vec<u8>> {
            self.bytes
                .get(url)
                .cloned()
                .with_context(|| format!("stub has no bytes for {url}"))
        }
    }

    #[test]
    fn scoring_rewards_whole_words() {
        let q = Query::parse("wooden barrel");
        let whole = q.score("Wooden Barrel prop").unwrap();
        let partial = q.score("barrels of woodenness").unwrap();
        assert!(whole > partial, "whole {whole} vs partial {partial}");
        assert!(q.score("space station").is_none());
        assert!(Query::parse("").score("anything").is_none());
    }

    #[test]
    fn scoring_is_case_insensitive_and_partial() {
        let q = Query::parse("BARREL");
        assert!(q.score("old barrel").is_some());
        let half = Query::parse("wooden spaceship")
            .score("wooden chair")
            .unwrap();
        assert!(half > 0.4 && half < 0.9, "half match scored {half}");
    }

    fn seed_project(root: &Path) {
        create_project(root, "demo", "Demo").unwrap();
        let mut project = crate::store::read_project(root, "demo").unwrap();
        project["assets"] = json!([
            {
                "id": "asset-barrel", "name": "Wooden Barrel", "type": "procedural",
                "tags": ["prop", "wood"], "usage": [], "thumbnail": null, "metadata": {}
            },
            {
                "id": "cali-lamp", "name": "Desk Lamp", "type": "cali",
                "source": "cali-lamp.cali.json",
                "tags": ["light"], "usage": [], "thumbnail": null, "metadata": {}
            }
        ]);
        crate::store::write_project(root, "demo", &project).unwrap();
        let assets_dir = crate::store::project_dir(root, "demo")
            .unwrap()
            .join("assets");
        std::fs::create_dir_all(&assets_dir).unwrap();
        std::fs::write(
            assets_dir.join("cali-lamp.cali.json"),
            serde_json::to_string(&json!({
                "componentTree": [{ "id": "c1", "name": "Brass Arm" }],
                "materials": [{ "id": "m1", "name": "Brushed Brass" }]
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn local_search_finds_assets_by_name_and_spec_contents() {
        let root = tempfile::tempdir().unwrap();
        seed_project(root.path());
        let q = Query::parse("barrel");
        let hits = search_local(root.path(), "demo", &q, &[]).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["id"], "asset-barrel");
        assert_eq!(hits[0]["pick"]["source"], "local");

        // Material name inside the .cali.json is searchable.
        let q = Query::parse("brass");
        let hits = search_local(root.path(), "demo", &q, &[]).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["id"], "cali-lamp");

        // Type filter.
        let q = Query::parse("barrel lamp");
        let hits = search_local(root.path(), "demo", &q, &["cali".to_string()]).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["type"], "cali");
    }

    fn canned_catalog() -> Vec<Value> {
        vec![
            json!({
                "id": "linear-ability-casting", "name": "Linear Ability Casting",
                "url": "https://example.com/repo", "category": "vfx",
                "description": "trail and cast effects", "tags": ["trail", "casting"],
                "license": "MIT",
                "settings": [{ "key": "trailColor", "label": "Trail", "type": "string", "default": "#7dd3fc" }]
            }),
            json!({
                "id": "props-pack", "name": "Props Pack", "url": "https://example.com/props",
                "category": "props", "description": "barrels and crates",
                "tags": ["barrel", "crate"], "license": "CC0", "settings": []
            }),
        ]
    }

    #[test]
    fn library_search_scores_the_catalogue() {
        let catalog = canned_catalog();
        let none = serde_json::Map::new();
        let q = Query::parse("barrel");
        let hits = search_library(&catalog, &none, &q, &[]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["id"], "props-pack");
        assert_eq!(hits[0]["detail"]["license"], "CC0");

        // Category filter uses the types list.
        let q = Query::parse("trail");
        assert_eq!(
            search_library(&catalog, &none, &q, &["vfx".to_string()]).len(),
            1
        );
        assert_eq!(
            search_library(&catalog, &none, &q, &["props".to_string()]).len(),
            0
        );
    }

    #[test]
    fn library_search_withholds_the_url_until_the_game_installs_it() {
        let catalog = canned_catalog();
        let q = Query::parse("barrel");

        // Uninstalled: discoverable, but nothing the agent can build against.
        let hits = search_library(&catalog, &serde_json::Map::new(), &q, &[]);
        assert_eq!(hits[0]["installed"], false);
        assert!(hits[0]["detail"]["url"].is_null());
        assert!(hits[0]["hint"].as_str().unwrap().contains("asset_pick"));

        // Installed: url appears, and the settings reported are this game's.
        let installed = serde_json::Map::from_iter([(
            "props-pack".to_string(),
            json!({ "settings": { "density": 4 } }),
        )]);
        let hits = search_library(&catalog, &installed, &q, &[]);
        assert_eq!(hits[0]["installed"], true);
        assert_eq!(hits[0]["detail"]["url"], "https://example.com/props");
        assert_eq!(hits[0]["detail"]["currentSettings"]["density"], 4);
        assert!(hits[0]["hint"].is_null());
    }

    #[test]
    fn installed_repos_reads_the_games_own_attachments() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let catalog = canned_catalog();

        // Nothing installed, and an absent project is simply "nothing installed".
        assert!(installed_repos(root.path(), Some("demo")).is_empty());
        assert!(installed_repos(root.path(), None).is_empty());
        assert!(installed_repos(root.path(), Some("no-such-game")).is_empty());

        pick_library(&catalog, root.path(), "demo", "props-pack").unwrap();
        let installed = installed_repos(root.path(), Some("demo"));
        assert!(installed.contains_key("props-pack"));
        // One game installing it leaves another game untouched.
        create_project(root.path(), "other", "Other").unwrap();
        assert!(installed_repos(root.path(), Some("other")).is_empty());
    }

    #[tokio::test]
    async fn search_merges_sources_and_reports_errors() {
        let root = tempfile::tempdir().unwrap();
        seed_project(root.path());
        let fetcher = StubFetch {
            json: Map::from([(
                format!("{POLYHAVEN_API}/assets?t=models"),
                json!({
                    "wine_barrel": {
                        "name": "Wine Barrel", "categories": ["props"],
                        "tags": ["wood", "barrel"], "download_count": 9000
                    },
                    "rock_moss": { "name": "Mossy Rock", "categories": ["nature"], "tags": [] }
                }),
            )]),
            bytes: Map::new(),
        };
        let sources: Vec<String> = DEFAULT_SOURCES.iter().map(|s| s.to_string()).collect();
        let result = search_with(
            &fetcher,
            &canned_catalog(),
            root.path(),
            Some("demo"),
            "wooden barrel",
            &sources,
            &[],
            10,
            false,
        )
        .await
        .unwrap();
        assert_eq!(result["sources"]["local"], 1);
        assert_eq!(result["sources"]["library"], 1);
        assert_eq!(result["sources"]["polyhaven"], 1);
        let results = result["results"].as_array().unwrap();
        assert_eq!(results.len(), 3);
        // Best score first: the exact "Wooden Barrel" local hit.
        assert_eq!(results[0]["id"], "asset-barrel");

        // No slug: local skipped with a note, not an error.
        let result = search_with(
            &fetcher,
            &[],
            root.path(),
            None,
            "barrel",
            &sources,
            &[],
            10,
            false,
        )
        .await
        .unwrap();
        assert_eq!(result["sources"]["local"], 0);
        assert!(result["note"].as_str().unwrap().contains("no slug"));

        // Fetcher failure surfaces as polyhavenError, other sources intact.
        let broken = StubFetch {
            json: Map::new(),
            bytes: Map::new(),
        };
        let result = search_with(
            &broken,
            &canned_catalog(),
            root.path(),
            Some("demo"),
            "barrel",
            &sources,
            &[],
            10,
            false,
        )
        .await
        .unwrap();
        assert_eq!(result["sources"]["local"], 1);
        assert!(result["polyhavenError"].is_string());
    }

    #[tokio::test]
    async fn pick_local_is_an_idempotent_lookup() {
        let root = tempfile::tempdir().unwrap();
        seed_project(root.path());
        let picked = pick_local(root.path(), "demo", "asset-barrel").unwrap();
        assert_eq!(picked["alreadyPresent"], true);
        assert_eq!(picked["asset"]["name"], "Wooden Barrel");
        assert!(pick_local(root.path(), "demo", "missing").is_err());
    }

    #[tokio::test]
    async fn pick_library_attaches_with_defaults_once() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let catalog = canned_catalog();
        let picked = pick_library(&catalog, root.path(), "demo", "linear-ability-casting").unwrap();
        assert_eq!(picked["attached"], true);
        assert_eq!(picked["settings"]["trailColor"], "#7dd3fc");
        let project = crate::store::read_project(root.path(), "demo").unwrap();
        assert!(project["settings"]["assetRepos"]["linear-ability-casting"].is_object());

        // Second attach is a no-op that preserves existing settings.
        let again = pick_library(&catalog, root.path(), "demo", "linear-ability-casting").unwrap();
        assert_eq!(again["attached"], false);
        assert_eq!(again["alreadyPresent"], true);
        assert!(pick_library(&catalog, root.path(), "demo", "unknown").is_err());
    }

    fn polyhaven_stub(size_main: u64, size_bin: u64) -> StubFetch {
        StubFetch {
            json: Map::from([(
                format!("{POLYHAVEN_API}/files/wine_barrel"),
                json!({
                    "gltf": {
                        "1k": {
                            "url": "https://dl.polyhaven.org/wine_barrel/wine_barrel_1k.gltf",
                            "size": size_main,
                            "include": {
                                "wine_barrel_1k.bin": {
                                    "url": "https://dl.polyhaven.org/wine_barrel/wine_barrel_1k.bin",
                                    "size": size_bin
                                },
                                "textures/wine_barrel_diff_1k.jpg": {
                                    "url": "https://dl.polyhaven.org/wine_barrel/diff.jpg",
                                    "size": 10
                                }
                            }
                        }
                    }
                }),
            )]),
            bytes: Map::from([
                (
                    "https://dl.polyhaven.org/wine_barrel/wine_barrel_1k.gltf".to_string(),
                    b"{\"gltf\":true}".to_vec(),
                ),
                (
                    "https://dl.polyhaven.org/wine_barrel/wine_barrel_1k.bin".to_string(),
                    vec![0u8; 32],
                ),
                (
                    "https://dl.polyhaven.org/wine_barrel/diff.jpg".to_string(),
                    vec![1u8; 16],
                ),
            ]),
        }
    }

    #[tokio::test]
    async fn pick_polyhaven_downloads_and_registers() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let fetcher = polyhaven_stub(100, 32);
        let entry = pick_polyhaven(
            &fetcher,
            root.path(),
            "demo",
            "wine_barrel",
            None,
            &json!({}),
        )
        .await
        .unwrap();
        assert_eq!(entry["type"], "gltf");
        assert_eq!(entry["name"], "Wine Barrel");
        assert_eq!(entry["source"], "polyhaven/wine_barrel/wine_barrel_1k.gltf");
        assert_eq!(entry["metadata"]["license"], "CC0-1.0");
        let dir = crate::store::project_dir(root.path(), "demo")
            .unwrap()
            .join("assets/polyhaven/wine_barrel");
        assert!(dir.join("wine_barrel_1k.gltf").exists());
        assert!(dir.join("wine_barrel_1k.bin").exists());
        assert!(dir.join("textures/wine_barrel_diff_1k.jpg").exists());
        let project = crate::store::read_project(root.path(), "demo").unwrap();
        assert!(project["assets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["id"] == entry["id"]));
    }

    #[tokio::test]
    async fn pick_polyhaven_enforces_the_size_cap() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let fetcher = polyhaven_stub(POLYHAVEN_MAX_BYTES, 64);
        let error = pick_polyhaven(
            &fetcher,
            root.path(),
            "demo",
            "wine_barrel",
            None,
            &json!({}),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("cap"), "{error}");
    }

    #[tokio::test]
    async fn pick_polyhaven_refuses_path_traversal_in_includes() {
        let root = tempfile::tempdir().unwrap();
        create_project(root.path(), "demo", "Demo").unwrap();
        let fetcher = StubFetch {
            json: Map::from([(
                format!("{POLYHAVEN_API}/files/evil"),
                json!({
                    "gltf": { "1k": {
                        "url": "https://dl.polyhaven.org/evil/evil_1k.gltf", "size": 5,
                        "include": {
                            "../../escape.bin": { "url": "https://dl.polyhaven.org/evil/x.bin", "size": 5 }
                        }
                    } }
                }),
            )]),
            bytes: Map::from([
                (
                    "https://dl.polyhaven.org/evil/evil_1k.gltf".to_string(),
                    vec![0u8; 5],
                ),
                (
                    "https://dl.polyhaven.org/evil/x.bin".to_string(),
                    vec![0u8; 5],
                ),
            ]),
        };
        let result = pick_polyhaven(&fetcher, root.path(), "demo", "evil", None, &json!({})).await;
        assert!(result.is_err(), "traversal include must be rejected");
    }

    #[test]
    fn asset_id_component_is_sanitized() {
        assert!(sanitize_component("wine_barrel").is_ok());
        assert!(sanitize_component("../etc").is_err());
        assert!(sanitize_component("a/b").is_err());
        assert!(sanitize_component("").is_err());
    }

    #[test]
    fn catalog_entries_are_validated() {
        let good = json!([{ "id": "x", "name": "X" }]);
        assert_eq!(normalize_catalog_entries(&good).unwrap().len(), 1);
        assert!(normalize_catalog_entries(&json!({})).is_err());
        assert!(normalize_catalog_entries(&json!([{ "name": "no id" }])).is_err());
        assert!(normalize_catalog_entries(&json!([{ "id": "" }])).is_err());
    }
}
