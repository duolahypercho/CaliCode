import type { CaliComponent, CaliMaterial, CaliRuntime, CaliSpec } from "./assetPipeline";
import type { Asset, Vec3 } from "./types";
import { uid } from "./store";

/**
 * Pure op reducer for the in-editor 3D asset builder (Blender-lite).
 *
 * Three parties share this single code path: the AssetBuilder panel (gizmo
 * drags, property fields), the agent (`editor_asset_builder_apply`), and
 * undo/redo (spec snapshots). `applyOps` never throws on a bad op — it
 * collects per-op errors and applies the rest so an agent batch degrades
 * gracefully. Structural invariants enforced: unique ids, parents must exist,
 * no parent cycles, referenced materials must exist.
 *
 * Deliberately three.js-free so it runs in vitest/jsdom without WebGL.
 */

export type BuilderPrimitive = "box" | "sphere" | "cylinder" | "cone" | "torus" | "plane";

export const BUILDER_PRIMITIVES: readonly BuilderPrimitive[] = [
  "box",
  "sphere",
  "cylinder",
  "cone",
  "torus",
  "plane",
];

/** Extended PBR material payload (superset of the shipped `CaliMaterial.pbr`). */
export interface CaliPbr {
  baseColor: string;
  metalness: number;
  roughness: number;
  /** "#rrggbb"; absent means no emission. */
  emissive?: string;
  emissiveIntensity?: number;
  /** data: URI or project asset id ("asset-…") of an image. */
  map?: string | null;
}

/**
 * Raw mesh payload for `primitive: "mesh"` components — the buffer layout
 * core's `image3d_mesh` emits (`image_mesh.rs::mesh_to_cali_spec`), rendered
 * by procedural.ts's `meshGeometry` (normals are computed when absent).
 */
export interface CaliMeshPayload {
  positions: number[];
  indices: number[];
  uvs?: number[];
  normals?: number[];
}

/**
 * The component shape the builder reads and writes. The shipped `CaliComponent`
 * type does not declare `materialId`/`mesh` (procedural.ts reads both off the
 * untyped spec record); this local extension keeps the reducer honest without
 * touching the shared assetPipeline types.
 */
export type BuilderComponent = CaliComponent & {
  materialId?: string;
  mesh?: CaliMeshPayload;
};

export type BuilderMaterial = Omit<CaliMaterial, "pbr"> & { pbr?: CaliPbr };

export interface BuilderTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export type BuilderOp =
  | {
      op: "add_component";
      id?: string;
      name: string;
      primitive: BuilderPrimitive;
      dimensions?: Partial<{ width: number; height: number; depth: number; radius: number; segments: number }>;
      parent?: string | null;
      transform?: Partial<BuilderTransform>;
      materialId?: string;
    }
  | { op: "remove_component"; id: string }
  | {
      op: "update_component";
      id: string;
      patch: Partial<Pick<BuilderComponent, "name" | "primitive" | "dimensions" | "materialId">>;
    }
  | { op: "set_transform"; id: string; position?: Vec3; rotation?: Vec3; scale?: Vec3 }
  | { op: "set_parent"; id: string; parent: string | null }
  | { op: "group"; ids: string[]; name: string; id?: string }
  | { op: "add_material"; id?: string; name: string; pbr: CaliPbr }
  | { op: "update_material"; id: string; pbr: Partial<CaliPbr> }
  | { op: "remove_material"; id: string }
  | { op: "assign_material"; componentId: string; materialId: string }
  | { op: "set_pivot"; id?: string; node: string; axis: Vec3 }
  | { op: "set_collider"; id?: string; node: string; kind: "box" | "sphere" }
  | { op: "rename_asset"; name: string };

export interface ApplyResult {
  spec: CaliSpec;
  applied: number;
  errors: string[];
  /** Ids generated for ops that omitted one, in op order. */
  created: string[];
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const IDENTITY: BuilderTransform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

/** A valid, minimal spec: one root group and one default material. */
export function emptySpec(name: string): CaliSpec {
  return {
    schemaVersion: "1.0",
    targetName: name,
    sourceHash: "",
    suitability: "authored",
    silhouette: { width: 1, height: 1, anchor: "ground" },
    componentTree: [
      {
        id: "comp-root",
        parent: null,
        name,
        topologyClass: "group",
        transform: cloneTransform(IDENTITY),
      },
    ],
    materials: [
      {
        id: "mat-default",
        name: "Default",
        pbr: { baseColor: "#9ca3af", metalness: 0.1, roughness: 0.7 },
      },
    ],
    proceduralStrategy: [],
    runtime: { pivots: [], sockets: [], colliders: [], destructionGroups: [] },
    buildPasses: [],
    reviewHistory: [],
  };
}

/** One-component spec built from a procedural asset's generator metadata. */
export function specFromProcedural(asset: Asset): CaliSpec {
  const kind = asset.source.replace("procedural:", "") || "box";
  const meta = (asset.metadata ?? {}) as Record<string, unknown>;
  const spec = emptySpec(asset.name);
  const dimensions: Record<string, number> = {};
  for (const key of ["width", "height", "depth", "radius", "segments"]) {
    const value = meta[key];
    if (typeof value === "number" && Number.isFinite(value)) dimensions[key] = value;
  }
  const material: BuilderMaterial = {
    id: "mat-default",
    name: "Default",
    pbr: {
      baseColor: typeof meta.color === "string" && HEX_COLOR.test(meta.color) ? meta.color : "#9ca3af",
      metalness: typeof meta.metalness === "number" ? clamp01(meta.metalness) : 0.1,
      roughness: typeof meta.roughness === "number" ? clamp01(meta.roughness) : 0.7,
    },
  };
  spec.materials = [material as CaliMaterial];
  const component: BuilderComponent = {
    id: "comp-main",
    parent: "comp-root",
    name: asset.name,
    primitive: BUILDER_PRIMITIVES.includes(kind as BuilderPrimitive) ? kind : "box",
    dimensions,
    transform: cloneTransform(IDENTITY),
    materialId: "mat-default",
  };
  spec.componentTree.push(component);
  return spec;
}

/**
 * Applies a batch of ops to a spec. Pure: the input spec is never mutated.
 * Bad ops are reported in `errors` (prefixed with their index) and skipped;
 * every other op still applies.
 */
export function applyOps(spec: CaliSpec, ops: BuilderOp[]): ApplyResult {
  const next = structuredClone(spec) as CaliSpec;
  next.componentTree = next.componentTree ?? [];
  next.materials = next.materials ?? [];
  next.runtime = normalizeRuntime(next.runtime);
  const errors: string[] = [];
  const created: string[] = [];
  let applied = 0;
  if (!Array.isArray(ops)) {
    return { spec: next, applied: 0, errors: ["ops must be an array"], created };
  }
  ops.forEach((op, index) => {
    try {
      applyOne(next, op, created);
      applied += 1;
    } catch (error) {
      const label = op && typeof op === "object" && "op" in op ? (op as { op: string }).op : "unknown";
      errors.push(`op[${index}] ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { spec: next, applied, errors, created };
}

function applyOne(spec: CaliSpec, op: BuilderOp, created: string[]): void {
  if (!op || typeof op !== "object" || typeof op.op !== "string") {
    throw new Error("malformed op");
  }
  switch (op.op) {
    case "add_component":
      return addComponent(spec, op, created);
    case "remove_component":
      return removeComponent(spec, op);
    case "update_component":
      return updateComponent(spec, op);
    case "set_transform":
      return setTransform(spec, op);
    case "set_parent":
      return setParent(spec, op);
    case "group":
      return groupComponents(spec, op, created);
    case "add_material":
      return addMaterial(spec, op, created);
    case "update_material":
      return updateMaterial(spec, op);
    case "remove_material":
      return removeMaterial(spec, op);
    case "assign_material":
      return assignMaterial(spec, op);
    case "set_pivot":
      return setPivot(spec, op, created);
    case "set_collider":
      return setCollider(spec, op, created);
    case "rename_asset": {
      const name = requireText(op.name, "name");
      spec.targetName = name;
      return;
    }
    default:
      throw new Error(`unknown op "${(op as { op: string }).op}"`);
  }
}

// ---------------------------------------------------------------------------
// component ops

function addComponent(spec: CaliSpec, op: Extract<BuilderOp, { op: "add_component" }>, created: string[]): void {
  const name = requireText(op.name, "name");
  if (!BUILDER_PRIMITIVES.includes(op.primitive)) {
    throw new Error(`unknown primitive "${op.primitive}"`);
  }
  const id = op.id ?? generated(created, uid("comp"));
  if (findComponent(spec, id)) throw new Error(`component id "${id}" already exists`);
  const parent = op.parent ?? null;
  if (parent !== null && !findComponent(spec, parent)) {
    throw new Error(`parent "${parent}" does not exist`);
  }
  if (op.materialId !== undefined && !findMaterial(spec, op.materialId)) {
    throw new Error(`material "${op.materialId}" does not exist`);
  }
  const component: BuilderComponent = {
    id,
    parent,
    name,
    primitive: op.primitive,
    dimensions: { ...(op.dimensions ?? {}) } as Record<string, number>,
    transform: mergeTransform(IDENTITY, op.transform),
    ...(op.materialId !== undefined ? { materialId: op.materialId } : {}),
  };
  spec.componentTree.push(component);
}

function removeComponent(spec: CaliSpec, op: Extract<BuilderOp, { op: "remove_component" }>): void {
  const target = mustComponent(spec, op.id);
  const removedMatrix = trsMatrix(fullTransform(target.transform));
  // Re-parent children to the removed node's parent, rebasing their local
  // transforms through the removed node so nothing jumps in world space.
  for (const component of spec.componentTree as BuilderComponent[]) {
    if (component.parent === target.id) {
      component.parent = target.parent ?? null;
      component.transform = decomposeTRS(mulMat4(removedMatrix, trsMatrix(fullTransform(component.transform))));
    }
  }
  spec.componentTree = spec.componentTree.filter((component) => component.id !== target.id);
  // Runtime entries referencing the node are now dangling — drop them.
  const runtime = normalizeRuntime(spec.runtime);
  runtime.pivots = runtime.pivots.filter((pivot) => pivot.node !== target.id);
  runtime.colliders = runtime.colliders.filter((collider) => collider.node !== target.id);
  spec.runtime = runtime;
  spec.buildPasses = (spec.buildPasses ?? []).map((pass) => ({
    ...pass,
    componentRefs: (pass.componentRefs ?? []).filter((ref) => ref !== target.id),
  }));
}

function updateComponent(spec: CaliSpec, op: Extract<BuilderOp, { op: "update_component" }>): void {
  const target = mustComponent(spec, op.id);
  const patch = op.patch ?? {};
  if (patch.primitive !== undefined && !BUILDER_PRIMITIVES.includes(patch.primitive as BuilderPrimitive)) {
    throw new Error(`unknown primitive "${patch.primitive}"`);
  }
  if (patch.materialId !== undefined && !findMaterial(spec, patch.materialId)) {
    throw new Error(`material "${patch.materialId}" does not exist`);
  }
  if (patch.name !== undefined) target.name = requireText(patch.name, "name");
  if (patch.primitive !== undefined) target.primitive = patch.primitive;
  if (patch.dimensions !== undefined) target.dimensions = { ...patch.dimensions } as Record<string, number>;
  if (patch.materialId !== undefined) target.materialId = patch.materialId;
}

function setTransform(spec: CaliSpec, op: Extract<BuilderOp, { op: "set_transform" }>): void {
  const target = mustComponent(spec, op.id);
  target.transform = mergeTransform(fullTransform(target.transform), {
    position: op.position,
    rotation: op.rotation,
    scale: op.scale,
  });
}

function setParent(spec: CaliSpec, op: Extract<BuilderOp, { op: "set_parent" }>): void {
  const target = mustComponent(spec, op.id);
  if (op.parent === target.id) throw new Error("cannot parent a component to itself");
  if (op.parent !== null) {
    mustComponent(spec, op.parent);
    if (isAncestor(spec, target.id, op.parent)) {
      throw new Error(`parenting "${target.id}" under "${op.parent}" would create a cycle`);
    }
  }
  target.parent = op.parent;
}

function groupComponents(spec: CaliSpec, op: Extract<BuilderOp, { op: "group" }>, created: string[]): void {
  const name = requireText(op.name, "name");
  const ids = op.ids ?? [];
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("ids must be a non-empty array");
  if (new Set(ids).size !== ids.length) throw new Error("ids contains duplicates");
  const members = ids.map((id) => mustComponent(spec, id));
  for (const a of ids) {
    for (const b of ids) {
      if (a !== b && isAncestor(spec, a, b)) {
        throw new Error(`cannot group "${b}" with its own ancestor "${a}"`);
      }
    }
  }
  const groupId = op.id ?? generated(created, uid("comp"));
  if (findComponent(spec, groupId)) throw new Error(`component id "${groupId}" already exists`);

  const parents = new Set(members.map((member) => member.parent ?? null));
  const group: BuilderComponent = {
    id: groupId,
    parent: null,
    name,
    topologyClass: "group",
    transform: cloneTransform(IDENTITY),
  };

  if (parents.size === 1) {
    // All members share a parent: centroid and rebasing are a simple subtract
    // in that parent's frame.
    const parent = parents.values().next().value ?? null;
    group.parent = parent;
    const centroid = centroidOf(members.map((member) => fullTransform(member.transform).position));
    group.transform = { position: centroid, rotation: [0, 0, 0], scale: [1, 1, 1] };
    for (const member of members) {
      const transform = fullTransform(member.transform);
      member.transform = {
        ...transform,
        position: subVec3(transform.position, centroid),
      };
      member.parent = groupId;
    }
  } else {
    // Mixed parents: bake each member's world matrix, put the group at the
    // world centroid under the root, and rebase members through it. The group
    // is a pure translation, so its inverse just subtracts the centroid.
    const worlds = members.map((member) => worldMatrixOf(spec, member.id));
    const centroid = centroidOf(worlds.map((world) => [world[3], world[7], world[11]] as Vec3));
    group.transform = { position: centroid, rotation: [0, 0, 0], scale: [1, 1, 1] };
    members.forEach((member, index) => {
      const local = worlds[index].slice();
      local[3] -= centroid[0];
      local[7] -= centroid[1];
      local[11] -= centroid[2];
      member.transform = decomposeTRS(local);
      member.parent = groupId;
    });
  }
  spec.componentTree.push(group);
}

// ---------------------------------------------------------------------------
// material ops

function addMaterial(spec: CaliSpec, op: Extract<BuilderOp, { op: "add_material" }>, created: string[]): void {
  const name = requireText(op.name, "name");
  const id = op.id ?? generated(created, uid("mat"));
  if (findMaterial(spec, id)) throw new Error(`material id "${id}" already exists`);
  const material: BuilderMaterial = { id, name, pbr: normalizePbr(op.pbr) };
  spec.materials.push(material as CaliMaterial);
}

function updateMaterial(spec: CaliSpec, op: Extract<BuilderOp, { op: "update_material" }>): void {
  const material = findMaterial(spec, op.id);
  if (!material) throw new Error(`material "${op.id}" does not exist`);
  const current = (material.pbr ?? { baseColor: "#9ca3af", metalness: 0.1, roughness: 0.7 }) as CaliPbr;
  material.pbr = normalizePbr({ ...current, ...op.pbr });
}

function removeMaterial(spec: CaliSpec, op: Extract<BuilderOp, { op: "remove_material" }>): void {
  if (!findMaterial(spec, op.id)) throw new Error(`material "${op.id}" does not exist`);
  const users = (spec.componentTree as BuilderComponent[])
    .filter((component) => component.materialId === op.id)
    .map((component) => component.id);
  if (users.length > 0) {
    throw new Error(`material "${op.id}" is referenced by ${users.join(", ")}`);
  }
  spec.materials = spec.materials.filter((material) => material.id !== op.id);
}

function assignMaterial(spec: CaliSpec, op: Extract<BuilderOp, { op: "assign_material" }>): void {
  const component = mustComponent(spec, op.componentId);
  if (!findMaterial(spec, op.materialId)) throw new Error(`material "${op.materialId}" does not exist`);
  component.materialId = op.materialId;
}

// ---------------------------------------------------------------------------
// runtime ops

function setPivot(spec: CaliSpec, op: Extract<BuilderOp, { op: "set_pivot" }>, created: string[]): void {
  mustComponent(spec, op.node);
  if (!isVec3(op.axis)) throw new Error("axis must be a [x, y, z] array");
  const runtime = normalizeRuntime(spec.runtime);
  const existing = op.id ? runtime.pivots.find((pivot) => pivot.id === op.id) : undefined;
  if (existing) {
    existing.node = op.node;
    existing.axis = [...op.axis] as Vec3;
  } else {
    runtime.pivots.push({ id: op.id ?? generated(created, uid("pivot")), node: op.node, axis: [...op.axis] as Vec3 });
  }
  spec.runtime = runtime;
}

function setCollider(spec: CaliSpec, op: Extract<BuilderOp, { op: "set_collider" }>, created: string[]): void {
  mustComponent(spec, op.node);
  if (op.kind !== "box" && op.kind !== "sphere") throw new Error(`unknown collider kind "${op.kind}"`);
  const runtime = normalizeRuntime(spec.runtime);
  const existing = op.id ? runtime.colliders.find((collider) => collider.id === op.id) : undefined;
  if (existing) {
    existing.node = op.node;
    existing.kind = op.kind;
  } else {
    runtime.colliders.push({ id: op.id ?? generated(created, uid("collider")), node: op.node, kind: op.kind });
  }
  spec.runtime = runtime;
}

// ---------------------------------------------------------------------------
// describe

export interface DescribedComponent {
  id: string;
  name?: string;
  primitive?: string;
  topologyClass?: string;
  dimensions?: Record<string, number>;
  materialId?: string;
  transform?: BuilderTransform;
  children: DescribedComponent[];
}

/**
 * Compact JSON the agent can reason about: a nested component tree with ids,
 * names, primitives, dimensions and materials. Transforms only when `verbose`.
 */
export function describeSpec(spec: CaliSpec, verbose = false): {
  name: string;
  components: DescribedComponent[];
  materials: { id: string; name?: string; pbr?: CaliPbr }[];
  runtime: { pivots: CaliRuntime["pivots"]; colliders: CaliRuntime["colliders"] };
  counts: { components: number; materials: number };
} {
  const components = (spec.componentTree ?? []) as BuilderComponent[];
  const describe = (component: BuilderComponent): DescribedComponent => ({
    id: component.id,
    ...(component.name !== undefined ? { name: component.name } : {}),
    ...(component.primitive !== undefined ? { primitive: component.primitive } : {}),
    ...(component.topologyClass !== undefined ? { topologyClass: component.topologyClass } : {}),
    ...(component.dimensions && Object.keys(component.dimensions).length > 0
      ? { dimensions: component.dimensions }
      : {}),
    ...(component.materialId !== undefined ? { materialId: component.materialId } : {}),
    ...(verbose ? { transform: fullTransform(component.transform) } : {}),
    children: components.filter((child) => child.parent === component.id).map(describe),
  });
  const runtime = normalizeRuntime(spec.runtime);
  return {
    name: spec.targetName,
    components: components.filter((component) => !component.parent).map(describe),
    materials: (spec.materials ?? []).map((material) => ({
      id: material.id,
      ...(material.name !== undefined ? { name: material.name } : {}),
      ...(material.pbr !== undefined ? { pbr: material.pbr as CaliPbr } : {}),
    })),
    runtime: { pivots: runtime.pivots, colliders: runtime.colliders },
    counts: { components: components.length, materials: (spec.materials ?? []).length },
  };
}

// ---------------------------------------------------------------------------
// op JSON schema (reused verbatim in the editor_asset_builder_apply tool def)

const VEC3_SCHEMA = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 } as const;
const PBR_SCHEMA = {
  type: "object",
  properties: {
    baseColor: { type: "string", description: "#rrggbb" },
    metalness: { type: "number", minimum: 0, maximum: 1 },
    roughness: { type: "number", minimum: 0, maximum: 1 },
    emissive: { type: "string", description: "#rrggbb; omit for none" },
    emissiveIntensity: { type: "number", minimum: 0 },
    map: { type: ["string", "null"], description: "data: URI or project image asset id" },
  },
} as const;

export const BUILDER_OPS_SCHEMA = {
  type: "array",
  description:
    "Batch of build ops applied in order. Bad ops are skipped and reported; the rest still apply.",
  items: {
    type: "object",
    required: ["op"],
    oneOf: [
      {
        properties: {
          op: { const: "add_component" },
          id: { type: "string" },
          name: { type: "string" },
          primitive: { type: "string", enum: [...BUILDER_PRIMITIVES] },
          dimensions: {
            type: "object",
            properties: {
              width: { type: "number" },
              height: { type: "number" },
              depth: { type: "number" },
              radius: { type: "number" },
              segments: { type: "number" },
            },
          },
          parent: { type: ["string", "null"] },
          transform: {
            type: "object",
            properties: { position: VEC3_SCHEMA, rotation: VEC3_SCHEMA, scale: VEC3_SCHEMA },
          },
          materialId: { type: "string" },
        },
        required: ["op", "name", "primitive"],
      },
      { properties: { op: { const: "remove_component" }, id: { type: "string" } }, required: ["op", "id"] },
      {
        properties: {
          op: { const: "update_component" },
          id: { type: "string" },
          patch: {
            type: "object",
            properties: {
              name: { type: "string" },
              primitive: { type: "string", enum: [...BUILDER_PRIMITIVES] },
              dimensions: { type: "object" },
              materialId: { type: "string" },
            },
          },
        },
        required: ["op", "id", "patch"],
      },
      {
        properties: {
          op: { const: "set_transform" },
          id: { type: "string" },
          position: VEC3_SCHEMA,
          rotation: VEC3_SCHEMA,
          scale: VEC3_SCHEMA,
        },
        required: ["op", "id"],
      },
      {
        properties: { op: { const: "set_parent" }, id: { type: "string" }, parent: { type: ["string", "null"] } },
        required: ["op", "id", "parent"],
      },
      {
        properties: {
          op: { const: "group" },
          ids: { type: "array", items: { type: "string" }, minItems: 1 },
          name: { type: "string" },
          id: { type: "string" },
        },
        required: ["op", "ids", "name"],
      },
      {
        properties: { op: { const: "add_material" }, id: { type: "string" }, name: { type: "string" }, pbr: PBR_SCHEMA },
        required: ["op", "name", "pbr"],
      },
      {
        properties: { op: { const: "update_material" }, id: { type: "string" }, pbr: PBR_SCHEMA },
        required: ["op", "id", "pbr"],
      },
      { properties: { op: { const: "remove_material" }, id: { type: "string" } }, required: ["op", "id"] },
      {
        properties: {
          op: { const: "assign_material" },
          componentId: { type: "string" },
          materialId: { type: "string" },
        },
        required: ["op", "componentId", "materialId"],
      },
      {
        properties: { op: { const: "set_pivot" }, id: { type: "string" }, node: { type: "string" }, axis: VEC3_SCHEMA },
        required: ["op", "node", "axis"],
      },
      {
        properties: {
          op: { const: "set_collider" },
          id: { type: "string" },
          node: { type: "string" },
          kind: { type: "string", enum: ["box", "sphere"] },
        },
        required: ["op", "node", "kind"],
      },
      { properties: { op: { const: "rename_asset" }, name: { type: "string" } }, required: ["op", "name"] },
    ],
  },
} as const;

// ---------------------------------------------------------------------------
// lookup + validation helpers

function findComponent(spec: CaliSpec, id: string): BuilderComponent | undefined {
  return (spec.componentTree as BuilderComponent[]).find((component) => component.id === id);
}

function mustComponent(spec: CaliSpec, id: string): BuilderComponent {
  const component = findComponent(spec, typeof id === "string" ? id : "");
  if (!component) throw new Error(`component "${id}" does not exist`);
  return component;
}

function findMaterial(spec: CaliSpec, id: string): BuilderMaterial | undefined {
  return (spec.materials as BuilderMaterial[]).find((material) => material.id === id);
}

/** True when `ancestorId` is `id` itself or appears anywhere up `id`'s parent chain. */
function isAncestor(spec: CaliSpec, ancestorId: string, id: string): boolean {
  let current: string | null | undefined = id;
  const seen = new Set<string>();
  while (current) {
    if (current === ancestorId) return true;
    if (seen.has(current)) return false; // pre-existing cycle; do not loop forever
    seen.add(current);
    current = findComponent(spec, current)?.parent ?? null;
  }
  return false;
}

function normalizeRuntime(runtime: CaliRuntime | undefined): CaliRuntime {
  return {
    pivots: runtime?.pivots ?? [],
    sockets: runtime?.sockets ?? [],
    colliders: runtime?.colliders ?? [],
    destructionGroups: runtime?.destructionGroups ?? [],
  };
}

function normalizePbr(pbr: CaliPbr): CaliPbr {
  if (!pbr || typeof pbr !== "object") throw new Error("pbr payload is required");
  const baseColor = pbr.baseColor ?? "#9ca3af";
  if (!HEX_COLOR.test(baseColor)) throw new Error(`baseColor "${baseColor}" is not #rrggbb`);
  if (pbr.emissive !== undefined && !HEX_COLOR.test(pbr.emissive)) {
    throw new Error(`emissive "${pbr.emissive}" is not #rrggbb`);
  }
  return {
    baseColor,
    metalness: clamp01(Number(pbr.metalness ?? 0.1)),
    roughness: clamp01(Number(pbr.roughness ?? 0.7)),
    ...(pbr.emissive !== undefined ? { emissive: pbr.emissive } : {}),
    ...(pbr.emissiveIntensity !== undefined ? { emissiveIntensity: Math.max(0, Number(pbr.emissiveIntensity)) } : {}),
    ...(pbr.map !== undefined ? { map: pbr.map } : {}),
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function generated(created: string[], id: string): string {
  created.push(id);
  return id;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function fullTransform(transform?: Partial<BuilderTransform>): BuilderTransform {
  return {
    position: [...(transform?.position ?? IDENTITY.position)] as Vec3,
    rotation: [...(transform?.rotation ?? IDENTITY.rotation)] as Vec3,
    scale: [...(transform?.scale ?? IDENTITY.scale)] as Vec3,
  };
}

function mergeTransform(base: BuilderTransform, patch?: Partial<BuilderTransform>): BuilderTransform {
  const next = cloneTransform(base);
  if (patch?.position) next.position = requireVec3(patch.position, "position");
  if (patch?.rotation) next.rotation = requireVec3(patch.rotation, "rotation");
  if (patch?.scale) next.scale = requireVec3(patch.scale, "scale");
  return next;
}

function cloneTransform(transform: BuilderTransform): BuilderTransform {
  return {
    position: [...transform.position] as Vec3,
    rotation: [...transform.rotation] as Vec3,
    scale: [...transform.scale] as Vec3,
  };
}

function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function requireVec3(value: unknown, field: string): Vec3 {
  if (!isVec3(value)) throw new Error(`${field} must be a [x, y, z] array of numbers`);
  return [...value] as Vec3;
}

function centroidOf(points: Vec3[]): Vec3 {
  const sum: Vec3 = [0, 0, 0];
  for (const point of points) {
    sum[0] += point[0];
    sum[1] += point[1];
    sum[2] += point[2];
  }
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}

function subVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

// ---------------------------------------------------------------------------
// plain 4x4 matrix math (row-major), kept three.js-free so the reducer runs
// headless. Euler order matches three.js's default "XYZ" (R = Rx · Ry · Rz).

type Mat4 = number[];

function trsMatrix(transform: BuilderTransform): Mat4 {
  const [x, y, z] = transform.rotation;
  const [sx, sy, sz] = transform.scale;
  const [tx, ty, tz] = transform.position;
  const cx = Math.cos(x), snx = Math.sin(x);
  const cy = Math.cos(y), sny = Math.sin(y);
  const cz = Math.cos(z), snz = Math.sin(z);
  // R = Rx * Ry * Rz — the matrix three.js builds for Euler order "XYZ".
  const r00 = cy * cz, r01 = -cy * snz, r02 = sny;
  const r10 = cx * snz + snx * sny * cz, r11 = cx * cz - snx * sny * snz, r12 = -snx * cy;
  const r20 = snx * snz - cx * sny * cz, r21 = snx * cz + cx * sny * snz, r22 = cx * cy;
  return [
    r00 * sx, r01 * sy, r02 * sz, tx,
    r10 * sx, r11 * sy, r12 * sz, ty,
    r20 * sx, r21 * sy, r22 * sz, tz,
    0, 0, 0, 1,
  ];
}

function mulMat4(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[row * 4 + k] * b[k * 4 + col];
      out[row * 4 + col] = sum;
    }
  }
  return out;
}

function worldMatrixOf(spec: CaliSpec, id: string): Mat4 {
  const chain: BuilderComponent[] = [];
  let current: BuilderComponent | undefined = findComponent(spec, id);
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    chain.unshift(current);
    current = current.parent ? findComponent(spec, current.parent) : undefined;
  }
  let matrix = trsMatrix(IDENTITY);
  for (const node of chain) matrix = mulMat4(matrix, trsMatrix(fullTransform(node.transform)));
  return matrix;
}

/**
 * TRS decomposition matching three.js's Euler "XYZ" extraction. Assumes
 * positive scales and no shear (true for anything this reducer composes).
 */
function decomposeTRS(m: Mat4): BuilderTransform {
  const scaleX = Math.hypot(m[0], m[4], m[8]) || 1;
  const scaleY = Math.hypot(m[1], m[5], m[9]) || 1;
  const scaleZ = Math.hypot(m[2], m[6], m[10]) || 1;
  const r02 = clampUnit(m[2] / scaleZ);
  const yRot = Math.asin(r02);
  let xRot: number;
  let zRot: number;
  if (Math.abs(r02) < 0.9999999) {
    xRot = Math.atan2(-m[6] / scaleZ, m[10] / scaleZ);
    zRot = Math.atan2(-m[1] / scaleY, m[0] / scaleX);
  } else {
    xRot = Math.atan2(m[9] / scaleY, m[5] / scaleY);
    zRot = 0;
  }
  return {
    position: [m[3], m[7], m[11]],
    rotation: [xRot, yRot, zRot],
    scale: [scaleX, scaleY, scaleZ],
  };
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(-1, value));
}
