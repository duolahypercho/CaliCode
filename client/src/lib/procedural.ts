import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinnedScene } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Asset, Entity, Project } from "./types";

export interface GeneratorParams {
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
  segments?: number;
  color?: string;
  emissive?: string;
  emissiveIntensity?: number;
  metalness?: number;
  roughness?: number;
  seed?: number;
  /** Optional surface treatment. `grid` keeps the plane transparent between lines. */
  pattern?: string;
  /** Grid cells across local x/y, either shared or per-axis. */
  gridDivisions?: number | [number, number];
  /** Desired world-space cell size when the grid belongs to a scene entity. */
  gridCellSize?: number;
  /** Line width as a fraction of one grid cell. */
  gridLineWidth?: number;
}

export function createGeometry(
  kind: string,
  params: GeneratorParams = {},
): THREE.BufferGeometry {
  const w = params.width ?? 1;
  const h = params.height ?? 1;
  const d = params.depth ?? 1;
  const r = params.radius ?? 0.5;
  const s = Math.max(4, params.segments ?? 24);
  switch (kind) {
    case "box":
      return new THREE.BoxGeometry(w, h, d);
    case "sphere":
      return new THREE.SphereGeometry(r, s, s);
    case "cylinder":
      return new THREE.CylinderGeometry(r, r, h, s);
    case "cone":
      return new THREE.ConeGeometry(r, h, s);
    case "torus":
      return new THREE.TorusGeometry(r, w * 0.5, 16, 48);
    case "plane":
      return new THREE.PlaneGeometry(w, h, 1, 1);
    case "terrain":
      return terrainGeometry(w, h, s, params.seed ?? 7);
    default:
      return new THREE.BoxGeometry(w, h, d);
  }
}

export function terrainGeometry(
  width: number,
  depth: number,
  segments: number,
  seed: number,
): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(width, depth, segments, segments);
  const positions = geometry.attributes.position as THREE.BufferAttribute;
  const vector = new THREE.Vector3();
  for (let i = 0; i < positions.count; i += 1) {
    vector.fromBufferAttribute(positions, i);
    const x = vector.x + seed;
    const z = vector.y + seed;
    vector.z =
      Math.sin(x * 0.9 + seed) * 0.25 +
      Math.sin(z * 1.3 + seed * 2) * 0.2 +
      Math.sin((x + z) * 0.4) * 0.35;
    positions.setXYZ(i, vector.x, vector.y, vector.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * BufferGeometry from a `.cali` `mesh` component payload — the raw buffers
 * core's `image3d_mesh` tool emits (`core/src/image_mesh.rs::mesh_to_cali_spec`):
 * `{ positions: number[], indices: number[], uvs?: number[], normals?: number[] }`,
 * flat xyz / triangle-index / uv arrays. Normals are computed when absent
 * (image_mesh does not emit them today).
 */
export function meshGeometry(
  mesh: Record<string, unknown>,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions = numberArray(mesh.positions);
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  const indices = numberArray(mesh.indices);
  if (indices.length > 0) {
    geometry.setIndex(indices);
  }
  const uvs = numberArray(mesh.uvs);
  if (uvs.length > 0) {
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  }
  const normals = numberArray(mesh.normals);
  if (normals.length > 0) {
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(normals, 3),
    );
  } else {
    geometry.computeVertexNormals();
  }
  return geometry;
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map((entry) => Number(entry)) : [];
}

export function createMaterial(
  params: GeneratorParams = {},
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(params.color ?? "#6b7280"),
    emissive: new THREE.Color(params.emissive ?? "#000000"),
    emissiveIntensity: params.emissiveIntensity ?? 1,
    metalness: params.metalness ?? 0.1,
    roughness: params.roughness ?? 0.7,
  });
  if (params.seed !== undefined) {
    material.map = createNoiseTexture(params.seed);
  }
  return material;
}

const GRID_VERTEX_SHADER = /* glsl */ `
  varying vec2 vGridUv;

  void main() {
    vGridUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GRID_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 baseColor;
  uniform vec3 emissiveColor;
  uniform float emissiveIntensity;
  uniform vec2 divisions;
  uniform float lineWidth;
  varying vec2 vGridUv;

  void main() {
    vec2 cell = fract(vGridUv * divisions);
    vec2 edgeDistance = min(cell, 1.0 - cell);
    float distanceToLine = min(edgeDistance.x, edgeDistance.y);
    float alpha = 1.0 - smoothstep(lineWidth, lineWidth + 0.01, distanceToLine);
    if (alpha <= 0.001) discard;
    gl_FragColor = vec4(baseColor + emissiveColor * emissiveIntensity, alpha);
  }
`;

/**
 * A procedural grid is still a regular unit plane for transforms, picking,
 * bounds, and serialization, but its material discards every fragment between
 * the lines. This avoids the solid emissive quad produced when a grid is
 * represented by an ordinary MeshStandardMaterial.
 */
export function createGridPlane(params: GeneratorParams = {}): THREE.Mesh {
  const divisions = gridDivisions(params.gridDivisions);
  const lineWidth = finiteClamp(params.gridLineWidth, 0.025, 0.004, 0.2);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      baseColor: { value: new THREE.Color(params.color ?? "#061016") },
      emissiveColor: {
        value: new THREE.Color(params.emissive ?? params.color ?? "#00e5ff"),
      },
      emissiveIntensity: {
        value: finiteClamp(params.emissiveIntensity, 1, 0, 16),
      },
      divisions: { value: new THREE.Vector2(divisions[0], divisions[1]) },
      lineWidth: { value: lineWidth },
    },
    vertexShader: GRID_VERTEX_SHADER,
    fragmentShader: GRID_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  material.userData.caliPattern = "grid";
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(params.width ?? 1, params.height ?? 1, 1, 1),
    material,
  );
  mesh.userData.caliPattern = "grid";
  return mesh;
}

function finiteClamp(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function gridDivisions(
  value: GeneratorParams["gridDivisions"],
): [number, number] {
  if (Array.isArray(value)) {
    return [
      Math.round(finiteClamp(value[0], 12, 2, 128)),
      Math.round(finiteClamp(value[1], 12, 2, 128)),
    ];
  }
  const shared = Math.round(finiteClamp(value, 12, 2, 128));
  return [shared, shared];
}

export function createNoiseTexture(seed = 1, size = 256): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) {
    return new THREE.CanvasTexture(canvas);
  }
  const image = context.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = Math.floor(
        128 +
          80 * Math.sin(x * 0.05 + seed) +
          60 * Math.sin(y * 0.07 + seed * 2) +
          30 * Math.sin((x + y) * 0.13 + seed * 3),
      );
      const index = (y * size + x) * 4;
      image.data[index] = value;
      image.data[index + 1] = value * 0.9;
      image.data[index + 2] = value * 0.7;
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function buildObject(
  kind: string,
  materialParams: GeneratorParams = {},
): THREE.Object3D {
  const group = new THREE.Group();
  if (kind === "plane" && materialParams.pattern?.toLowerCase() === "grid") {
    group.add(createGridPlane(materialParams));
    return group;
  }
  const geometry = createGeometry(kind, materialParams);
  const material = createMaterial(materialParams);
  const mesh = new THREE.Mesh(geometry, material);
  group.add(mesh);
  return group;
}

// ---------------------------------------------------------------------------
// glTF assets
// ---------------------------------------------------------------------------

/**
 * Loaded glTF scenes and clips keyed by resolved URL so scene rebuilds do not
 * refetch. Each instance gets a SkeletonUtils clone of the cached scene with
 * private geometry/material/texture resources for rebuild-safe disposal.
 */
interface CachedGltfAsset {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

const gltfAssetCache = new Map<string, Promise<CachedGltfAsset>>();
let sharedGltfLoader: GLTFLoader | null = null;

/**
 * `assetObject` remains synchronous for editor rebuilds, so a glTF instance
 * carries readiness and playback state on its placeholder until the loader
 * resolves. The runtime consumes this contract without reaching into loader
 * internals.
 */
export const GLTF_INSTANCE_USER_DATA_KEY = "__caliGltfInstance";

export interface GltfAssetInstance {
  readonly ready: Promise<void>;
  readonly mixers: Set<THREE.AnimationMixer>;
  readonly clips: THREE.AnimationClip[];
  disposed: boolean;
  error: Error | null;
  dispose: () => void;
}

interface GltfAssetInstanceState extends GltfAssetInstance {
  settle: () => void;
}

/**
 * URL for a glTF asset's file. Project-relative sources (e.g.
 * `polyhaven/<id>/<file>.gltf`, stored under the project's `assets/` dir) are
 * served by core's `/projects` static route; absolute and data URLs pass
 * through. Returns null when a relative source has no slug to anchor it.
 */
export function gltfAssetUrl(asset: Asset, slug?: string): string | null {
  const source = asset.source;
  if (!source) return null;
  if (
    source.startsWith("data:") ||
    source.startsWith("blob:") ||
    source.startsWith("/") ||
    /^https?:\/\//.test(source)
  ) {
    return source;
  }
  if (!slug) return null;
  return `/projects/${encodeURIComponent(slug)}/assets/${source}`;
}

function loadGltfAsset(url: string): Promise<CachedGltfAsset> {
  const cached = gltfAssetCache.get(url);
  if (cached) return cached;
  sharedGltfLoader ??= new GLTFLoader();
  const pending = sharedGltfLoader.loadAsync(url).then((gltf) => ({
    scene: gltf.scene,
    animations: gltf.animations,
  }));
  gltfAssetCache.set(url, pending);
  // Drop failed loads so the next rebuild retries instead of caching the error.
  pending.catch(() => gltfAssetCache.delete(url));
  return pending;
}

function createGltfAssetInstance(): GltfAssetInstanceState {
  let resolveReady!: () => void;
  let settled = false;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const instance: GltfAssetInstanceState = {
    ready,
    mixers: new Set<THREE.AnimationMixer>(),
    clips: [],
    disposed: false,
    error: null,
    settle: () => {
      if (settled) return;
      settled = true;
      resolveReady();
    },
    dispose: () => {
      if (instance.disposed) return;
      instance.disposed = true;
      for (const mixer of instance.mixers) {
        mixer.stopAllAction();
        mixer.uncacheRoot(mixer.getRoot());
      }
      instance.mixers.clear();
      instance.clips.length = 0;
      instance.settle();
    },
  };
  return instance;
}

function cloneGltfMaterial(material: THREE.Material): THREE.Material {
  const clone = material.clone();
  const fields = clone as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof THREE.Texture) fields[key] = value.clone();
  }
  return clone;
}

function cloneGltfScene(scene: THREE.Group): THREE.Group {
  const clone = cloneSkinnedScene(scene) as THREE.Group;
  // SkeletonUtils correctly gives skinned meshes independent bones, but
  // Object3D.clone still shares GPU resources. PIE disposes each instance on
  // rebuild, so clone those resources before attaching the scene.
  clone.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry = node.geometry.clone();
    node.material = Array.isArray(node.material)
      ? node.material.map((material) => cloneGltfMaterial(material))
      : cloneGltfMaterial(node.material);
  });
  return clone;
}

export function assetObject(asset: Asset, slug?: string): THREE.Object3D {
  if (asset.type === "cali" && asset.metadata?.cali) {
    return caliObjectFromSpec(
      asset.metadata.cali as Record<string, unknown>,
      undefined,
      slug,
    );
  }
  if (asset.type === "gltf") {
    // buildScene is synchronous, so return a placeholder group immediately and
    // fill it in when the (cached) loader resolves.
    const group = new THREE.Group();
    const instance = createGltfAssetInstance();
    group.userData[GLTF_INSTANCE_USER_DATA_KEY] = instance;
    const url = gltfAssetUrl(asset, slug);
    if (!url) {
      instance.settle();
      return group;
    }
    loadGltfAsset(url)
      .then(({ scene, animations }) => {
        if (instance.disposed) return;
        const clone = cloneGltfScene(scene);
        instance.clips.push(...animations);
        if (animations.length > 0) {
          const mixer = new THREE.AnimationMixer(clone);
          instance.mixers.add(mixer);
          // PIE starts the first clip by default; callers that need clip
          // selection can still inspect the retained clip metadata.
          mixer.clipAction(animations[0]).play();
        }
        group.add(clone);
        instance.settle();
      })
      .catch((error: unknown) => {
        instance.error =
          error instanceof Error ? error : new Error(String(error));
        instance.settle();
        console.warn(
          `glTF load failed for asset ${asset.name} (${url})`,
          error,
        );
      });
    return group;
  }
  const kind = asset.source.replace("procedural:", "") || "box";
  return buildObject(kind, (asset.metadata as GeneratorParams) ?? {});
}

export function getGltfAssetInstance(
  object: THREE.Object3D,
): GltfAssetInstance | null {
  const instance = object.userData[GLTF_INSTANCE_USER_DATA_KEY] as
    GltfAssetInstance | undefined;
  return instance?.ready &&
    instance.mixers &&
    typeof instance.dispose === "function"
    ? instance
    : null;
}

export function collectAnimationMixers(
  root: THREE.Object3D,
): THREE.AnimationMixer[] {
  const mixers: THREE.AnimationMixer[] = [];
  const seen = new Set<THREE.AnimationMixer>();
  root.traverse((object) => {
    const instance = getGltfAssetInstance(object);
    if (!instance) return;
    for (const mixer of instance.mixers) {
      if (seen.has(mixer)) continue;
      seen.add(mixer);
      mixers.push(mixer);
    }
  });
  return mixers;
}

/**
 * Waits for all glTF placeholders currently attached to a tree. Loader
 * failures settle normally, and a bounded timeout keeps a broken or stalled
 * asset from freezing PIE or an initial capture forever.
 */
export async function waitForAssetReadiness(
  root: THREE.Object3D,
  timeoutMs = 250,
): Promise<void> {
  const instances: GltfAssetInstance[] = [];
  const seen = new Set<GltfAssetInstance>();
  root.traverse((object) => {
    const instance = getGltfAssetInstance(object);
    if (!instance || seen.has(instance)) return;
    seen.add(instance);
    instances.push(instance);
  });
  if (instances.length === 0) return;

  const allReady = Promise.all(
    instances.map((instance) =>
      Promise.resolve(instance.ready).catch(() => undefined),
    ),
  );
  if (timeoutMs <= 0) {
    await Promise.resolve();
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      allReady,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// .cali specs
// ---------------------------------------------------------------------------

/**
 * Build a renderable object tree from a `.cali` spec.
 *
 * - Components without a `primitive`, or with `topologyClass: "group"`, become
 *   bare `THREE.Group` nodes (pure containers).
 * - `primitive: "mesh"` components build a BufferGeometry from `component.mesh`
 *   (see `meshGeometry`).
 * - Every node carries `userData.componentId` for gizmo/raycast picking.
 * - `assets`/`slug` let material `map` references resolve project asset ids to
 *   texture URLs; both are optional for standalone specs.
 */
export function caliObjectFromSpec(
  spec: Record<string, unknown>,
  assets?: Asset[],
  slug?: string,
): THREE.Group {
  const root = new THREE.Group();
  const components =
    (spec.componentTree as Array<Record<string, unknown>>) ?? [];
  const materials = (spec.materials as Array<Record<string, unknown>>) ?? [];
  const byId = new Map<string, THREE.Object3D>();
  for (const component of components) {
    const id = String(component.id ?? `node-${byId.size}`);
    const primitive = component.primitive;
    let object: THREE.Object3D;
    if (
      primitive === undefined ||
      primitive === null ||
      component.topologyClass === "group"
    ) {
      object = new THREE.Group();
    } else {
      const geometry =
        primitive === "mesh"
          ? meshGeometry((component.mesh as Record<string, unknown>) ?? {})
          : createGeometry(
              String(primitive),
              (component.dimensions as Record<string, number>) ?? {},
            );
      const materialId = component.materialId as string | undefined;
      const pbr =
        (materials.find((material) => material.id === materialId)?.pbr as
          Record<string, unknown> | undefined) ?? {};
      object = new THREE.Mesh(geometry, caliMaterial(pbr, assets, slug));
    }
    object.name = String(component.name ?? id);
    object.userData.componentId = id;
    const transform = (component.transform as Record<string, number[]>) ?? {};
    object.position.set(
      ...(((transform.position as number[]) ?? [0, 0, 0]) as [
        number,
        number,
        number,
      ]),
    );
    object.rotation.set(
      ...(((transform.rotation as number[]) ?? [0, 0, 0]) as [
        number,
        number,
        number,
      ]),
    );
    object.scale.set(
      ...(((transform.scale as number[]) ?? [1, 1, 1]) as [
        number,
        number,
        number,
      ]),
    );
    byId.set(id, object);
  }
  for (const component of components) {
    const id = String(component.id);
    const object = byId.get(id);
    if (!object) continue;
    const parent = component.parent ? byId.get(String(component.parent)) : root;
    (parent ?? root).add(object);
  }
  return root;
}

/**
 * Loaded textures keyed by resolved URL so op-driven scene rebuilds (e.g.
 * builder drags) do not re-decode embedded data-URI textures on every rebuild.
 * Mirrors `gltfSceneCache`, including eviction on load failure so the next
 * rebuild retries instead of caching a broken texture.
 *
 * Disposal: `disposeTree` (pie.ts) may call `.dispose()` on a cached texture
 * that other materials still reference. That only frees the GPU allocation —
 * the decoded image stays on the texture, and three.js re-uploads it on the
 * next render that uses it — so a cached texture survives disposal and never
 * needs to be evicted for it.
 */
const textureCache = new Map<string, THREE.Texture>();
let sharedTextureLoader: THREE.TextureLoader | null = null;

function loadCachedTexture(url: string): THREE.Texture {
  const cached = textureCache.get(url);
  if (cached) return cached;
  sharedTextureLoader ??= new THREE.TextureLoader();
  // Drop failed loads so the next rebuild retries instead of caching the
  // error. The flag also covers loaders that report failure synchronously,
  // before the texture is cached below.
  let failed = false;
  const texture = sharedTextureLoader.load(url, undefined, undefined, () => {
    failed = true;
    textureCache.delete(url);
  });
  texture.colorSpace = THREE.SRGBColorSpace;
  if (!failed) textureCache.set(url, texture);
  return texture;
}

/**
 * MeshStandardMaterial from a `.cali` material's `pbr` block, including the
 * extended fields: `emissive`, `emissiveIntensity`, and `map` (a `data:` URI,
 * an absolute URL, or a project asset id resolved via `assets` + `slug`).
 */
function caliMaterial(
  pbr: Record<string, unknown>,
  assets?: Asset[],
  slug?: string,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(String(pbr.baseColor ?? "#9ca3af")),
    metalness: Number(pbr.metalness ?? 0.1),
    roughness: Number(pbr.roughness ?? 0.7),
  });
  if (typeof pbr.emissive === "string" && pbr.emissive) {
    material.emissive = new THREE.Color(pbr.emissive);
  }
  if (pbr.emissiveIntensity !== undefined && pbr.emissiveIntensity !== null) {
    material.emissiveIntensity = Number(pbr.emissiveIntensity);
  }
  const mapUrl = resolveTextureSource(pbr.map, assets, slug);
  if (mapUrl) {
    material.map = loadCachedTexture(mapUrl);
  }
  return material;
}

/**
 * Resolve a `pbr.map` value to a loadable URL. Direct URLs (`data:`, `blob:`,
 * absolute, root-relative) pass through; anything else is treated as a project
 * asset id and resolved through the asset list — to the asset's own data URI
 * source, or to its file under the `/projects` static route when a slug is
 * known.
 */
function resolveTextureSource(
  map: unknown,
  assets?: Asset[],
  slug?: string,
): string | null {
  if (typeof map !== "string" || map.length === 0) return null;
  if (
    map.startsWith("data:") ||
    map.startsWith("blob:") ||
    map.startsWith("/") ||
    /^https?:\/\//.test(map)
  ) {
    return map;
  }
  const referenced = assets?.find((asset) => asset.id === map);
  if (!referenced || !referenced.source) return null;
  if (referenced.source.startsWith("data:")) return referenced.source;
  if (!slug) return null;
  return `/projects/${encodeURIComponent(slug)}/assets/${referenced.source}`;
}

export function entityObject(entity: Entity): THREE.Object3D {
  if (entity.kind === "light") {
    const light = new THREE.DirectionalLight(
      new THREE.Color((entity.light.color as string) ?? "#ffffff"),
      (entity.light.intensity as number) ?? 1,
    );
    return light;
  }
  if (entity.kind === "camera") {
    return new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  }
  return buildObject(entity.kind, entityGeneratorParams(entity));
}

/**
 * `material.pattern` is the durable declarative contract. The name fallback
 * keeps older agent-authored FloorGrid/ArenaGrid entities from rendering as
 * luminous slabs without coupling the renderer to a project or entity id.
 */
function entityGeneratorParams(entity: Entity): GeneratorParams {
  const params = { ...entity.material } as GeneratorParams;
  if (entity.kind !== "plane") return params;

  const explicitPattern =
    typeof params.pattern === "string" ? params.pattern.toLowerCase() : null;
  const nameTokens = entity.name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z\d]+/);
  const usesGrid =
    explicitPattern === "grid" ||
    (explicitPattern === null && nameTokens.includes("grid"));
  if (!usesGrid) return params;

  if (params.gridDivisions === undefined) {
    const cellSize = finiteClamp(params.gridCellSize, 1, 0.1, 100);
    params.gridDivisions = [
      Math.max(2, Math.round(Math.abs(entity.transform.scale[0]) / cellSize)),
      Math.max(2, Math.round(Math.abs(entity.transform.scale[1]) / cellSize)),
    ];
  }
  params.pattern = "grid";
  return params;
}

export function buildScene(project: Project): THREE.Group {
  const group = new THREE.Group();
  for (const entity of project.entities) {
    const asset = entity.assetId
      ? project.assets.find((item) => item.id === entity.assetId)
      : undefined;
    let object: THREE.Object3D;
    if (entity.kind === "light" || entity.kind === "camera") {
      object = entityObject(entity);
    } else if (asset?.type === "cali" && asset.metadata?.cali) {
      object = caliObjectFromSpec(
        asset.metadata.cali as Record<string, unknown>,
        project.assets,
        project.slug,
      );
      // The cali spec owns the material definitions, but a project's
      // entity still gets to override PBR fields at the scene level — that
      // is what `editor_object_update({material: {emissive, …}})` writes.
      // Without this bridge the inspector / TWEAK LIVE sliders move the
      // entity.material values without touching the rendered MeshStandardMaterial,
      // so a "Neon Pad" stays flat even after the agent asks for cyan glow.
      // The source .cali file on disk is untouched; only the live three.js
      // materials are patched.
      applyEntityMaterialOverridesToCali(object, entity);
    } else if (asset) {
      // The asset supplies the geometry; the entity still owns its material.
      // Passing the asset alone discarded entity.material entirely, so the
      // Inspector and the TWEAK LIVE colour/metalness/roughness sliders wrote
      // to fields the renderer never read — the readout moved and the object
      // stayed grey.
      object = assetObject(
        {
          ...asset,
          metadata: {
            ...(asset.metadata ?? {}),
            ...entityMaterialOverrides(entity),
          },
        },
        project.slug,
      );
    } else {
      object = entityObject(entity);
    }
    object.name = entity.name;
    const [px, py, pz] = entity.transform.position;
    const [rx, ry, rz] = entity.transform.rotation;
    const [sx, sy, sz] = entity.transform.scale;
    object.position.set(px, py, pz);
    object.rotation.set(rx, ry, rz);
    object.scale.set(sx, sy, sz);
    object.userData.entityId = entity.id;
    group.add(object);
  }
  return group;
}

export function renderThumbnail(object: THREE.Object3D, size = 128): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    preserveDrawingBuffer: true,
    antialias: true,
  });
  renderer.setSize(size, size, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(3, 4, 5);
  scene.add(key);
  scene.add(object);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(2.5, 2, 3);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
  const dataUrl = canvas.toDataURL("image/png");
  renderer.dispose();
  return dataUrl;
}

/**
 * Material fields the entity explicitly sets, for merging over an asset's own
 * metadata. Only defined keys are returned so an entity that never set a
 * colour keeps the asset's.
 */
function entityMaterialOverrides(entity: Entity): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const key of [
    "color",
    "emissive",
    "emissiveIntensity",
    "metalness",
    "roughness",
    "pattern",
    "gridDivisions",
    "gridCellSize",
    "gridLineWidth",
  ]) {
    const value = entity.material?.[key];
    if (value !== undefined && value !== null) overrides[key] = value;
  }
  return overrides;
}

/**
 * Walk a `.cali` object tree and apply an entity's PBR overrides to every
 * MeshStandardMaterial found. Used to bridge `entity.material` into the
 * rendered meshes without touching the source `.cali` JSON on disk. The
 * override values come from `entityMaterialOverrides` so an entity that
 * never set a colour keeps whatever the cali spec declared.
 *
 * Precedence: entity wins over spec for every field the entity set. The
 * spec keeps its values for fields the entity left alone.
 */
function applyEntityMaterialOverridesToCali(
  object: THREE.Object3D,
  entity: Entity,
): void {
  const overrides = entityMaterialOverrides(entity);
  if (Object.keys(overrides).length === 0) return;
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const materials: THREE.Material[] = Array.isArray(node.material)
      ? node.material
      : [node.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (typeof overrides.color === "string") {
        material.color = new THREE.Color(overrides.color);
      }
      if (typeof overrides.emissive === "string") {
        material.emissive = new THREE.Color(overrides.emissive);
      }
      if (typeof overrides.emissiveIntensity === "number") {
        material.emissiveIntensity = overrides.emissiveIntensity;
      }
      if (typeof overrides.metalness === "number") {
        material.metalness = overrides.metalness;
      }
      if (typeof overrides.roughness === "number") {
        material.roughness = overrides.roughness;
      }
    }
  });
}
