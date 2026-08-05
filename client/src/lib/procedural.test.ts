import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { caliObjectFromSpec } from "./procedural";

describe("cali asset rendering", () => {
  it("builds a component hierarchy from a .cali spec", () => {
    const object = caliObjectFromSpec({
      componentTree: [
        {
          id: "root",
          primitive: "box",
          dimensions: { width: 1, height: 1, depth: 1 },
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          materialId: "primary",
          parent: null,
        },
        {
          id: "cap",
          primitive: "cylinder",
          dimensions: { radius: 0.3, height: 0.4 },
          transform: { position: [0, 0.7, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          materialId: "primary",
          parent: "root",
        },
      ],
      materials: [{ id: "primary", pbr: { baseColor: "#ff8800", metalness: 0.2, roughness: 0.4 } }],
    });
    expect(object.children.length).toBe(1);
    expect((object.children[0] as THREE.Object3D).children.length).toBe(1);
  });
});

