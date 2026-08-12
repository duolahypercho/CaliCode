# Asset Tools Blueprint

Three related capabilities: (1) agent-facing asset search/pick over local + registry + PolyHaven, (2) a Blender-lite in-editor asset builder for `.cali` assets that both the agent and the user drive through the same op reducer, (3) a clean-room image→mesh hardening of the image3d pipeline.

Conventions used throughout:
- "core" = `core/src/*` (Rust, axum, JSON-RPC at `rpc.rs::dispatch`, agent tools in `tools.rs`).
- "client" = `client/src/*` (React, three.js; browser tools in `lib/useBrowserTools.ts` registered via `tool_register`).
- All new core tools follow existing `ToolDef` shape (`tools.rs` L64-78) and are dispatched in `execute_core_tool` (`tools.rs` L213-359).
- All new browser tools follow the existing convention: UI and agent share the same `setProject` mutation path (map §8).

---

## Part 1 — asset_search / asset_pick agent tools

### 1.1 Problem recap

- The `.cali` store is per-project (`~/.cali/projects/<slug>/assets/*.cali.json` + `project.json` `assets[]`); the agent can only enumerate it via `project_open` or `asset_hash_dedupe`, neither of which searches.
- The assetLibrary registry (`client/src/lib/assetLibrary/`) is client-bundled TS (`import.meta.glob`) and **invisible to core** — the agent sees only opaque repo ids in `project.settings.assetRepos`.
- No external catalogue access exists. PolyHaven has a free, keyless, CC0 API (`api.polyhaven.com`) with glTF model downloads — a safe first external source.

### 1.2 Getting the client registry into core: catalogue publish

The registry stays client-owned (one TS file per repo, no core duplication). The client pushes a serialized snapshot at startup, exactly like `tool_register` pushes browser tools.

**New RPC method `asset_catalog_publish`** (client → core, whole-set replacement like `tool_register`):

```jsonc
// params
{ "entries": [ { "id": "linear-ability-casting", "name": "...", "url": "...",
                 "category": "vfx", "description": "...", "tags": ["..."],
                 "license": "MIT",
                 "settings": [ { "key": "trailColor", "label": "...", "type": "string",
                                 "default": "#7dd3fc" } ] } ] }
// result
{ "count": 1 }
```

Stored in `AppState` (new field) so `asset_search` can query it without touching disk:

```rust
// core/src/main.rs — AppState (L44)
pub asset_catalog: Arc<RwLock<Vec<serde_json::Value>>>,   // entries as published
```

Client side: `client/src/lib/assetLibrary/index.ts` gains

```ts
export function catalogSnapshot(): AssetCatalogEntry[]   // maps assetRepos -> plain JSON
```

and `App.tsx` calls `rpc("asset_catalog_publish", { entries: catalogSnapshot() })` right next to the existing `tool_register` call (App.tsx:390 area), and again whenever the registry module set could change (startup only today — the glob is build-time).

### 1.3 New core module `core/src/asset_search.rs`

```rust
use crate::AppState;
use anyhow::Result;
use serde_json::{json, Value};
use std::path::Path;

/// One row in a search result, regardless of source.
/// source: "local" | "library" | "polyhaven"
pub fn search(
    state: &AppState,
    root: &Path,
    slug: Option<&str>,
    query: &str,
    sources: &[String],
    types: &[String],          // filter: "cali" | "image" | "gltf" | "model" | "texture" | "hdri" | repo categories
    limit: usize,              // clamp 1..=50, default 20
) -> Result<Value>;            // { "results": [SearchHit], "sources": {"local": n, "library": n, "polyhaven": n} }

/// SearchHit shape (uniform):
/// { "source": "local", "id": "cali-...", "name": "...", "type": "cali",
///   "score": 0.83, "tags": [...], "detail": {source-specific},
///   "pick": {"source": "local", "id": "..."} }   // ready-made args for asset_pick

fn search_local(root: &Path, slug: &str, q: &Query) -> Vec<Hit>;   // project.json assets[] + assets/*.cali.json names/tags/materials
fn search_library(catalog: &[Value], q: &Query) -> Vec<Hit>;       // published catalogue entries
async fn search_polyhaven(q: &Query, types: &[String]) -> Result<Vec<Hit>>;

/// Import a picked hit into the project. Returns the registered asset entry.
pub async fn pick(
    state: &AppState,
    root: &Path,
    slug: &str,
    source: &str,          // "local" | "library" | "polyhaven"
    id: &str,
    name: Option<&str>,
    options: &Value,       // source-specific: {"resolution":"1k","format":"gltf"} for polyhaven
) -> Result<Value>;
```

**Matching**: lowercase token match over name + tags + description; score = matched-token ratio with a whole-word bonus. No fuzzy dependency needed. Keep it a pure function (`Query { tokens: Vec<String> }`) so it is unit-testable.

**Local source**: read `project.json` (`store::read_project`), score `assets[]` by `name`/`tags`; for `type=="cali"` entries also open the `.cali.json` (via `resolve_game_file`) and include component/material names in the haystack. `slug` required for local; when `slug` is absent, local search is skipped (noted in result `sources`).

**Library source**: score the published catalogue (name, description, tags, category). `detail` carries url + license + settings schema — this is the piece the agent could never see before.

**PolyHaven source** (`reqwest` is already a dependency):
- `GET https://api.polyhaven.com/assets?t=models` → `{ "<id>": { "name", "categories": [...], "tags": [...], "download_count", ... } }`. The API has **no text search**; fetch the type-filtered list and filter locally.
- Cache the list in-process: `static POLYHAVEN_CACHE: OnceLock<Mutex<Option<(Instant, Value)>>>` with a 15-minute TTL — the models list is ~1-2 MB and changes rarely. All PolyHaven calls wrapped in `tokio::time::timeout(Duration::from_secs(10), ...)`; on failure the hit list for that source is empty and the result carries `"polyhavenError": "..."` instead of failing the whole search (the agent should still get local hits offline).
- `types` maps: `"model"` → `t=models`, `"texture"` → `t=textures`, `"hdri"` → `t=hdris`; default models only.

**Pick, per source**:
- `local`: the asset already exists in this project → returns the existing registry entry (idempotent no-op; useful when the agent searched without a slug filter). If a future cross-project pick is wanted, copy the `.cali.json` + register — out of scope now.
- `library`: core-side equivalent of `attachRepo`: read project.json, insert `settings.assetRepos[id] = { settings: {defaults from published schema} }` if absent, `store::write_project`. Returns `{ attached: true, repoId, settings }`. (Keep the client function authoritative for the UI; the core impl mirrors its semantics — seed defaults, no-op on unknown id.)
- `polyhaven`:
  1. `GET https://api.polyhaven.com/files/<id>` → pick `gltf[<resolution>]` (default `"1k"`, honor `options.resolution`), which lists the `.gltf` plus its `include` map (bin + textures).
  2. Download the main file + every `include` entry (cap total at 64 MB, bail beyond) into `<projects_root>/<slug>/assets/polyhaven/<id>/` preserving relative paths so the glTF's internal URIs resolve.
  3. Register in `project.json` `assets[]`: `{ id: "asset-<nanos>", name, type: "gltf", source: "polyhaven/<id>/<file>.gltf", tags: ["polyhaven", ...api tags], usage: [], thumbnail: null, metadata: { polyhavenId, license: "CC0-1.0", resolution, bytes } }`.
  4. Return the registry entry. (Rendering glTF assets is a renderer gap today — `assetObject` in `procedural.ts` has no gltf branch; see Part 2.7, which adds a `GLTFLoader` branch so picked models actually appear.)

### 1.4 Tool JSON schemas — add to `core_tool_defs()` (`core/src/tools.rs` L80-200)

```rust
ToolDef {
    name: "asset_search".into(),
    description: "Search for assets across the project's local store, the attached \
        asset-repo library catalogue, and PolyHaven's free CC0 catalogue. Returns \
        scored hits with ready-made asset_pick arguments.".into(),
    parameters: json!({
        "type": "object",
        "properties": {
            "query":   {"type": "string", "description": "keywords, e.g. 'wooden barrel'"},
            "slug":    {"type": "string", "description": "project slug; required for local hits"},
            "sources": {"type": "array", "items": {"type": "string",
                        "enum": ["local", "library", "polyhaven"]},
                        "description": "default: all three"},
            "types":   {"type": "array", "items": {"type": "string"},
                        "description": "filter by kind: cali, image, gltf, model, texture, hdri"},
            "limit":   {"type": "integer", "minimum": 1, "maximum": 50}
        },
        "required": ["query"]
    }),
    kind: ToolKind::Core,
},
ToolDef {
    name: "asset_pick".into(),
    description: "Import one asset_search hit into a project: attaches a library repo, \
        or downloads a PolyHaven model into the project's assets and registers it. \
        Pass the hit's `pick` object plus the slug.".into(),
    parameters: json!({
        "type": "object",
        "properties": {
            "slug":    {"type": "string"},
            "source":  {"type": "string", "enum": ["local", "library", "polyhaven"]},
            "id":      {"type": "string"},
            "name":    {"type": "string", "description": "override display name"},
            "options": {"type": "object", "description": "polyhaven: {resolution: '1k'|'2k'|'4k'}"}
        },
        "required": ["slug", "source", "id"]
    }),
    kind: ToolKind::Core,
},
```

### 1.5 Dispatch impls

`core/src/tools.rs::execute_core_tool` — new match arms (pattern: parse args with the local `arg_str`/helpers used by neighbors):

```rust
"asset_search" => {
    let query = req_str(args, "query")?;
    let slug = args.get("slug").and_then(Value::as_str);
    let sources = str_vec(args, "sources", &["local", "library", "polyhaven"]);
    let types = str_vec(args, "types", &[]);
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, 50) as usize;
    asset_search::search(state, root, slug, query, &sources, &types, limit).await
}
"asset_pick" => {
    let slug = req_str(args, "slug")?;
    let source = req_str(args, "source")?;
    let id = req_str(args, "id")?;
    let name = args.get("name").and_then(Value::as_str);
    let options = args.get("options").cloned().unwrap_or(json!({}));
    asset_search::pick(state, root, slug, source, id, name, &options).await
}
```

(`search` becomes `async` because of the PolyHaven branch; the local/library paths stay sync inside it.)

**RPC parity** (`core/src/rpc.rs::dispatch`): add `"asset_search"`, `"asset_pick"`, `"asset_catalog_publish"` method arms so the client UI can reuse them (the ART tab search box, later).

**Permission model** (`core/src/agent.rs::is_destructive` L371-382): add `"asset_pick"` — it writes into the project (network download + project.json mutation). `asset_search` stays non-destructive (read-only + network GET). Under `"auto"` mode nothing changes (its allowlist is narrower and explicit).

### 1.6 Tests

- `core/src/asset_search.rs` unit tests: scoring (token/whole-word), local search over a tempdir project fixture, library search over a canned catalogue, polyhaven pick URL/size-cap logic behind a trait or `#[cfg(test)]` stub fetcher (`trait Fetch { async fn get_json/get_bytes }`, prod impl = reqwest) so tests never hit the network.
- `rpc` test: `asset_catalog_publish` then `asset_search` sees library hits.

---

## Part 2 — In-editor 3D asset builder (Blender-lite)

### 2.1 Document and architecture decision

The document edited is the `.cali` spec (`asset.metadata.cali`, typed `CaliSpec` in `assetPipeline.ts:68`). It already has everything a Blender-lite needs: flat `componentTree` with parent refs, per-node transform, PBR materials, runtime pivots/colliders. **All edits go through a pure op reducer** so three parties share one code path:

- the panel UI (gizmo drags, property fields) emits ops;
- the agent emits ops via `asset_builder_apply`;
- undo/redo is an op log.

The builder tools are **browser tools** (registered via `tool_register`, executed in `AgentPanel`'s `agent.tool_request` handler like every `editor_*` tool) — NOT core tools — because the source of truth for rendering is `asset.metadata.cali` inside the client-owned project state, and the established convention (map §8) is that agent and UI share the same `setProject` mutations. Subagents automatically get them (shared registered tool set). Tool names: `editor_asset_builder_open`, `editor_asset_builder_apply`, `editor_asset_builder_state`, `editor_asset_builder_save` (the requested `asset_builder_*` names, `editor_`-prefixed to match the existing namespace; core names are reserved by `tool_register` validation, so the prefix also avoids future collisions).

### 2.2 New file `client/src/lib/assetBuilderOps.ts` — op schema + reducer

```ts
import type { CaliSpec, CaliComponent, CaliMaterial } from "./assetPipeline";

export type BuilderPrimitive = "box" | "sphere" | "cylinder" | "cone" | "torus" | "plane";

export type BuilderOp =
  | { op: "add_component"; id?: string; name: string; primitive: BuilderPrimitive;
      dimensions?: Partial<{ width: number; height: number; depth: number; radius: number }>;
      parent?: string | null;
      transform?: Partial<CaliComponent["transform"]>; materialId?: string }
  | { op: "remove_component"; id: string }                       // re-parents children to the removed node's parent
  | { op: "update_component"; id: string;
      patch: Partial<Pick<CaliComponent, "name" | "primitive" | "dimensions" | "materialId">> }
  | { op: "set_transform"; id: string;
      position?: [number, number, number]; rotation?: [number, number, number];
      scale?: [number, number, number] }
  | { op: "set_parent"; id: string; parent: string | null }      // cycle-checked
  | { op: "group"; ids: string[]; name: string; id?: string }    // new empty group node, ids re-parented under it
  | { op: "add_material"; id?: string; name: string; pbr: CaliPbr }
  | { op: "update_material"; id: string; pbr: Partial<CaliPbr> }
  | { op: "remove_material"; id: string }                        // refuses while referenced
  | { op: "assign_material"; componentId: string; materialId: string }
  | { op: "set_pivot"; id?: string; node: string; axis: [number, number, number] }
  | { op: "set_collider"; id?: string; node: string; kind: "box" | "sphere" }
  | { op: "rename_asset"; name: string };

// Extended PBR (see 2.7 for renderer support):
export interface CaliPbr {
  baseColor: string;            // "#rrggbb"
  metalness: number; roughness: number;
  emissive?: string;            // "#rrggbb", default none
  emissiveIntensity?: number;   // default 1
  map?: string | null;          // data: URI or project asset id ("asset-...") of an image
}

export interface ApplyResult { spec: CaliSpec; applied: number; errors: string[] }

/** Pure. Never throws on a bad op — collects per-op errors and applies the rest,
 *  so an agent batch degrades gracefully. Structural invariants enforced:
 *  unique ids, parent must exist, no parent cycles, materialId must exist. */
export function applyOps(spec: CaliSpec, ops: BuilderOp[]): ApplyResult;

/** Compact JSON the agent can reason about: tree with ids/names/primitives/dims/
 *  materials, no transforms unless verbose. */
export function describeSpec(spec: CaliSpec, verbose?: boolean): unknown;

export function emptySpec(name: string): CaliSpec;   // valid spec with one root group + one material
export const BUILDER_OPS_SCHEMA: object;             // JSON schema for the ops array (reused in the tool def)
```

Implementation notes:
- ids: `uid("comp")` / `uid("mat")` from `lib/store.ts` when `id` omitted; op result echoes generated ids (`ApplyResult` gains `created: string[]`).
- `remove_component` must also drop runtime pivots/colliders that referenced the node.
- `group` computes the new group's transform as identity at the centroid of members and rebases member positions (simple subtract — components use local transforms already, so only members re-parented from a *different* parent need rebasing through their old/new parent chains; compute world matrices with plain math, no three.js import here — keep the module three-free and testable in vitest/jsdom).
- New optional `topologyClass` value `"group"`: a component with no `primitive` renders as a bare `THREE.Group` (renderer change in 2.7). Validator change in Part 3.5 permits it.

Tests: `client/src/lib/assetBuilderOps.test.ts` — every op happy path, cycle refusal, referenced-material refusal, batch-with-one-bad-op partial apply.

### 2.3 New file `client/src/components/workspace/AssetBuilder.tsx`

```tsx
export interface AssetBuilderProps {
  asset: Asset;                                   // type "cali" (or "procedural" — converted on open, see 2.5)
  entities: Entity[];                             // for usage display
  onApply(assetId: string, ops: BuilderOp[]): ApplyResult;  // App-owned, single mutation path
  onSave(assetId: string): Promise<void>;         // persist + sync .cali.json (2.6)
  onClose(): void;
  registerViewportApi?(api: BuilderViewportApi | null): void;  // for editor_capture-style tooling later
}
export function AssetBuilder(props: AssetBuilderProps): JSX.Element;
```

Layout: viewport (left, flex-1) + right rail (~280px): component tree list (indented by parent, click = select, drag = re-parent → `set_parent`), primitive-add toolbar (BOX/SPHERE/CYL/PLANE/CONE/TORUS → `add_component` at origin, parented under current selection), GROUP button (multi-select → `group`), material editor for the selected component (color swatch, metalness/roughness sliders, emissive color + intensity, map slot: file input → data URI, or picker over project image assets), transform fields (mirrors `EntityProperties` per-axis inputs), UNDO/REDO, SAVE, CLOSE.

**Viewport lifecycle** — copy `AssetPreview.tsx` verbatim as the template (fresh renderer per mount, `setSize(..., false)`, ResizeObserver 0-size guard, `forceContextLoss()` on unmount, studio 3-light rig + grid, OrbitControls). The asset's object lives in a named group `"__builder_asset__"`; rebuild = remove + `disposeTree` (import from a small exported helper — see 2.7 moving `disposeTree` export) + `caliObjectFromSpec(spec)`.

**Gizmos** — `TransformControls` from `three/examples/jsm/controls/TransformControls`:
- created in the mount effect, added to the scene OUTSIDE the asset group;
- `controls.addEventListener("dragging-changed", e => orbit.enabled = !e.value)` (same arbitration AssetPreview does manually);
- selection: raycast on pointerdown; every mesh built by `caliObjectFromSpec` gets `userData.componentId` (renderer change, 2.7); gizmo attaches to the hit object;
- **re-resolve after every rebuild**: rebuilds destroy the target (the documented Viewport caveat), so after rebuilding, walk the new group for `userData.componentId === selectedId` and re-attach — a 5-line effect keyed on `[spec, selectedId]`;
- W/E/R keys → translate/rotate/scale modes; on `mouseUp` (drag end) read the object's local position/rotation/scale and emit one `set_transform` op. During the drag nothing is emitted (three mutates the live object), so dragging is 60fps and the project state sees exactly one op per gesture.

**Undo/redo**: the panel keeps `history: CaliSpec[]` snapshots (specs are small JSON; snapshot-based undo is simpler and safer than inverse ops). Cap 100. Undo replaces the spec via a dedicated `onApply(assetId, [{op:"__replace", spec}])`-free path — give App a second callback `onReplaceSpec(assetId, spec)` used only by undo/redo and by `editor_asset_builder_open` when converting (2.5).

### 2.4 Mounting

Two entries, one component:
1. **From ArtTab** (primary): `ArtTab.tsx` gains an EDIT button per card (next to PROMOTE) → `onEdit(assetId)` prop → App sets `builderAssetId` state. Reuse the existing per-asset overlay slot that `AssetPreview` occupies (`previewId` pattern, ArtTab.tsx:33/135) but render `AssetBuilder` full-dock.
2. **New tab**: add `"build"` to `WORKSPACE_TABS` (`workspace/WorkspaceTabs.tsx:1`) + a tabpanel branch in the App aside (pattern App.tsx:1041-1076) rendering `AssetBuilder` for `builderAssetId` (empty-state with an asset picker when null). Agent `editor_asset_builder_open` switches to this tab so the user *watches the subagent build* and can take over the same session with the gizmo afterward — the hand-off requirement falls out of sharing one panel + one reducer.

App.tsx additions:

```ts
const [builderAssetId, setBuilderAssetId] = useState<string | null>(null);
const applyBuilderOps = (assetId: string, ops: BuilderOp[]): ApplyResult => {
  // read asset.metadata.cali (or convert, 2.5), applyOps, updateAsset(project, assetId,
  // { metadata: { ...m, cali: result.spec } }), setProject; return result
};
const replaceBuilderSpec = (assetId: string, spec: CaliSpec) => { /* same, no reducer */ };
const saveBuilderAsset = async (assetId: string) => { /* 2.6 */ };
```

Ops flow through `updateAsset` → `setProject` → the always-mounted Viewport's `useEffect([project])` rebuild — so entities referencing the asset update live in PLAY while the builder edits it. The builder viewport subscribes to the same project state and rebuilds its own group.

### 2.5 Browser tools — `client/src/lib/useBrowserTools.ts` additions

Four tools appended to the existing 16 (registered through the same `tool_register` call, App.tsx:390):

```jsonc
{ "name": "editor_asset_builder_open",
  "description": "Open an asset in the 3D asset builder. Creates a new empty cali asset when assetId is omitted (returns its id). Converts a procedural asset to a cali spec on open.",
  "parameters": { "type": "object", "properties": {
      "assetId": {"type": "string"},
      "name": {"type": "string", "description": "name for a newly created asset"} } } }

{ "name": "editor_asset_builder_apply",
  "description": "Apply a batch of build ops to the asset open in the builder (or given assetId). Returns {applied, created, errors, spec: compact description}. Ops: add_component, remove_component, update_component, set_transform, set_parent, group, add_material, update_material, remove_material, assign_material, set_pivot, set_collider, rename_asset.",
  "parameters": { "type": "object", "properties": {
      "assetId": {"type": "string"},
      "ops": BUILDER_OPS_SCHEMA }, "required": ["ops"] } }

{ "name": "editor_asset_builder_state",
  "description": "Describe the asset currently open in the builder: component tree, materials, runtime. Pass verbose:true for full transforms.",
  "parameters": { "type": "object", "properties": {
      "assetId": {"type": "string"}, "verbose": {"type": "boolean"} } } }

{ "name": "editor_asset_builder_save",
  "description": "Persist the built asset: saves the project and writes the .cali.json file so disk and project state agree.",
  "parameters": { "type": "object", "properties": { "assetId": {"type": "string"} } } }
```

Handlers (inside `useBrowserTools`, same style as `editor_object_add`):
- `open`: no assetId → `addAsset(project, { name, type: "cali", source: "<id>.cali.json", metadata: { cali: emptySpec(name) } })`; procedural asset → build a one-component spec from its `GeneratorParams` via new `specFromProcedural(asset)` in `assetBuilderOps.ts`; then `setBuilderAssetId(id)` + `setTab("build")`. Returns `{ assetId, spec: describeSpec(...) }`.
- `apply`: parse/validate ops array shape (reject non-array early with a clear error), call the same `applyBuilderOps` App callback the UI uses, return `{ applied, created, errors, spec: describeSpec(next) }` — returning the compact state every time keeps the agent loop self-correcting without an extra `_state` round-trip.
- `save`: `saveBuilderAsset(assetId)`.

Screenshot loop for subagents: no new tool needed — `editor_capture_frame` captures the PIE viewport; promote the asset (`editor_promote_asset`) into a scratch entity to view it, or (nicer, later) extend capture with `{target:"builder"}` via `registerViewportApi`. Note this in the tool description so agents know the pattern.

**Agent-usable without the panel visible?** `applyBuilderOps` operates on project state, not on panel-local state — the panel is a *view*. So `editor_asset_builder_apply` works even before the tab renders; `open` merely focuses the UI. This keeps subagents (which may run while the user is on another tab) fully functional.

### 2.6 Save-back and disk sync — fixing the documented drift

Rendering reads `asset.metadata.cali`; the `.cali.json` on disk is written only at generate-time (map: "the two can drift"). New helper in `client/src/lib/assetPipeline.ts`:

```ts
export async function saveCaliAsset(slug: string, asset: Asset): Promise<void> {
  // 1. rpc("project_save", { project })  — done by caller (persistProject)
  // 2. rpc("file_write", { slug, path: `assets/${caliFileName(asset)}`,
  //        content: JSON.stringify(asset.metadata.cali, null, 2) })
}
```

Caveat from the map: `file_write` rebases into `workspaceRoot` when a workspace is attached, making `assets/…` unreachable. Fix in core, one line of policy: **Part 3.6 adds a `project_asset_write` RPC** (`{slug, assetId, content}`) that always resolves under the CaliCode project dir via `store::safe_join`, bypassing the workspace rebase — used by `saveCaliAsset` and safe for workspace-attached games. Add it to `is_destructive`.

### 2.7 Renderer changes — `client/src/lib/procedural.ts`

- `caliObjectFromSpec` (L119):
  - set `mesh.userData.componentId = component.id` (gizmo picking);
  - component without `primitive` or with `topologyClass === "group"` → `new THREE.Group()` instead of a Mesh;
  - material build honors extended PBR: `emissive: new Color(pbr.emissive ?? "#000")`, `emissiveIntensity`, and `map`: if `pbr.map` starts with `data:` → `new TextureLoader().load(map)`; if it looks like an asset id → resolve through the project's assets (needs the project passed in — change signature to `caliObjectFromSpec(spec, assets?: Asset[])`; `buildScene` already has the project). `texture.colorSpace = SRGBColorSpace`.
  - new primitive branch `"mesh"` (used by Part 3): `component.mesh: { positions: number[], indices: number[], uvs?: number[], normals?: number[] }` → `BufferGeometry` with the given attributes (`computeVertexNormals()` when normals absent).
- `assetObject` (L111): add a `gltf` branch — async is the wrinkle: `buildScene` is sync. Solution: return a placeholder `Group` immediately and load `GLTFLoader` (+ `DRACOLoader` not needed for PolyHaven) into it when ready; cache loaded gltf scenes by `asset.source` in a module-level `Map<string, Promise<Group>>` (clone into each instance via `scene.clone(true)`), so rebuilds don't refetch. Fetch URL: new tiny static route — core already serves files via tower-http `fs`; add `.nest_service("/projects", ServeDir::new(projects_root))` in `main.rs` router so the loader can `GET /projects/<slug>/assets/polyhaven/...`. (Check CORS layer already present — it is, `tower-http cors`.)
- export `disposeTree` from `lib/pie.ts` (it's module-local today) or duplicate a small `disposeObject` in procedural.ts for the builder viewport.

### 2.8 Type updates

`client/src/lib/assetPipeline.ts`: extend `CaliMaterial["pbr"]` with `emissive?/emissiveIntensity?/map?`; extend `CaliComponent` with `mesh?` payload and make `primitive` optional (group nodes); mirror is TS-only — core treats specs as opaque `Value`, so **no Rust struct changes needed** (validator tweak in 3.5 only).

---

## Part 3 — img→three.js hardening

### 3.1 Assessment of current quality limits (`core/src/image3d.rs`)

| Stage | Limit |
|---|---|
| `ingest` | admission always `"pass"` — no blur/resolution/size gating |
| `assess` | deterministic stub: complexity = pixel-count threshold, fixed 0.7 confidence, canned inventory; never looks at pixels |
| `spec` | single-box placeholder; all geometry authoring pushed onto the LLM as JSON guesswork |
| `validate_spec` | recommends lathe/extrude/curve-sweep which the renderer **cannot draw**; reviewHistory check dead (`&& false`) |
| `review` | dHash 8x8 at threshold 28/64 (≈44% bits may differ — near-vacuous); vision "review" sends a **text-only** prompt, the screenshot bytes are never attached; fidelity = 1 - dhash/64 is a gradient-hash proxy, not perceptual |
| renderer | 7 primitives, solid-color PBR only; runtime block ignored |
| `export_gltf` | no geometry at all |

Net effect: the pipeline's only real signal is the LLM's ability to eyeball a reference image it was never sent, gated by a hash that passes almost anything.

### 3.2 Clean-room improvement — design

**No code or structure from img2threejs (Apache-2.0) is referenced or copied.** The module implements textbook algorithms from their original publications: Otsu thresholding (Otsu 1979), Moore-neighbor contour tracing, Ramer–Douglas–Peucker simplification (1972/73), ear-clipping triangulation (standard computational-geometry), and luma-as-height displacement. Note this provenance in the module doc comment.

Pipeline (`image → mesh`), all in core Rust using the existing `image` crate:

1. **Load + downscale** to ≤512px max side (Triangle filter — same filter family `dhash_distance` already uses).
2. **Silhouette**: grayscale → Otsu threshold → binary mask → largest 4-connected component (simple flood fill) → optional 1px morphological close to seal pinholes.
3. **Contour**: Moore-neighbor trace of the component boundary → polygon in image space → RDP simplify with epsilon = 0.6% of max dimension (bounds vertex count ~50-300).
4. **Mesh, three modes**:
   - `"extrude"` (default): ear-clip the polygon into a front-face triangulation; emit front cap, back cap (reversed winding), and side quads along the contour; depth = `options.depth` (default = 0.25 × silhouette width in scene units).
   - `"heightfield"`: regular grid over the silhouette bbox (resolution `options.resolution`, default 64, clamp 8..=192); vertex z = smoothed luma (3x3 box blur) × `options.depth`; vertices outside the mask clamped to 0 and skirted — a relief/displaced plate, good for terrain-ish and emblem-ish sources.
   - `"lathe"`: for radially symmetric objects — take the right half-profile of the contour (max radius per y row), RDP it, revolve N=32 segments. Finally gives the validator's "continuous-sculpt" advice something the renderer can draw.
5. **UVs**: planar projection from image space for front cap / heightfield (u = x/w, v = 1 - y/h); side walls get contour-arc-length u, depth v; lathe gets cylindrical UVs.
6. **Scale + center**: normalize so max dimension = `options.targetSize` (default 1.6 — matches AssetPreview's `FIT_SPAN`), centered, grounded at y=0, y-up.
7. **Texture**: the source image itself, embedded as a PNG data URI in the material's `map` (the extended PBR from 2.7 renders it). Background pixels outside the mask are made transparent in the emitted texture copy (alpha from mask) so caps look clean.
8. **Output**: a valid `.cali` spec — one component `{ id: "mesh-root", topologyClass: "image-mesh", primitive: "mesh", mesh: {positions, indices, uvs}, ... }` + one material `{ pbr: { baseColor: "#ffffff", metalness: 0, roughness: 0.85, map: "data:image/png;base64,..." } }` — written through the existing `generate()` path so it lands in `.cali.json` + project registry identically to spec-authored assets, and renders through the Part 2.7 `"mesh"` branch. This also means `asset_export_gltf` can be upgraded (3.6) to emit these real buffers.

### 3.3 New file `core/src/image_mesh.rs`

```rust
//! Clean-room image→mesh heuristics. Implements published textbook algorithms
//! (Otsu 1979 thresholding; Moore-neighbor contour tracing; Ramer–Douglas–Peucker
//! simplification; ear-clipping triangulation). No third-party project consulted.

use anyhow::Result;
use serde_json::Value;

pub struct MeshOptions {
    pub mode: MeshMode,            // Extrude | Heightfield | Lathe
    pub depth: f32,                // world units; 0.0 = auto
    pub resolution: u32,           // heightfield grid, clamp 8..=192
    pub target_size: f32,          // default 1.6
    pub threshold: Option<u8>,     // manual override; None = Otsu
}

pub struct MeshResult {
    pub positions: Vec<f32>, pub indices: Vec<u32>, pub uvs: Vec<f32>,
    pub texture_png: Vec<u8>,      // masked/alpha'd copy of the source
    pub stats: MeshStats,          // vertices, triangles, mask_coverage, contour_points
}

pub fn image_to_mesh(image_bytes: &[u8], opts: &MeshOptions) -> Result<MeshResult>;

/// Admission heuristics for ingest gating (3.5):
/// blur = variance of 3x3 Laplacian on luma; coverage = mask/total.
pub struct Admission { pub pass: bool, pub blur_score: f32, pub mask_coverage: f32, pub notes: Vec<String> }
pub fn admit(image_bytes: &[u8]) -> Result<Admission>;

// internals (unit-tested individually):
fn otsu_threshold(luma: &GrayImage) -> u8;
fn largest_component(mask: &BitMask) -> BitMask;
fn trace_contour(mask: &BitMask) -> Vec<(f32, f32)>;
fn rdp(points: &[(f32, f32)], epsilon: f32) -> Vec<(f32, f32)>;
fn ear_clip(polygon: &[(f32, f32)]) -> Vec<u32>;

/// Assemble the .cali spec Value (component + material with embedded texture).
pub fn mesh_to_cali_spec(name: &str, source_hash: &str, result: &MeshResult) -> Value;
```

Tests (pure functions, synthetic images): Otsu on a bimodal gradient; contour of a rendered circle ≈ circumference; RDP of a square with noise → 4-ish points; ear-clip triangle count = n-2; end-to-end `image_to_mesh` on a generated white-square-on-black → 8 corner vertices ±, closed manifold (every edge shared by exactly 2 triangles for extrude mode — write the manifold check as a test helper).

### 3.4 The agent tool — `image3d_mesh`

Add to `core_tool_defs()`:

```rust
ToolDef {
    name: "image3d_mesh".into(),
    description: "Convert a reference image into a real textured 3D mesh asset \
        (silhouette extrusion, heightfield relief, or lathe revolution) and register \
        it in the project. Accepts a raw base64 image OR the assetId of an image \
        already in the project — including images generated by an image model and \
        imported via asset_import_file or ingested via image3d_ingest.".into(),
    parameters: json!({
        "type": "object",
        "properties": {
            "slug":       {"type": "string"},
            "name":       {"type": "string"},
            "image":      {"type": "string", "description": "base64 or data URI; omit when assetId is given"},
            "assetId":    {"type": "string", "description": "existing image/cali asset to use as source"},
            "mode":       {"type": "string", "enum": ["extrude", "heightfield", "lathe"], "default": "extrude"},
            "depth":      {"type": "number", "description": "extrusion depth / relief height in world units; omit for auto"},
            "resolution": {"type": "integer", "minimum": 8, "maximum": 192},
            "targetSize": {"type": "number", "default": 1.6}
        },
        "required": ["slug", "name"]
    }),
    kind: ToolKind::Core,
},
```

Dispatch in `execute_core_tool`:

```rust
"image3d_mesh" => {
    let slug = req_str(args, "slug")?; let name = req_str(args, "name")?;
    let bytes = match args.get("image").and_then(Value::as_str) {
        Some(b64) => baselines::decode_image_base64(b64)?,          // handles data: prefix already
        None => {
            let asset_id = req_str(args, "assetId")?;               // resolve via project.json assets[].source,
            image3d::load_source_bytes(root, slug, asset_id)?       // falling back to locate_source_image()
        }
    };
    let opts = MeshOptions::from_args(args);
    let result = tokio::task::spawn_blocking(move || image_mesh::image_to_mesh(&bytes, &opts)).await??;
    image3d::generate_mesh_asset(root, slug, name, result)          // writes .cali.json + registers; returns registry entry + stats
}
```

(`spawn_blocking` because flood fill / triangulation on a 512px image is CPU ms-scale but should not sit on the async runtime.)

`image3d_mesh` **is destructive** (writes asset + project.json) → add to `is_destructive` in `agent.rs`. RPC parity: add an `"image3d_mesh"` method arm in `rpc.rs` so `assetPipeline.ts` can offer it as an import mode (new `generateMeshFromImage()` client helper, optional UI toggle in the import flow — "Spec (LLM)" vs "Mesh (heuristic)").

**Model-generated images**: no special path needed — `generateAssetFromPrompt`'s `ImageProvider` already yields a data URL; both the base64 path and the assetId path accept it. Document in the tool description (done above) so agents chain `editor_asset_generate`/image-model → `asset_import_file` → `image3d_mesh`.

### 3.5 Fixes to existing `image3d.rs` (surgical)

1. **`ingest` admission** (L21-41): call `image_mesh::admit(&bytes)`; result's `admission` becomes `"pass" | "warn" | "fail"` (`fail` when blur_score < threshold-tuned floor or min side < 64px or mask coverage < 2%); on `fail` still save the source but return the notes so the agent can request a better image. Never hard-error — the agent decides.
2. **`review` vision call** (L233): actually attach the images. Requires `model::chat` to accept image content parts — extend the message builder to OpenAI's `content: [{type:"text"},{type:"image_url",image_url:{url:"data:image/png;base64,..."}}]` form for both the reference and the screenshot. Touch: `core/src/model.rs` (content passthrough — if messages are already opaque `Value`s streamed to the provider, only the *caller* changes: build the multimodal message in `review()`; verify model.rs doesn't assume `content` is a string anywhere and fix where it does). Guard: only attach when the active model's provider is OpenAI-compatible-vision; otherwise skip the vision pass (current behavior) rather than sending garbage.
3. **Gate tightening** (L221): dHash threshold 28 → 20, and add a second cheap metric: mean absolute luma difference on 32×32 thumbnails, threshold 0.25; gate passes only if both pass. Keep `fidelity` but compute as `1 - max(dhash/64, luma_mad)`.
4. **Dead check** (L146): delete the `&& false` on the reviewHistory-thinness branch or delete the branch — dead code either way; keep it enabled with a lenient minimum (warn, not error).
5. **`validate_spec`** (L106-156): accept `primitive: "mesh"` with a `mesh` payload (validate arrays: positions len %3==0, indices in range, uvs len matches) and `topologyClass: "group"` with no primitive; stop recommending lathe/extrude/curve-sweep strings the renderer can't draw — reword to point at `image3d_mesh` lathe mode and the mesh primitive.
6. **Spec/gen schemaVersion inconsistency** (string `"1.0"` vs int `1`): make `generate()` echo the spec's version verbatim; validator accepts both.

### 3.6 `export_gltf` upgrade + asset write route (shared plumbing)

- `core/src/assets.rs::export_gltf` (L132-149): when the asset is a cali with mesh components, emit real glTF 2.0 JSON with embedded base64 buffers (positions/indices/uvs from the mesh payload; primitives converted via the same param math as `createGeometry` is *not* needed — export only mesh components; primitive components exported as before, minus the fake material claim). Small, self-contained: build `accessors/bufferViews/buffers` by hand, no new dependency.
- New RPC `project_asset_write` (from 2.6): `rpc.rs` arm + `store::safe_join`-based impl in `assets.rs`:
  ```rust
  pub fn write_project_asset(root: &Path, slug: &str, asset_rel: &str, content: &str) -> Result<Value>
  // refuses paths outside assets/, refuses .. (safe_join already does)
  ```

---

## Complete file manifest

**Create**
| File | Contents |
|---|---|
| `core/src/asset_search.rs` | `search()`, `pick()`, per-source impls, `Fetch` trait + reqwest impl, PolyHaven cache, tests |
| `core/src/image_mesh.rs` | `image_to_mesh()`, `admit()`, otsu/contour/rdp/earclip internals, `mesh_to_cali_spec()`, tests |
| `client/src/lib/assetBuilderOps.ts` | `BuilderOp`, `applyOps()`, `describeSpec()`, `emptySpec()`, `specFromProcedural()`, `BUILDER_OPS_SCHEMA` |
| `client/src/lib/assetBuilderOps.test.ts` | reducer unit tests |
| `client/src/components/workspace/AssetBuilder.tsx` | panel: viewport + TransformControls + tree + material editor + undo |
| `docs/plans/asset-tools.md` | this document |

**Modify**
| File | Change |
|---|---|
| `core/src/main.rs` | `AppState.asset_catalog`; `ServeDir` nest for `/projects` static assets |
| `core/src/tools.rs` | 3 new ToolDefs (`asset_search`, `asset_pick`, `image3d_mesh`); dispatch arms; `mod` uses |
| `core/src/rpc.rs` | method arms: `asset_catalog_publish`, `asset_search`, `asset_pick`, `image3d_mesh`, `project_asset_write` |
| `core/src/agent.rs` | `is_destructive` += `asset_pick`, `image3d_mesh`, `project_asset_write` |
| `core/src/image3d.rs` | admission gating; multimodal review; gate tightening; validator mesh/group support; `load_source_bytes()`, `generate_mesh_asset()` |
| `core/src/model.rs` | tolerate/pass through array-form `content` (multimodal messages) |
| `core/src/assets.rs` | `export_gltf` real geometry; `write_project_asset()` |
| `client/src/lib/assetLibrary/index.ts` | `catalogSnapshot()` |
| `client/src/lib/assetPipeline.ts` | extended `CaliPbr`; `CaliComponent.mesh?`; `saveCaliAsset()`; optional `generateMeshFromImage()` |
| `client/src/lib/procedural.ts` | `userData.componentId`; group nodes; extended PBR (emissive/map); `"mesh"` primitive; gltf `assetObject` branch |
| `client/src/lib/useBrowserTools.ts` | 4 `editor_asset_builder_*` tools |
| `client/src/App.tsx` | catalogue publish call; `builderAssetId` state + `applyBuilderOps`/`replaceBuilderSpec`/`saveBuilderAsset`; `"build"` tabpanel; ArtTab `onEdit` wiring |
| `client/src/components/workspace/WorkspaceTabs.tsx` | add `"build"` tab |
| `client/src/components/workspace/ArtTab.tsx` | EDIT button → `onEdit(assetId)` |
| `client/src/lib/pie.ts` | export `disposeTree` (or add shared `disposeObject` helper) |

## Build order

1. **`assetBuilderOps.ts` + tests** — pure, dependency-free; everything in Part 2 sits on it.
2. **`procedural.ts` renderer extensions** (componentId, group, extended PBR, mesh primitive) — pure additions, existing assets unaffected; needed by both the builder and image_mesh output.
3. **`AssetBuilder.tsx` + mounting** (WorkspaceTabs, ArtTab, App state) — user-facing builder works end to end, hand-editing only.
4. **`useBrowserTools` builder tools + `saveCaliAsset`/`project_asset_write`** — agent parity + disk sync. (Small core change rides along here.)
5. **`asset_search.rs` local + library** + `asset_catalog_publish` (AppState field, RPC, client publish) — no network yet, fully testable.
6. **PolyHaven source + `asset_pick` download** + `ServeDir` + gltf renderer branch — first external dependency, isolated behind the `Fetch` trait.
7. **`image_mesh.rs` + tests** — pure Rust, no wiring.
8. **`image3d_mesh` tool + `generate_mesh_asset` + validator mesh support** — wires 7 into the asset store; renders via step 2.
9. **image3d.rs hardening** (admission, dHash+luma gate, dead check, schemaVersion) — behavior tweaks with existing tests updated.
10. **Multimodal review** (model.rs content arrays) — last; touches the model layer and needs a vision-capable provider to verify.
11. **`export_gltf` real geometry** — optional capstone; depends only on step 7's mesh payloads existing.

Steps 1-4, 5-6, and 7-11 are three independent tracks after step 2; they can be built in parallel by separate subagents with merges at App.tsx and tools.rs.

## Risks / open questions

- PolyHaven list endpoint size (~MBs) — mitigated by cache + timeout; consider persisting the cache to `~/.cali/cache/polyhaven.json` if cold-start latency annoys.
- `model.rs` content-array tolerance is the only change with provider-behavior risk; gate it behind "provider supports vision" detection and keep the text-only fallback.
- Embedded texture data URIs in `.cali` specs inflate `project.json` (the map already warns `default_system_prompt` dumps the whole project JSON into the system prompt) — cap embedded textures at 512px/JPEG-quality-80, and consider storing `map` as an asset id referencing the imported source image instead of a data URI once 2.7's asset-id resolution lands (preferred; data URI stays as the fallback for standalone specs).
- TransformControls + rebuild-per-op churn: one op per drag gesture keeps rebuilds ~per-second, matching existing TWEAK LIVE behavior; if it ever stutters, diff-based rebuild is the known follow-up (documented Viewport caveat).
