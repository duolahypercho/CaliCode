import * as THREE from "three";
import type { Asset, Entity, Project } from "./types";

export interface GeneratorParams {
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
  segments?: number;
  color?: string;
  metalness?: number;
  roughness?: number;
  seed?: number;
}

export function createGeometry(kind: string, params: GeneratorParams = {}): THREE.BufferGeometry {
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

export function terrainGeometry(width: number, depth: number, segments: number, seed: number): THREE.BufferGeometry {
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

export function createMaterial(params: GeneratorParams = {}): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(params.color ?? "#6b7280"),
    metalness: params.metalness ?? 0.1,
    roughness: params.roughness ?? 0.7,
  });
  if (params.seed !== undefined) {
    material.map = createNoiseTexture(params.seed);
  }
  return material;
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

export function buildObject(kind: string, materialParams: GeneratorParams = {}): THREE.Object3D {
  const group = new THREE.Group();
  const geometry = createGeometry(kind, materialParams);
  const material = createMaterial(materialParams);
  const mesh = new THREE.Mesh(geometry, material);
  group.add(mesh);
  return group;
}

export function assetObject(asset: Asset): THREE.Object3D {
  if (asset.type === "cali" && asset.metadata?.cali) {
    return caliObjectFromSpec(asset.metadata.cali as Record<string, unknown>);
  }
  const kind = asset.source.replace("procedural:", "") || "box";
  return buildObject(kind, (asset.metadata as GeneratorParams) ?? {});
}

export function caliObjectFromSpec(spec: Record<string, unknown>): THREE.Group {
  const root = new THREE.Group();
  const components = (spec.componentTree as Array<Record<string, unknown>>) ?? [];
  const materials = (spec.materials as Array<Record<string, unknown>>) ?? [];
  const byId = new Map<string, THREE.Object3D>();
  for (const component of components) {
    const id = String(component.id ?? `node-${byId.size}`);
    const dimensions = (component.dimensions as Record<string, number>) ?? {};
    const geometry = createGeometry(String(component.primitive ?? "box"), dimensions);
    const materialId = component.materialId as string | undefined;
    const pbr = (materials.find((material) => material.id === materialId)?.pbr as
      | Record<string, unknown>
      | undefined) ?? {};
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(String(pbr.baseColor ?? "#9ca3af")),
      metalness: Number(pbr.metalness ?? 0.1),
      roughness: Number(pbr.roughness ?? 0.7),
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = String(component.name ?? id);
    const transform = (component.transform as Record<string, number[]>) ?? {};
    mesh.position.set(...(((transform.position as number[]) ?? [0, 0, 0]) as [number, number, number]));
    mesh.rotation.set(...(((transform.rotation as number[]) ?? [0, 0, 0]) as [number, number, number]));
    mesh.scale.set(...(((transform.scale as number[]) ?? [1, 1, 1]) as [number, number, number]));
    byId.set(id, mesh);
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
  return buildObject(entity.kind, entity.material as GeneratorParams);
}

export function buildScene(project: Project): THREE.Group {
  const group = new THREE.Group();
  for (const entity of project.entities) {
    const asset = entity.assetId ? project.assets.find((item) => item.id === entity.assetId) : undefined;
    let object: THREE.Object3D;
    if (entity.kind === "light" || entity.kind === "camera") {
      object = entityObject(entity);
    } else if (asset?.type === "cali" && asset.metadata?.cali) {
      object = caliObjectFromSpec(asset.metadata.cali as Record<string, unknown>);
    } else if (asset) {
      // The asset supplies the geometry; the entity still owns its material.
      // Passing the asset alone discarded entity.material entirely, so the
      // Inspector and the TWEAK LIVE colour/metalness/roughness sliders wrote
      // to fields the renderer never read — the readout moved and the object
      // stayed grey.
      object = assetObject({
        ...asset,
        metadata: { ...(asset.metadata ?? {}), ...entityMaterialOverrides(entity) },
      });
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
  const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true, antialias: true });
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
  for (const key of ["color", "metalness", "roughness"]) {
    const value = entity.material?.[key];
    if (value !== undefined && value !== null) overrides[key] = value;
  }
  return overrides;
}
