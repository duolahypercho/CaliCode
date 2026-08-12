import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  assetObject,
  buildScene,
  caliObjectFromSpec,
  createMaterial,
  getGltfAssetInstance,
  meshGeometry,
  waitForAssetReadiness,
} from "./procedural";
import type { Asset, Project } from "./types";

describe("entity material rendering", () => {
  it("preserves emissive fields on ordinary scene entities", () => {
    const project: Project = {
      schemaVersion: 1,
      slug: "glow",
      title: "Glow",
      settings: {},
      scripts: [],
      assets: [],
      tests: [],
      entities: [
        {
          id: "beacon",
          name: "Beacon",
          kind: "box",
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          material: {
            color: "#112233",
            emissive: "#00ffff",
            emissiveIntensity: 2.75,
            metalness: 0.4,
            roughness: 0.2,
          },
          light: {},
          scriptIds: [],
          assetId: null,
        },
      ],
    };

    let mesh: THREE.Mesh | null = null;
    buildScene(project).traverse((node) => {
      if (!mesh && node instanceof THREE.Mesh) mesh = node;
    });
    expect(mesh).not.toBeNull();
    const material = (mesh as unknown as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
    expect(material.color.getHexString()).toBe("112233");
    expect(material.emissive.getHexString()).toBe("00ffff");
    expect(material.emissiveIntensity).toBe(2.75);
  });

  it("defaults emissive to black without muting explicitly configured glow", () => {
    expect(createMaterial().emissive.getHexString()).toBe("000000");
    const glowing = createMaterial({
      emissive: "#ff00ff",
      emissiveIntensity: 3,
    });
    expect(glowing.emissive.getHexString()).toBe("ff00ff");
    expect(glowing.emissiveIntensity).toBe(3);
  });

  it("renders an explicitly patterned plane as a transparent procedural grid", () => {
    const project: Project = {
      schemaVersion: 1,
      slug: "grid-contract",
      title: "Grid Contract",
      settings: {},
      scripts: [],
      assets: [],
      tests: [],
      entities: [
        {
          id: "arena-grid",
          name: "Arena Surface",
          kind: "plane",
          transform: {
            position: [0, 0, 0],
            rotation: [-Math.PI / 2, 0, 0],
            scale: [12, 8, 1],
          },
          material: {
            pattern: "grid",
            color: "#001118",
            emissive: "#00f0ff",
            emissiveIntensity: 1.4,
            gridCellSize: 2,
            gridLineWidth: 0.03,
          },
          light: {},
          scriptIds: [],
          assetId: null,
        },
      ],
    };

    const object = buildScene(project).children[0];
    const grid = object.children[0] as THREE.Mesh<
      THREE.PlaneGeometry,
      THREE.ShaderMaterial
    >;
    expect(grid).toBeInstanceOf(THREE.Mesh);
    expect(grid.userData.caliPattern).toBe("grid");
    expect(grid.material).toBeInstanceOf(THREE.ShaderMaterial);
    expect(grid.material.transparent).toBe(true);
    expect(grid.material.depthWrite).toBe(false);
    expect(grid.material.fragmentShader).toContain("discard");
    expect(
      (grid.material.uniforms.divisions.value as THREE.Vector2).toArray(),
    ).toEqual([6, 4]);
  });

  it("upgrades legacy grid-named planes while preserving ordinary planes", () => {
    const entity = (id: string, name: string): Project["entities"][number] => ({
      id,
      name,
      kind: "plane",
      transform: {
        position: [0, 0, 0],
        rotation: [-Math.PI / 2, 0, 0],
        scale: [10, 6, 1],
      },
      material: {
        color: "#00f0ff",
        emissive: "#00f0ff",
        emissiveIntensity: 0.6,
      },
      light: {},
      scriptIds: [],
      assetId: null,
    });
    const project: Project = {
      schemaVersion: 1,
      slug: "legacy-grid",
      title: "Legacy Grid",
      settings: {},
      scripts: [],
      assets: [],
      tests: [],
      entities: [entity("grid", "FloorGrid"), entity("floor", "Floor")],
    };

    const [gridObject, floorObject] = buildScene(project).children;
    expect((gridObject.children[0] as THREE.Mesh).material).toBeInstanceOf(
      THREE.ShaderMaterial,
    );
    expect((floorObject.children[0] as THREE.Mesh).material).toBeInstanceOf(
      THREE.MeshStandardMaterial,
    );
  });
});

describe("cali asset rendering", () => {
  it("builds a component hierarchy from a .cali spec", () => {
    const object = caliObjectFromSpec({
      componentTree: [
        {
          id: "root",
          primitive: "box",
          dimensions: { width: 1, height: 1, depth: 1 },
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          materialId: "primary",
          parent: null,
        },
        {
          id: "cap",
          primitive: "cylinder",
          dimensions: { radius: 0.3, height: 0.4 },
          transform: {
            position: [0, 0.7, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          materialId: "primary",
          parent: "root",
        },
      ],
      materials: [
        {
          id: "primary",
          pbr: { baseColor: "#ff8800", metalness: 0.2, roughness: 0.4 },
        },
      ],
    });
    expect(object.children.length).toBe(1);
    expect((object.children[0] as THREE.Object3D).children.length).toBe(1);
  });

  it("tags every node with its componentId for picking", () => {
    const object = caliObjectFromSpec({
      componentTree: [
        { id: "root", primitive: "box", parent: null },
        { id: "child", topologyClass: "group", parent: "root" },
      ],
      materials: [],
    });
    const root = object.children[0];
    expect(root.userData.componentId).toBe("root");
    expect(root.children[0].userData.componentId).toBe("child");
  });

  describe("mesh primitive branch", () => {
    // The buffer layout core's image3d_mesh emits (image_mesh.rs::mesh_to_cali_spec):
    // flat positions/uvs, triangle indices, no normals.
    const triangle = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      uvs: [0, 0, 1, 0, 0, 1],
    };

    it("builds a BufferGeometry from a mesh component payload", () => {
      const object = caliObjectFromSpec({
        componentTree: [
          {
            id: "mesh-root",
            topologyClass: "image-mesh",
            primitive: "mesh",
            mesh: triangle,
            transform: {
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
            },
            materialId: "material-image",
            parent: null,
          },
        ],
        materials: [
          {
            id: "material-image",
            pbr: { baseColor: "#ffffff", metalness: 0, roughness: 0.85 },
          },
        ],
      });
      const mesh = object.children[0] as THREE.Mesh;
      expect(mesh).toBeInstanceOf(THREE.Mesh);
      const geometry = mesh.geometry as THREE.BufferGeometry;
      expect(geometry.getAttribute("position").count).toBe(3);
      expect(Array.from(geometry.getIndex()!.array)).toEqual([0, 1, 2]);
      expect(geometry.getAttribute("uv").count).toBe(3);
      // Normals absent in the payload -> computed. Flat +z triangle.
      const normal = geometry.getAttribute("normal");
      expect(normal.count).toBe(3);
      expect(normal.getZ(0)).toBeCloseTo(1);
    });

    it("uses provided normals instead of recomputing them", () => {
      const geometry = meshGeometry({
        ...triangle,
        normals: [0, 0, -1, 0, 0, -1, 0, 0, -1],
      });
      expect(geometry.getAttribute("normal").getZ(1)).toBeCloseTo(-1);
    });

    it("tolerates an empty mesh payload", () => {
      const geometry = meshGeometry({});
      expect(geometry.getAttribute("position").count).toBe(0);
    });
  });

  describe("group nodes", () => {
    it("renders topologyClass group components as bare groups", () => {
      const object = caliObjectFromSpec({
        componentTree: [
          {
            id: "wrapper",
            topologyClass: "group",
            parent: null,
            transform: {
              position: [1, 2, 3],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
            },
          },
          {
            id: "leaf",
            primitive: "sphere",
            dimensions: { radius: 0.5 },
            parent: "wrapper",
          },
        ],
        materials: [],
      });
      const wrapper = object.children[0];
      expect(wrapper).toBeInstanceOf(THREE.Group);
      expect(wrapper).not.toBeInstanceOf(THREE.Mesh);
      expect(wrapper.position.toArray()).toEqual([1, 2, 3]);
      expect(wrapper.children[0]).toBeInstanceOf(THREE.Mesh);
    });

    it("renders components without a primitive as groups instead of unit boxes", () => {
      const object = caliObjectFromSpec({
        componentTree: [{ id: "bare", parent: null }],
        materials: [],
      });
      expect(object.children[0]).toBeInstanceOf(THREE.Group);
    });
  });

  describe("extended PBR", () => {
    it("applies emissive, emissiveIntensity, and a data-URI map", () => {
      const onePixelPng =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const object = caliObjectFromSpec({
        componentTree: [
          { id: "root", primitive: "box", materialId: "glow", parent: null },
        ],
        materials: [
          {
            id: "glow",
            pbr: {
              baseColor: "#112233",
              metalness: 0.5,
              roughness: 0.25,
              emissive: "#ff0000",
              emissiveIntensity: 2.5,
              map: onePixelPng,
            },
          },
        ],
      });
      const material = (object.children[0] as THREE.Mesh)
        .material as THREE.MeshStandardMaterial;
      expect(material.emissive.getHexString()).toBe("ff0000");
      expect(material.emissiveIntensity).toBe(2.5);
      expect(material.map).toBeTruthy();
      expect(material.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    });

    it("resolves a map asset id to the referenced asset's data URI", () => {
      const assets: Asset[] = [
        {
          id: "asset-tex",
          name: "Tex",
          type: "image",
          source: "data:image/png;base64,AAAA",
          tags: [],
          usage: [],
          thumbnail: null,
        },
      ];
      const object = caliObjectFromSpec(
        {
          componentTree: [
            { id: "root", primitive: "box", materialId: "m", parent: null },
          ],
          materials: [
            { id: "m", pbr: { baseColor: "#ffffff", map: "asset-tex" } },
          ],
        },
        assets,
      );
      const material = (object.children[0] as THREE.Mesh)
        .material as THREE.MeshStandardMaterial;
      expect(material.map).toBeTruthy();
    });

    it("leaves the map unset when an asset id cannot be resolved", () => {
      const object = caliObjectFromSpec({
        componentTree: [
          { id: "root", primitive: "box", materialId: "m", parent: null },
        ],
        materials: [
          { id: "m", pbr: { baseColor: "#ffffff", map: "asset-missing" } },
        ],
      });
      const material = (object.children[0] as THREE.Mesh)
        .material as THREE.MeshStandardMaterial;
      expect(material.map).toBeNull();
    });
  });

  describe("texture caching", () => {
    const specWithMap = (map: string) => ({
      componentTree: [
        { id: "root", primitive: "box", materialId: "m", parent: null },
      ],
      materials: [{ id: "m", pbr: { baseColor: "#ffffff", map } }],
    });

    it("loads a repeated mapUrl once across rebuilds and shares the texture", () => {
      const load = vi.spyOn(THREE.TextureLoader.prototype, "load");
      const url = "data:image/png;base64,cache-hit-test";
      const first = caliObjectFromSpec(specWithMap(url));
      const second = caliObjectFromSpec(specWithMap(url));
      const mapOf = (object: THREE.Group) =>
        (
          (object.children[0] as THREE.Mesh)
            .material as THREE.MeshStandardMaterial
        ).map;
      expect(load).toHaveBeenCalledTimes(1);
      expect(mapOf(first)).toBe(mapOf(second));
      load.mockRestore();
    });

    it("evicts a failed load so the next rebuild retries", () => {
      const load = vi
        .spyOn(THREE.TextureLoader.prototype, "load")
        .mockImplementation((url, _onLoad, _onProgress, onError) => {
          onError?.(new ErrorEvent("error") as unknown as ErrorEvent);
          return new THREE.Texture();
        });
      const url = "data:image/png;base64,cache-evict-test";
      caliObjectFromSpec(specWithMap(url));
      caliObjectFromSpec(specWithMap(url));
      expect(load).toHaveBeenCalledTimes(2);
      load.mockRestore();
    });
  });
});

describe("glTF assets", () => {
  it("returns a placeholder group when a relative source has no slug", () => {
    const asset: Asset = {
      id: "asset-model",
      name: "Model",
      type: "gltf",
      source: "polyhaven/barrel/barrel.gltf",
      tags: [],
      usage: [],
      thumbnail: null,
    };
    const object = assetObject(asset);
    expect(object).toBeInstanceOf(THREE.Group);
    expect(object.children.length).toBe(0);
  });

  it("retains animation clips and creates an independent playable instance", async () => {
    const source = new THREE.Group();
    const clip = new THREE.AnimationClip("slide", 1, [
      new THREE.NumberKeyframeTrack(".position[x]", [0, 1], [0, 1]),
    ]);
    const loadAsync = vi
      .spyOn(GLTFLoader.prototype, "loadAsync")
      .mockResolvedValue({
        scene: source,
        animations: [clip],
      } as never);
    try {
      const object = assetObject(
        {
          id: "animated-model",
          name: "Animated",
          type: "gltf",
          source: "animated/clip.gltf",
          tags: [],
          usage: [],
          thumbnail: null,
        },
        "procedural-contract-test",
      );
      const instance = getGltfAssetInstance(object);
      expect(instance).toBeTruthy();
      await waitForAssetReadiness(object);

      expect(object.children).toHaveLength(1);
      expect(object.children[0]).not.toBe(source);
      expect(instance?.clips).toEqual([clip]);
      expect(instance?.mixers.size).toBe(1);
      expect(source.position.x).toBe(0);
      instance?.mixers.forEach((mixer) => mixer.update(0.5));
      expect(object.children[0].position.x).toBeCloseTo(0.5);
    } finally {
      loadAsync.mockRestore();
    }
  });

  it("settles readiness when a glTF load fails", async () => {
    const loadAsync = vi
      .spyOn(GLTFLoader.prototype, "loadAsync")
      .mockRejectedValue(new Error("missing glTF"));
    try {
      const object = assetObject(
        {
          id: "broken-model",
          name: "Broken",
          type: "gltf",
          source: "broken/clip.gltf",
          tags: [],
          usage: [],
          thumbnail: null,
        },
        "procedural-failure-test",
      );
      await expect(waitForAssetReadiness(object, 20)).resolves.toBeUndefined();
      const instance = getGltfAssetInstance(object);
      expect(instance?.error?.message).toBe("missing glTF");
      expect(object.children).toHaveLength(0);
    } finally {
      loadAsync.mockRestore();
    }
  });
});

describe("entity material overrides reach cali asset meshes", () => {
  function glowSpec() {
    return {
      schemaVersion: 1,
      assetId: "neon-pad",
      name: "Neon Pad",
      sourceHash: "h",
      seed: 1,
      assessment: {},
      detailInventory: [],
      componentTree: [
        {
          id: "pad",
          name: "Pad",
          primitive: "box",
          dimensions: { width: 1, height: 1, depth: 1 },
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          materialId: "pad-mat",
          parent: null,
        },
      ],
      materials: [
        {
          id: "pad-mat",
          name: "Pad Mat",
          pbr: {
            baseColor: "#ffffff",
            metalness: 0,
            roughness: 0.85,
          },
        },
      ],
      runtime: {
        pivots: [],
        sockets: [],
        colliders: [],
        destructionGroups: [],
      },
      reviewHistory: [],
    };
  }

  it("applies emissive + emissiveIntensity to the cali mesh material", () => {
    const project: Project = {
      schemaVersion: 1,
      slug: "neon-bridge",
      title: "Neon Bridge",
      settings: {},
      scripts: [],
      tests: [],
      assets: [
        {
          id: "neon-pad-asset",
          name: "Neon Pad",
          type: "cali",
          source: "neon-pad.cali.json",
          tags: [],
          usage: [],
          thumbnail: null,
          metadata: { cali: glowSpec() },
        },
      ],
      entities: [
        {
          id: "pad",
          name: "Pad",
          kind: "box",
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          material: {
            color: "#ffffff",
            emissive: "#00ffff",
            emissiveIntensity: 2.5,
            metalness: 0,
            roughness: 0.25,
          },
          light: {},
          scriptIds: [],
          assetId: "neon-pad-asset",
        },
      ],
    };
    let mesh: THREE.Mesh | null = null;
    buildScene(project).traverse((node) => {
      if (!mesh && node instanceof THREE.Mesh) mesh = node;
    });
    expect(mesh).not.toBeNull();
    const material = (mesh as unknown as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
    expect(material.emissive.getHexString()).toBe("00ffff");
    expect(material.emissiveIntensity).toBe(2.5);
    expect(material.roughness).toBe(0.25);
  });

  it("entity wins over the cali spec for fields the entity set", () => {
    const project: Project = {
      schemaVersion: 1,
      slug: "neon-override",
      title: "Override",
      settings: {},
      scripts: [],
      tests: [],
      assets: [
        {
          id: "neon-pad-asset",
          name: "Neon Pad",
          type: "cali",
          source: "neon-pad.cali.json",
          tags: [],
          usage: [],
          thumbnail: null,
          metadata: { cali: glowSpec() },
        },
      ],
      entities: [
        {
          id: "pad",
          name: "Pad",
          kind: "box",
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          material: {
            color: "#ff00ff",
            emissive: "#ff8800",
            emissiveIntensity: 1.5,
            metalness: 0,
            roughness: 0.4,
          },
          light: {},
          scriptIds: [],
          assetId: "neon-pad-asset",
        },
      ],
    };
    let mesh: THREE.Mesh | null = null;
    buildScene(project).traverse((node) => {
      if (!mesh && node instanceof THREE.Mesh) mesh = node;
    });
    const material = (mesh as unknown as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
    expect(material.color.getHexString()).toBe("ff00ff");
    expect(material.emissive.getHexString()).toBe("ff8800");
  });

  it("leaves the cali material untouched when the entity has no overrides", () => {
    const project: Project = {
      schemaVersion: 1,
      slug: "no-override",
      title: "No Override",
      settings: {},
      scripts: [],
      tests: [],
      assets: [
        {
          id: "neon-pad-asset",
          name: "Neon Pad",
          type: "cali",
          source: "neon-pad.cali.json",
          tags: [],
          usage: [],
          thumbnail: null,
          metadata: { cali: glowSpec() },
        },
      ],
      entities: [
        {
          id: "pad",
          name: "Pad",
          kind: "box",
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          material: { color: "#ffffff" },
          light: {},
          scriptIds: [],
          assetId: "neon-pad-asset",
        },
      ],
    };
    let mesh: THREE.Mesh | null = null;
    buildScene(project).traverse((node) => {
      if (!mesh && node instanceof THREE.Mesh) mesh = node;
    });
    const material = (mesh as unknown as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
    expect(material.emissive.getHexString()).toBe("000000");
    expect(material.emissiveIntensity).toBe(1);
    expect(material.color.getHexString()).toBe("ffffff");
  });

  it("does not mutate the source .cali spec on disk", () => {
    const spec = glowSpec();
    const original = JSON.stringify(spec);
    const project: Project = {
      schemaVersion: 1,
      slug: "no-mutate",
      title: "No Mutate",
      settings: {},
      scripts: [],
      tests: [],
      assets: [
        {
          id: "neon-pad-asset",
          name: "Neon Pad",
          type: "cali",
          source: "neon-pad.cali.json",
          tags: [],
          usage: [],
          thumbnail: null,
          metadata: { cali: spec },
        },
      ],
      entities: [
        {
          id: "pad",
          name: "Pad",
          kind: "box",
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          material: { emissive: "#ff00ff", emissiveIntensity: 3 },
          light: {},
          scriptIds: [],
          assetId: "neon-pad-asset",
        },
      ],
    };
    buildScene(project);
    expect(JSON.stringify(spec)).toBe(original);
  });
});
