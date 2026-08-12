import { describe, expect, it } from "vitest";
import type { CaliSpec } from "./assetPipeline";
import type { Asset } from "./types";
import {
  applyOps,
  describeSpec,
  emptySpec,
  fullTransform,
  specFromProcedural,
  type ApplyResult,
  type BuilderComponent,
  type BuilderOp,
  type CaliPbr,
} from "./assetBuilderOps";

/** Apply expecting every op to succeed. */
function must(spec: CaliSpec, ops: BuilderOp[]): ApplyResult {
  const result = applyOps(spec, ops);
  expect(result.errors).toEqual([]);
  expect(result.applied).toBe(ops.length);
  return result;
}

function component(spec: CaliSpec, id: string): BuilderComponent {
  const found = (spec.componentTree as BuilderComponent[]).find((entry) => entry.id === id);
  if (!found) throw new Error(`test: component ${id} missing`);
  return found;
}

function pbrOf(spec: CaliSpec, id: string): CaliPbr {
  const material = spec.materials.find((entry) => entry.id === id);
  if (!material?.pbr) throw new Error(`test: material ${id} missing`);
  return material.pbr as CaliPbr;
}

describe("emptySpec", () => {
  it("creates a valid spec with one root group and one material", () => {
    const spec = emptySpec("Crate");
    expect(spec.targetName).toBe("Crate");
    expect(spec.componentTree).toHaveLength(1);
    expect(spec.componentTree[0].parent).toBeNull();
    expect(spec.componentTree[0].topologyClass).toBe("group");
    expect(spec.materials).toHaveLength(1);
    expect(spec.runtime.pivots).toEqual([]);
    // Round-trips through JSON, like everything in project state must.
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
  });
});

describe("applyOps basics", () => {
  it("does not mutate the input spec", () => {
    const spec = emptySpec("A");
    const frozen = JSON.stringify(spec);
    applyOps(spec, [{ op: "add_component", name: "b", primitive: "box", parent: "comp-root" }]);
    expect(JSON.stringify(spec)).toBe(frozen);
  });

  it("rejects a non-array ops payload without throwing", () => {
    const result = applyOps(emptySpec("A"), null as unknown as BuilderOp[]);
    expect(result.applied).toBe(0);
    expect(result.errors[0]).toMatch(/array/);
  });

  it("applies the rest of a batch when one op is bad", () => {
    const result = applyOps(emptySpec("A"), [
      { op: "add_component", id: "a", name: "a", primitive: "box", parent: "comp-root" },
      { op: "remove_component", id: "no-such-node" },
      { op: "add_component", id: "b", name: "b", primitive: "sphere", parent: "comp-root" },
    ]);
    expect(result.applied).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/op\[1\] remove_component/);
    expect(component(result.spec, "a")).toBeDefined();
    expect(component(result.spec, "b")).toBeDefined();
  });
});

describe("add_component", () => {
  it("adds with defaults and generates ids", () => {
    const result = must(emptySpec("A"), [{ op: "add_component", name: "Body", primitive: "box" }]);
    expect(result.created).toHaveLength(1);
    const added = component(result.spec, result.created[0]);
    expect(added.parent).toBeNull();
    expect(added.primitive).toBe("box");
    expect(fullTransform(added.transform)).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
  });

  it("honors explicit id, parent, dimensions, transform and material", () => {
    const result = must(emptySpec("A"), [
      {
        op: "add_component",
        id: "lid",
        name: "Lid",
        primitive: "cylinder",
        parent: "comp-root",
        dimensions: { radius: 0.4, height: 0.1 },
        transform: { position: [0, 1, 0] },
        materialId: "mat-default",
      },
    ]);
    expect(result.created).toEqual([]);
    const lid = component(result.spec, "lid");
    expect(lid.parent).toBe("comp-root");
    expect(lid.dimensions).toEqual({ radius: 0.4, height: 0.1 });
    expect(lid.materialId).toBe("mat-default");
    expect(fullTransform(lid.transform).position).toEqual([0, 1, 0]);
  });

  it("refuses duplicate ids, missing parents, unknown materials and primitives", () => {
    const spec = emptySpec("A");
    const bad = applyOps(spec, [
      { op: "add_component", id: "comp-root", name: "dup", primitive: "box" },
      { op: "add_component", name: "orphan", primitive: "box", parent: "ghost" },
      { op: "add_component", name: "nomat", primitive: "box", materialId: "ghost" },
      { op: "add_component", name: "shape", primitive: "dodecahedron" as never },
    ]);
    expect(bad.applied).toBe(0);
    expect(bad.errors).toHaveLength(4);
  });
});

describe("update_component and set_transform", () => {
  it("patches only the given fields", () => {
    const start = must(emptySpec("A"), [
      { op: "add_component", id: "a", name: "a", primitive: "box", dimensions: { width: 2 } },
    ]).spec;
    const result = must(start, [{ op: "update_component", id: "a", patch: { name: "renamed", primitive: "cone" } }]);
    const updated = component(result.spec, "a");
    expect(updated.name).toBe("renamed");
    expect(updated.primitive).toBe("cone");
    expect(updated.dimensions).toEqual({ width: 2 });
  });

  it("refuses unknown component or material in the patch", () => {
    const start = must(emptySpec("A"), [{ op: "add_component", id: "a", name: "a", primitive: "box" }]).spec;
    const bad = applyOps(start, [
      { op: "update_component", id: "ghost", patch: { name: "x" } },
      { op: "update_component", id: "a", patch: { materialId: "ghost" } },
    ]);
    expect(bad.applied).toBe(0);
    expect(bad.errors).toHaveLength(2);
  });

  it("set_transform merges axes and keeps the rest", () => {
    const start = must(emptySpec("A"), [
      { op: "add_component", id: "a", name: "a", primitive: "box", transform: { position: [1, 2, 3] } },
    ]).spec;
    const result = must(start, [{ op: "set_transform", id: "a", rotation: [0, Math.PI / 2, 0] }]);
    const transform = fullTransform(component(result.spec, "a").transform);
    expect(transform.position).toEqual([1, 2, 3]);
    expect(transform.rotation[1]).toBeCloseTo(Math.PI / 2);
    expect(transform.scale).toEqual([1, 1, 1]);
  });

  it("set_transform rejects malformed vectors", () => {
    const start = must(emptySpec("A"), [{ op: "add_component", id: "a", name: "a", primitive: "box" }]).spec;
    const bad = applyOps(start, [{ op: "set_transform", id: "a", position: [1, 2] as never }]);
    expect(bad.applied).toBe(0);
    expect(bad.errors[0]).toMatch(/position/);
  });
});

describe("set_parent", () => {
  function chain(): CaliSpec {
    return must(emptySpec("A"), [
      { op: "add_component", id: "a", name: "a", primitive: "box" },
      { op: "add_component", id: "b", name: "b", primitive: "box", parent: "a" },
      { op: "add_component", id: "c", name: "c", primitive: "box", parent: "b" },
    ]).spec;
  }

  it("re-parents", () => {
    const result = must(chain(), [{ op: "set_parent", id: "c", parent: "a" }]);
    expect(component(result.spec, "c").parent).toBe("a");
  });

  it("refuses self, cycles, and unknown parents", () => {
    const bad = applyOps(chain(), [
      { op: "set_parent", id: "a", parent: "a" },
      { op: "set_parent", id: "a", parent: "c" }, // c is a descendant of a
      { op: "set_parent", id: "a", parent: "ghost" },
    ]);
    expect(bad.applied).toBe(0);
    expect(bad.errors).toHaveLength(3);
    expect(bad.errors[1]).toMatch(/cycle/);
  });
});

describe("remove_component", () => {
  it("re-parents children upward and rebases their transforms", () => {
    const start = must(emptySpec("A"), [
      { op: "add_component", id: "arm", name: "arm", primitive: "box", transform: { position: [1, 0, 0] } },
      { op: "add_component", id: "hand", name: "hand", primitive: "box", parent: "arm", transform: { position: [1, 0, 0] } },
    ]).spec;
    const result = must(start, [{ op: "remove_component", id: "arm" }]);
    expect((result.spec.componentTree as BuilderComponent[]).some((entry) => entry.id === "arm")).toBe(false);
    const hand = component(result.spec, "hand");
    expect(hand.parent).toBeNull();
    // World position preserved: was arm(1,0,0) + hand(1,0,0).
    expect(fullTransform(hand.transform).position[0]).toBeCloseTo(2);
  });

  it("drops pivots and colliders that referenced the node", () => {
    const start = must(emptySpec("A"), [
      { op: "add_component", id: "wheel", name: "wheel", primitive: "cylinder" },
      { op: "set_pivot", id: "pivot-1", node: "wheel", axis: [0, 1, 0] },
      { op: "set_collider", id: "col-1", node: "wheel", kind: "sphere" },
      { op: "set_pivot", id: "pivot-2", node: "comp-root", axis: [1, 0, 0] },
    ]).spec;
    const result = must(start, [{ op: "remove_component", id: "wheel" }]);
    expect(result.spec.runtime.pivots.map((pivot) => pivot.id)).toEqual(["pivot-2"]);
    expect(result.spec.runtime.colliders).toEqual([]);
  });
});

describe("group", () => {
  it("same-parent grouping puts the group at the centroid and subtracts member positions", () => {
    const start = must(emptySpec("A"), [
      { op: "add_component", id: "a", name: "a", primitive: "box", parent: "comp-root", transform: { position: [2, 0, 0] } },
      { op: "add_component", id: "b", name: "b", primitive: "box", parent: "comp-root", transform: { position: [4, 2, 0] } },
    ]).spec;
    const result = must(start, [{ op: "group", id: "grp", ids: ["a", "b"], name: "pair" }]);
    const group = component(result.spec, "grp");
    expect(group.parent).toBe("comp-root");
    expect(group.topologyClass).toBe("group");
    expect(group.primitive).toBeUndefined();
    expect(fullTransform(group.transform).position).toEqual([3, 1, 0]);
    expect(component(result.spec, "a").parent).toBe("grp");
    expect(fullTransform(component(result.spec, "a").transform).position).toEqual([-1, -1, 0]);
    expect(fullTransform(component(result.spec, "b").transform).position).toEqual([1, 1, 0]);
    // Rotation and scale untouched by the simple-subtract branch.
    expect(fullTransform(component(result.spec, "a").transform).rotation).toEqual([0, 0, 0]);
  });

  it("mixed-parent grouping preserves world positions through the re-parent", () => {
    const start = must(emptySpec("A"), [
      { op: "add_component", id: "base", name: "base", primitive: "box", transform: { position: [10, 0, 0] } },
      { op: "add_component", id: "child", name: "child", primitive: "box", parent: "base", transform: { position: [2, 0, 0] } },
      { op: "add_component", id: "loose", name: "loose", primitive: "box", transform: { position: [0, 0, 6] } },
    ]).spec;
    // child world = (12,0,0); loose world = (0,0,6) → centroid (6,0,3).
    const result = must(start, [{ op: "group", id: "grp", ids: ["child", "loose"], name: "mixed" }]);
    const group = component(result.spec, "grp");
    expect(group.parent).toBeNull();
    expect(fullTransform(group.transform).position).toEqual([6, 0, 3]);
    const child = fullTransform(component(result.spec, "child").transform);
    expect(child.position[0]).toBeCloseTo(6);
    expect(child.position[2]).toBeCloseTo(-3);
    const loose = fullTransform(component(result.spec, "loose").transform);
    expect(loose.position[0]).toBeCloseTo(-6);
    expect(loose.position[2]).toBeCloseTo(3);
  });

  it("rebases rotated members correctly in the mixed-parent branch", () => {
    const quarter = Math.PI / 2;
    const start = must(emptySpec("A"), [
      { op: "add_component", id: "turn", name: "turn", primitive: "box", transform: { rotation: [0, quarter, 0] } },
      { op: "add_component", id: "tip", name: "tip", primitive: "box", parent: "turn", transform: { position: [1, 0, 0] } },
      { op: "add_component", id: "flat", name: "flat", primitive: "box", transform: { position: [0, 0, 0] } },
    ]).spec;
    // tip world position = Ry(90°)·(1,0,0) = (0,0,-1); centroid with flat(0,0,0) = (0,0,-0.5).
    const result = must(start, [{ op: "group", id: "grp", ids: ["tip", "flat"], name: "g" }]);
    const tip = fullTransform(component(result.spec, "tip").transform);
    expect(tip.position[0]).toBeCloseTo(0);
    expect(tip.position[2]).toBeCloseTo(-0.5);
    expect(tip.rotation[1]).toBeCloseTo(quarter);
    expect(tip.scale[0]).toBeCloseTo(1);
  });

  it("refuses empty, duplicate, unknown and ancestor-of-member ids", () => {
    const start = must(emptySpec("A"), [
      { op: "add_component", id: "a", name: "a", primitive: "box" },
      { op: "add_component", id: "b", name: "b", primitive: "box", parent: "a" },
    ]).spec;
    const bad = applyOps(start, [
      { op: "group", ids: [], name: "g" },
      { op: "group", ids: ["a", "a"], name: "g" },
      { op: "group", ids: ["a", "ghost"], name: "g" },
      { op: "group", ids: ["a", "b"], name: "g" }, // a is b's ancestor
    ]);
    expect(bad.applied).toBe(0);
    expect(bad.errors).toHaveLength(4);
  });
});

describe("materials", () => {
  it("adds, normalizes, updates and assigns", () => {
    const result = must(emptySpec("A"), [
      { op: "add_component", id: "a", name: "a", primitive: "box" },
      { op: "add_material", id: "mat-glow", name: "Glow", pbr: { baseColor: "#ff0000", metalness: 4, roughness: -1 } },
      { op: "update_material", id: "mat-glow", pbr: { emissive: "#00ff00", emissiveIntensity: 2 } },
      { op: "assign_material", componentId: "a", materialId: "mat-glow" },
    ]);
    const pbr = pbrOf(result.spec, "mat-glow");
    expect(pbr.metalness).toBe(1); // clamped
    expect(pbr.roughness).toBe(0); // clamped
    expect(pbr.emissive).toBe("#00ff00");
    expect(pbr.emissiveIntensity).toBe(2);
    expect(pbr.baseColor).toBe("#ff0000"); // update kept the existing base
    expect(component(result.spec, "a").materialId).toBe("mat-glow");
  });

  it("supports texture map slots including clearing", () => {
    const start = must(emptySpec("A"), [
      { op: "add_material", id: "mat-tex", name: "Tex", pbr: { baseColor: "#ffffff", metalness: 0, roughness: 1, map: "data:image/png;base64,AAAA" } },
    ]).spec;
    expect(pbrOf(start, "mat-tex").map).toBe("data:image/png;base64,AAAA");
    const cleared = must(start, [{ op: "update_material", id: "mat-tex", pbr: { map: null } }]);
    expect(pbrOf(cleared.spec, "mat-tex").map).toBeNull();
  });

  it("refuses bad colors and unknown ids", () => {
    const bad = applyOps(emptySpec("A"), [
      { op: "add_material", name: "Bad", pbr: { baseColor: "red", metalness: 0, roughness: 1 } },
      { op: "update_material", id: "ghost", pbr: { metalness: 1 } },
      { op: "assign_material", componentId: "comp-root", materialId: "ghost" },
      { op: "add_material", id: "mat-default", name: "Dup", pbr: { baseColor: "#ffffff", metalness: 0, roughness: 1 } },
    ]);
    expect(bad.applied).toBe(0);
    expect(bad.errors).toHaveLength(4);
  });

  it("refuses removal while referenced, allows it after unassignment", () => {
    const start = must(emptySpec("A"), [
      { op: "add_component", id: "a", name: "a", primitive: "box", materialId: "mat-default" },
    ]).spec;
    const refused = applyOps(start, [{ op: "remove_material", id: "mat-default" }]);
    expect(refused.applied).toBe(0);
    expect(refused.errors[0]).toMatch(/referenced/);
    const freed = must(start, [
      { op: "add_material", id: "mat-2", name: "Other", pbr: { baseColor: "#111111", metalness: 0, roughness: 1 } },
      { op: "assign_material", componentId: "a", materialId: "mat-2" },
      { op: "remove_material", id: "mat-default" },
    ]);
    expect(freed.spec.materials.map((material) => material.id)).toEqual(["mat-2"]);
  });
});

describe("pivots and colliders", () => {
  it("creates with generated ids and updates in place by id", () => {
    const first = must(emptySpec("A"), [{ op: "set_pivot", node: "comp-root", axis: [0, 1, 0] }]);
    expect(first.created).toHaveLength(1);
    const pivotId = first.created[0];
    const second = must(first.spec, [{ op: "set_pivot", id: pivotId, node: "comp-root", axis: [1, 0, 0] }]);
    expect(second.spec.runtime.pivots).toHaveLength(1);
    expect(second.spec.runtime.pivots[0].axis).toEqual([1, 0, 0]);
  });

  it("validates node, axis, and collider kind", () => {
    const bad = applyOps(emptySpec("A"), [
      { op: "set_pivot", node: "ghost", axis: [0, 1, 0] },
      { op: "set_pivot", node: "comp-root", axis: "up" as never },
      { op: "set_collider", node: "comp-root", kind: "capsule" as never },
    ]);
    expect(bad.applied).toBe(0);
    expect(bad.errors).toHaveLength(3);
  });

  it("initializes a missing runtime block instead of crashing", () => {
    const spec = emptySpec("A");
    delete (spec as Partial<CaliSpec>).runtime;
    const result = must(spec, [{ op: "set_collider", node: "comp-root", kind: "box" }]);
    expect(result.spec.runtime.colliders).toHaveLength(1);
    expect(result.spec.runtime.sockets).toEqual([]);
  });
});

describe("rename_asset", () => {
  it("renames and rejects empty names", () => {
    const renamed = must(emptySpec("A"), [{ op: "rename_asset", name: "Barrel" }]);
    expect(renamed.spec.targetName).toBe("Barrel");
    const bad = applyOps(emptySpec("A"), [{ op: "rename_asset", name: "  " }]);
    expect(bad.applied).toBe(0);
  });
});

describe("describeSpec", () => {
  it("nests children and omits transforms unless verbose", () => {
    const spec = must(emptySpec("Tower"), [
      { op: "add_component", id: "a", name: "base", primitive: "box", parent: "comp-root", dimensions: { width: 2 } },
      { op: "add_component", id: "b", name: "top", primitive: "cone", parent: "a", materialId: "mat-default" },
    ]).spec;
    const compact = describeSpec(spec);
    expect(compact.name).toBe("Tower");
    expect(compact.counts).toEqual({ components: 3, materials: 1 });
    const root = compact.components[0];
    expect(root.id).toBe("comp-root");
    expect(root.children[0].id).toBe("a");
    expect(root.children[0].dimensions).toEqual({ width: 2 });
    expect(root.children[0].children[0].materialId).toBe("mat-default");
    expect(root.children[0].transform).toBeUndefined();
    const verbose = describeSpec(spec, true);
    expect(verbose.components[0].children[0].transform).toBeDefined();
  });
});

describe("specFromProcedural", () => {
  it("maps generator metadata into a one-component spec", () => {
    const asset: Asset = {
      id: "asset-1",
      name: "Drum",
      type: "procedural",
      source: "procedural:cylinder",
      tags: [],
      usage: [],
      thumbnail: null,
      metadata: { generator: "cylinder", radius: 0.4, height: 1.2, color: "#aabbcc", metalness: 0.3, roughness: 0.5 },
    };
    const spec = specFromProcedural(asset);
    expect(spec.targetName).toBe("Drum");
    const main = (spec.componentTree as BuilderComponent[]).find((entry) => entry.id === "comp-main");
    expect(main?.primitive).toBe("cylinder");
    expect(main?.dimensions).toEqual({ height: 1.2, radius: 0.4 });
    expect(main?.materialId).toBe("mat-default");
    expect(pbrOf(spec, "mat-default")).toEqual({ baseColor: "#aabbcc", metalness: 0.3, roughness: 0.5 });
    // The result must be a spec the reducer can keep editing.
    const grown = applyOps(spec, [{ op: "add_component", name: "lid", primitive: "plane", parent: "comp-main" }]);
    expect(grown.errors).toEqual([]);
  });

  it("falls back to box and defaults on unknown generators", () => {
    const asset: Asset = {
      id: "asset-2",
      name: "Mystery",
      type: "procedural",
      source: "procedural:terrain",
      tags: [],
      usage: [],
      thumbnail: null,
      metadata: { color: "not-a-color" },
    };
    const spec = specFromProcedural(asset);
    const main = (spec.componentTree as BuilderComponent[]).find((entry) => entry.id === "comp-main");
    expect(main?.primitive).toBe("box");
    expect(pbrOf(spec, "mat-default").baseColor).toBe("#9ca3af");
  });
});

describe("undo snapshot round-trip", () => {
  it("a snapshot taken before ops restores the exact prior state", () => {
    const before = emptySpec("Snap");
    const snapshot = structuredClone(before);
    const after = must(before, [
      { op: "add_component", id: "x", name: "x", primitive: "torus" },
      { op: "rename_asset", name: "Changed" },
    ]).spec;
    expect(after.targetName).toBe("Changed");
    // Undo = replace with snapshot; nothing in the applied spec leaks back.
    expect(snapshot).toEqual(emptySpec("Snap"));
    expect((snapshot.componentTree as BuilderComponent[]).some((entry) => entry.id === "x")).toBe(false);
  });
});
