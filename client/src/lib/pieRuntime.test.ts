import * as THREE from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PieRuntime, PROJECT_GROUP, type CameraPoseSetting } from "./pie";
import { starterProject } from "./store";
import type { Project } from "./types";

/**
 * Regression coverage for the runtime itself. Every case here reproduces a
 * defect that shipped green: the previous suite only tested the
 * `shouldCaptureFrame` modulo helper, so none of these paths were exercised.
 */

/** Minimal stand-in for WebGLRenderer — jsdom has no WebGL context. */
function fakeRenderer() {
  const canvas = document.createElement("canvas");
  canvas.toDataURL = () => "data:image/png;base64,stub";
  return {
    render: vi.fn(),
    domElement: canvas,
    dispose: vi.fn(),
  } as unknown as THREE.WebGLRenderer;
}

function makeRuntime(project: Project) {
  const scene = new THREE.Scene();
  const light = new THREE.HemisphereLight(0xffffff, 0x444444, 0.9);
  light.name = "EditorHemi";
  scene.add(light);
  const grid = new THREE.GridHelper(16, 16);
  grid.name = "EditorGrid";
  scene.add(grid);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  const logs: string[] = [];
  // Returned so tests can count draws: with no WebGL the postprocess factory
  // throws and renderScene() falls through to renderer.render.
  const renderer = fakeRenderer();
  const runtime = new PieRuntime(project, renderer, scene, camera, {
    onFrame: () => undefined,
    onCapture: () => undefined,
    onLog: (message) => logs.push(message),
    onStateChange: () => undefined,
  });
  return { runtime, renderer, scene, camera, logs };
}

/** A project whose single entity is driven by one editable script. */
function scriptedProject(code: string): Project {
  return {
    ...starterProject(),
    entities: [
      {
        id: "e1",
        name: "Probe",
        kind: "box",
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        material: { color: "#888888" },
        light: {},
        scriptIds: ["s1"],
        assetId: null,
      },
    ],
    scripts: [{ id: "s1", name: "probe", code }],
    tests: [],
  };
}

function animatedProject(source: string): Project {
  return {
    ...starterProject(),
    slug: "pie-animation-test",
    entities: [
      {
        id: "animated-entity",
        name: "Animated",
        kind: "object",
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        material: {},
        light: {},
        scriptIds: [],
        assetId: "animated-asset",
      },
    ],
    assets: [
      {
        id: "animated-asset",
        name: "Animated asset",
        type: "gltf",
        source,
        tags: [],
        usage: [],
        thumbnail: null,
      },
    ],
    scripts: [],
    tests: [],
  };
}

describe("PieRuntime script compilation", () => {
  let runtime: PieRuntime;

  beforeEach(() => {
    ({ runtime } = makeRuntime(scriptedProject("function update(entity){ entity.position.x += 1; }")));
  });

  it("runs the script against the scene", async () => {
    await runtime.stepOnce();
    expect(runtime.getObject("Probe")?.position.x).toBe(1);
  });

  it("recompiles after the script source changes", async () => {
    // The compile cache keyed on script id only and setProject never cleared
    // it, so an edited script kept running its previous build until reload —
    // the core write-script/see-it-run loop was broken.
    await runtime.stepOnce();
    expect(runtime.getObject("Probe")?.position.x).toBe(1);

    runtime.setProject(scriptedProject("function update(entity){ entity.position.x += 100; }"));
    await runtime.stepOnce();

    expect(runtime.getObject("Probe")?.position.x).toBe(100);
  });

  it("reports script errors instead of throwing", async () => {
    const { runtime: broken, logs } = makeRuntime(scriptedProject("function update(){ throw new Error('boom'); }"));
    await expect(broken.stepOnce()).resolves.toBeUndefined();
    expect(logs.join("\n")).toContain("boom");
  });
});

describe("PieRuntime simulation clock", () => {
  it("advances state.time across frames", async () => {
    // state.time read the fixed-step accumulator, which never exceeds one
    // step, so it sat at ~0.0167s forever and `Math.sin(state.time)` scripts
    // never moved.
    const { runtime } = makeRuntime(scriptedProject("function update(entity, state){ entity.position.y = state.time; }"));

    await runtime.stepOnce();
    const first = runtime.getObject("Probe")!.position.y;
    for (let i = 0; i < 30; i += 1) await runtime.stepOnce();
    const later = runtime.getObject("Probe")!.position.y;

    expect(first).toBeCloseTo(0, 5);
    expect(later).toBeGreaterThan(0.4);
  });

  it("reports monotonic capture timestamps", async () => {
    const stamps: number[] = [];
    const scene = new THREE.Scene();
    const runtime = new PieRuntime(
      scriptedProject("function update(){}"),
      fakeRenderer(),
      scene,
      new THREE.PerspectiveCamera(),
      {
        onFrame: () => undefined,
        onCapture: (frame) => stamps.push(frame.timeMs),
        onLog: () => undefined,
        onStateChange: () => undefined,
      },
    );
    runtime.setCaptureEvery(1);
    for (let i = 0; i < 4; i += 1) await runtime.stepOnce();

    expect(stamps.length).toBeGreaterThanOrEqual(3);
    // Previously every stamp was a sub-millisecond accumulator remainder.
    expect(stamps[1]).toBeGreaterThan(stamps[0]);
    expect(stamps.at(-1)).toBeGreaterThan(30);
  });
});

describe("PieRuntime project synchronization and evidence framing", () => {
  it("rebuilds synchronously when the browser-tool live project changes", () => {
    const initial = scriptedProject("function update(){}");
    const { runtime } = makeRuntime(initial);
    const next: Project = {
      ...initial,
      entities: [
        ...initial.entities,
        {
          ...initial.entities[0],
          id: "far",
          name: "Far probe",
          transform: { ...initial.entities[0].transform, position: [20, 1, -12] },
        },
      ],
    };

    runtime.setProject(next);

    expect(runtime.getObject("Far probe")).toBeTruthy();
  });

  it("keeps the previous scene intact when a replacement cannot be built", async () => {
    const initial = scriptedProject("function update(entity){ entity.position.x += 1; }");
    const { runtime } = makeRuntime(initial);
    const malformed = {
      ...initial,
      entities: [{ ...initial.entities[0], assetId: "broken-asset" }],
      assets: [
        {
          id: "broken-asset",
          name: "Broken",
          type: "procedural",
          source: null,
          tags: [],
          usage: [],
          thumbnail: null,
        },
      ],
    } as unknown as Project;

    expect(() => runtime.setProject(malformed)).toThrow();
    expect(runtime.getObject("Probe")).toBeTruthy();
    await runtime.stepOnce();
    expect(runtime.getObject("Probe")?.position.x).toBe(1);

    const corrected = {
      ...initial,
      entities: [{ ...initial.entities[0], name: "Recovered" }],
    };
    expect(() => runtime.setProject(corrected)).not.toThrow();
    expect(runtime.getObject("Recovered")).toBeTruthy();
  });

  it("fits the verification camera to a large project instead of staring at a wall", async () => {
    const initial = scriptedProject("function update(){}");
    const large: Project = {
      ...initial,
      entities: [
        { ...initial.entities[0], transform: { ...initial.entities[0].transform, position: [-12, 0, -8] } },
        {
          ...initial.entities[0],
          id: "far",
          name: "Far probe",
          transform: { ...initial.entities[0].transform, position: [12, 4, 8] },
        },
      ],
    };
    const { runtime, camera } = makeRuntime(large);

    const result = await runtime.frameProject();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.framedEntityIds).toEqual(["e1", "far"]);
      expect(result.camera.sourceEntityIds).toEqual(["e1", "far"]);
      expect(result.camera.viewDirection).toHaveLength(3);
    }

    const bounds = new THREE.Box3().setFromObject(runtime.getObject(PROJECT_GROUP)!);
    expect(bounds.containsPoint(new THREE.Vector3(-12, 0, -8))).toBe(true);
    expect(camera.position.distanceTo(bounds.getCenter(new THREE.Vector3()))).toBeGreaterThan(10);
    expect(camera.far).toBeGreaterThan(camera.near);
  });

  it("rejects non-finite project bounds and restores the last valid camera pose", async () => {
    const initial = scriptedProject("function update(){}");
    const { runtime, camera } = makeRuntime(initial);
    await runtime.frameProject();
    const validPosition = camera.position.clone();
    const validQuaternion = camera.quaternion.clone();
    const probe = runtime.getObject("Probe")!;
    probe.position.x = Number.NaN;
    camera.position.set(999, 999, 999);

    const failed = await runtime.frameProject();
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.reason).toMatch(/non-finite/i);
      expect(failed.restored).toBe(true);
    }
    expect(camera.position.equals(validPosition)).toBe(true);
    expect(camera.quaternion.equals(validQuaternion)).toBe(true);

    probe.position.set(2, 0, 0);
    const recovered = await runtime.frameProject();
    expect(recovered.ok).toBe(true);
    expect(camera.position.toArray().every(Number.isFinite)).toBe(true);
  });

  it("awaits glTF readiness before measuring project bounds", async () => {
    // A loader that does not resolve until the test lets it. Before the load
    // the entity is still a placeholder Group, so the runtime's bounds would
    // be empty if frameProject skipped the wait.
    const loaded = new THREE.Group();
    loaded.add(new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4)));
    let resolveLoad: (value: unknown) => void = () => undefined;
    const loadAsync = vi.spyOn(GLTFLoader.prototype, "loadAsync").mockImplementation(
      () =>
        new Promise<never>((resolve) => {
          resolveLoad = () => resolve({ scene: loaded, animations: [] } as never);
        }),
    );
    try {
      const { runtime, camera } = makeRuntime(animatedProject("animated/await.gltf"));
      const initialPosition = camera.position.clone();

      const framed = runtime.frameProject();
      // Two microtask yields are enough for frameProject's `await
      // waitForAssets()` to be in flight on the loader promise.
      await Promise.resolve();
      await Promise.resolve();
      expect(camera.position.equals(initialPosition)).toBe(true);

      resolveLoad({ scene: loaded, animations: [] } as never);
      await framed;
      expect(camera.position.equals(initialPosition)).toBe(false);
    } finally {
      loadAsync.mockRestore();
    }
  });

  it("frames using projected Box3 extents, not just the bounding sphere", async () => {
    // A wide, flat box exercises the gap between the sphere-fit and the
    // actual silhouette: the sphere encloses the diagonal and over-fits, the
    // box-fit lands the projected NDC at the padded target.
    const initial = scriptedProject("function update(){}");
    const wide: Project = {
      ...initial,
      entities: [
        {
          ...initial.entities[0],
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [10, 0.1, 0.1] },
        },
      ],
    };
    const { runtime, camera } = makeRuntime(wide);

    await runtime.frameProject();

    // After framing, every corner's projected NDC should be inside the
    // padded target (`1 / 1.15` ≈ 0.87). The sphere-only fit would
    // overshoot this by at least the diagonal-vs-width ratio.
    const group = runtime.getObject(PROJECT_GROUP)!;
    const bounds = new THREE.Box3().setFromObject(group);
    const projected = new THREE.Vector3();
    let maxAbsX = 0;
    let maxAbsY = 0;
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          projected.set(x, y, z).project(camera);
          if (Math.abs(projected.x) > maxAbsX) maxAbsX = Math.abs(projected.x);
          if (Math.abs(projected.y) > maxAbsY) maxAbsY = Math.abs(projected.y);
        }
      }
    }
    expect(maxAbsX).toBeLessThanOrEqual(1 / 1.15 + 0.01);
    expect(maxAbsY).toBeLessThanOrEqual(1 / 1.15 + 0.01);
  });

  it("invokes the onFrameCamera callback with the new look-at center, radius, and distance", async () => {
    const events: Array<{ center: THREE.Vector3; radius: number; distance: number }> = [];
    const project = scriptedProject("function update(){}");
    const scene = new THREE.Scene();
    const runtime = new PieRuntime(
      project,
      fakeRenderer(),
      scene,
      new THREE.PerspectiveCamera(50, 1, 0.1, 100),
      {
        onFrame: () => undefined,
        onCapture: () => undefined,
        onLog: () => undefined,
        onStateChange: () => undefined,
        onFrameCamera: (center, radius, distance) =>
          events.push({ center: center.clone(), radius, distance }),
      },
    );

    await runtime.frameProject();

    expect(events).toHaveLength(1);
    expect(events[0].radius).toBeGreaterThan(0);
    expect(events[0].distance).toBeGreaterThan(0);
    expect(events[0].center.x).toBeCloseTo(0, 1);
    expect(events[0].center.y).toBeCloseTo(0, 1);
    expect(events[0].center.z).toBeCloseTo(0, 1);
  });

  it("frames with a low elevation angle so the camera is not looking down", async () => {
    // Old direction (1, 1.15, 1) put the camera at ~39° elevation; the new
    // (1, 0.7, 1) is ~26°. The assertion guards against a regression that
    // would push the framing back to "too high".
    const { runtime, camera } = makeRuntime(scriptedProject("function update(){}"));
    await runtime.frameProject();
    const offset = camera.position.clone().sub(new THREE.Vector3(0, 0, 0));
    const horizontalMagnitude = Math.sqrt(offset.x * offset.x + offset.z * offset.z);
    expect(horizontalMagnitude).toBeGreaterThan(0.01);
    expect(offset.y / horizontalMagnitude).toBeLessThan(0.75);
  });

  it("only redraws when something invalidated the frame", async () => {
    // The editor viewport used to redraw every animation frame. Once every
    // draw became an ACES + bloom composite that cost ~10ms on a software
    // rasteriser, an idle editor was spending the whole main thread
    // recomposing an unchanged picture — and a scripted `step(30)` ran
    // 128 of those redundant composites, which is what pushed the starter
    // suite past DEFAULT_TEST_TIMEOUT_MS on CI.
    const { runtime, renderer } = makeRuntime(scriptedProject("function update(){}"));
    const draws = () => (renderer.render as ReturnType<typeof vi.fn>).mock.calls.length;

    // Construction rebuilt the scene, so the first poll owes a draw.
    expect(runtime.renderIfNeeded()).toBe(true);
    const afterFirst = draws();
    // Nothing changed since: every later poll must be free.
    expect(runtime.renderIfNeeded()).toBe(false);
    expect(runtime.renderIfNeeded()).toBe(false);
    expect(draws()).toBe(afterFirst);

    runtime.invalidate();
    expect(runtime.renderIfNeeded()).toBe(true);
    expect(draws()).toBe(afterFirst + 1);
    expect(runtime.renderIfNeeded()).toBe(false);
  });

  it("presents a stepped batch itself rather than leaving the host to poll per frame", async () => {
    // captureEvery is 3, so a 30-frame batch is observed at its 10 capture
    // frames and nowhere else. Those draw themselves; the host must not be
    // owed a further draw afterwards, or the batch costs 40 composites
    // instead of 10.
    const { runtime, renderer } = makeRuntime(scriptedProject("function update(){}"));
    runtime.renderIfNeeded();
    const before = (renderer.render as ReturnType<typeof vi.fn>).mock.calls.length;

    await runtime.waitFrames(30);

    const drawn = (renderer.render as ReturnType<typeof vi.fn>).mock.calls.length - before;
    expect(drawn).toBe(10);
    expect(runtime.renderIfNeeded()).toBe(false);
  });

  it("invalidates when a rebuild replaces the scene", () => {
    const { runtime } = makeRuntime(scriptedProject("function update(){}"));
    runtime.renderIfNeeded();
    expect(runtime.renderIfNeeded()).toBe(false);

    runtime.setProject(scriptedProject("function update(){ return {}; }"));
    expect(runtime.renderIfNeeded()).toBe(true);
  });

  it("invalidates when an asynchronously loaded asset attaches itself", async () => {
    // buildScene returns a glTF placeholder synchronously and fills it in
    // when the loader resolves. A viewport that only draws on demand would
    // otherwise keep showing the empty placeholder.
    const loadAsync = vi.spyOn(GLTFLoader.prototype, "loadAsync").mockResolvedValue({
      scene: new THREE.Group(),
      animations: [],
    } as never);
    try {
      const { runtime } = makeRuntime(animatedProject("animated/invalidate.gltf"));
      runtime.renderIfNeeded();
      expect(runtime.renderIfNeeded()).toBe(false);

      await runtime.waitForAssets();
      expect(runtime.renderIfNeeded()).toBe(true);
    } finally {
      loadAsync.mockRestore();
    }
  });

  it("exposes the postprocess pipeline through getPostprocess() and falls back when the factory failed", () => {
    // The stub renderer has no WebGL, so the postprocess factory throws and
    // the runtime falls back to direct rendering. getPostprocess() reports
    // null and renderScene() still completes without erroring.
    const { runtime } = makeRuntime(scriptedProject("function update(){}"));
    expect(runtime.getPostprocess()).toBeNull();
    expect(() => runtime.renderScene()).not.toThrow();
  });
});

describe("PieRuntime glTF animation playback", () => {
  it("advances a loaded clip on every fixed step", async () => {
    const source = new THREE.Group();
    const clip = new THREE.AnimationClip("slide", 1, [
      new THREE.NumberKeyframeTrack(".position[x]", [0, 1], [0, 1]),
    ]);
    const loadAsync = vi.spyOn(GLTFLoader.prototype, "loadAsync").mockResolvedValue({
      scene: source,
      animations: [clip],
    } as never);
    try {
      const { runtime } = makeRuntime(animatedProject("animated/runtime.gltf"));
      await runtime.waitFrames(2);

      const entity = runtime.getObject("Animated");
      expect(entity?.children).toHaveLength(1);
      expect(entity?.children[0]).not.toBe(source);
      expect(entity?.children[0].position.x).toBeGreaterThan(0);
    } finally {
      loadAsync.mockRestore();
    }
  });

  it("does not duplicate animated instances after a rebuild", async () => {
    const source = new THREE.Group();
    const clip = new THREE.AnimationClip("slide", 1, [
      new THREE.NumberKeyframeTrack(".position[x]", [0, 1], [0, 1]),
    ]);
    const loadAsync = vi.spyOn(GLTFLoader.prototype, "loadAsync").mockResolvedValue({
      scene: source,
      animations: [clip],
    } as never);
    try {
      const { runtime } = makeRuntime(animatedProject("animated/rebuild.gltf"));
      await runtime.waitFrames(1);
      runtime.stop();
      await runtime.waitFrames(1);

      const entity = runtime.getObject("Animated");
      expect(entity?.children).toHaveLength(1);
    } finally {
      loadAsync.mockRestore();
    }
  });

  it("keeps cached glTF GPU resources alive when an instance is rebuilt", async () => {
    const sourceGeometry = new THREE.BoxGeometry();
    const sourceTexture = new THREE.Texture();
    const sourceMaterial = new THREE.MeshStandardMaterial({ map: sourceTexture });
    const source = new THREE.Group();
    source.add(new THREE.Mesh(sourceGeometry, sourceMaterial));
    const sourceGeometryDispose = vi.spyOn(sourceGeometry, "dispose");
    const sourceMaterialDispose = vi.spyOn(sourceMaterial, "dispose");
    const sourceTextureDispose = vi.spyOn(sourceTexture, "dispose");
    const loadAsync = vi.spyOn(GLTFLoader.prototype, "loadAsync").mockResolvedValue({
      scene: source,
      animations: [],
    } as never);
    let runtime: PieRuntime | null = null;
    try {
      ({ runtime } = makeRuntime(animatedProject("animated/resource-lifetime.gltf")));
      await runtime.waitForAssets();
      const firstMesh = runtime.getObject("Animated")?.getObjectByProperty("isMesh", true) as THREE.Mesh;
      expect(firstMesh).toBeTruthy();
      expect(firstMesh.geometry).not.toBe(sourceGeometry);
      expect(firstMesh.material).not.toBe(sourceMaterial);
      const firstMaterial = firstMesh.material as THREE.MeshStandardMaterial;
      expect(firstMaterial.map).not.toBe(sourceTexture);
      const firstGeometryDispose = vi.spyOn(firstMesh.geometry, "dispose");
      const firstMaterialDispose = vi.spyOn(firstMaterial, "dispose");
      const firstTextureDispose = vi.spyOn(firstMaterial.map!, "dispose");

      runtime.stop();
      expect(sourceGeometryDispose).not.toHaveBeenCalled();
      expect(sourceMaterialDispose).not.toHaveBeenCalled();
      expect(sourceTextureDispose).not.toHaveBeenCalled();
      expect(firstGeometryDispose).toHaveBeenCalledOnce();
      expect(firstMaterialDispose).toHaveBeenCalledOnce();
      expect(firstTextureDispose).toHaveBeenCalledOnce();

      await runtime.waitForAssets();
      const secondMesh = runtime.getObject("Animated")?.getObjectByProperty("isMesh", true) as THREE.Mesh;
      expect(secondMesh).toBeTruthy();
      expect(secondMesh.geometry).not.toBe(sourceGeometry);
      expect((secondMesh.material as THREE.MeshStandardMaterial).map).not.toBe(sourceTexture);
      expect(loadAsync).toHaveBeenCalledOnce();
    } finally {
      runtime?.dispose();
      loadAsync.mockRestore();
    }
  });

  it("fails soft when a loader never settles", async () => {
    const loadAsync = vi.spyOn(GLTFLoader.prototype, "loadAsync").mockImplementation(
      () => new Promise(() => undefined) as never,
    );
    try {
      const { runtime } = makeRuntime(animatedProject("animated/stalled.gltf"));
      await expect(runtime.waitFrames(1)).resolves.toBeUndefined();
      expect(runtime.frames).toBe(1);
    } finally {
      loadAsync.mockRestore();
    }
  });
});

describe("PieRuntime scene ownership", () => {
  it("keeps editor lights and grid across a stop", async () => {
    // stop() used to clear every scene child, taking the editor's lights and
    // grid with it, and then re-add project entities flat.
    const { runtime, scene } = makeRuntime(scriptedProject("function update(){}"));
    runtime.stop();

    expect(scene.getObjectByName("EditorHemi")).toBeTruthy();
    expect(scene.getObjectByName("EditorGrid")).toBeTruthy();
    expect(scene.getObjectByName(PROJECT_GROUP)).toBeTruthy();
  });

  it("does not duplicate entities across repeated rebuilds", async () => {
    // Losing the __project__ group made the next rebuild add a second copy of
    // every entity beside the first.
    const { runtime, scene } = makeRuntime(scriptedProject("function update(){}"));
    runtime.stop();
    runtime.setProject(scriptedProject("function update(){}"));
    runtime.stop();

    const named: string[] = [];
    scene.traverse((node) => {
      if (node.name === "Probe") named.push(node.name);
    });
    expect(named).toHaveLength(1);
  });
});

describe("PieRuntime waiters", () => {
  it("settles waitFrames when stopped mid-flight", async () => {
    // stop() discarded waiters without settling them, so "Run tests" followed
    // by Stop left the promise permanently pending and froze the panel.
    const { runtime } = makeRuntime(scriptedProject("function update(){}"));
    runtime.start();

    const pending = runtime.waitFrames(1000);
    runtime.stop();

    await expect(pending).rejects.toThrow(/stopped/i);
  });

  it("settles waitFrames on dispose", async () => {
    const { runtime } = makeRuntime(scriptedProject("function update(){}"));
    runtime.start();

    const pending = runtime.waitFrames(1000);
    runtime.dispose();

    await expect(pending).rejects.toThrow(/disposed/i);
  });

  it("resolves immediately when stepping while paused", async () => {
    const { runtime } = makeRuntime(scriptedProject("function update(){}"));
    await expect(runtime.waitFrames(3)).resolves.toBeUndefined();
    expect(runtime.frames).toBe(3);
  });
});

describe("PieRuntime script boundary", () => {
  it("keeps the live scene finite when a script writes an array position", async () => {
    // An agent script that did `entity.position = [1, 2, 3]` used to reach
    // the live THREE.Vector3 as a patch whose `.x` was `undefined`, so
    // `set(undefined, undefined, undefined)` set every component to NaN
    // and every capture came back black. The boundary normalizer should
    // coerce the array into a finite object vector instead.
    const { runtime } = makeRuntime(
      scriptedProject("function update(entity){ entity.position = [3, 4, 5]; }"),
    );

    await runtime.stepOnce();

    const probe = runtime.getObject("Probe");
    expect(probe).toBeTruthy();
    expect(probe?.position.x).toBe(3);
    expect(probe?.position.y).toBe(4);
    expect(probe?.position.z).toBe(5);
    expect(Number.isFinite(probe?.position.x)).toBe(true);
    expect(Number.isFinite(probe?.position.y)).toBe(true);
    expect(Number.isFinite(probe?.position.z)).toBe(true);
  });

  it("reverts a NaN-poisoned vector to the pre-step position instead of NaN-poisoning the scene", async () => {
    const project = scriptedProject("function update(entity){ entity.position = { x: 1, y: NaN, z: 0 }; }");
    project.entities[0].transform.position = [2, 0, 0];
    const { runtime } = makeRuntime(project);

    await runtime.stepOnce();

    const probe = runtime.getObject("Probe");
    expect(probe).toBeTruthy();
    expect(probe?.position.x).toBe(2);
    expect(probe?.position.y).toBe(0);
    expect(probe?.position.z).toBe(0);
    expect(Number.isFinite(probe?.position.x)).toBe(true);
    expect(Number.isFinite(probe?.position.y)).toBe(true);
    expect(Number.isFinite(probe?.position.z)).toBe(true);
  });

  it("keeps every transform finite across repeated steps with hostile writes", async () => {
    // Iteration matters: a single bad write only sets one bad frame, but
    // a runaway loop that NaN-poisons every step would never recover
    // without the pre-step fallback. The fallback should hold for the
    // entire run.
    const { runtime } = makeRuntime(
      scriptedProject("function update(entity){ entity.position = [NaN, NaN, NaN]; }"),
    );

    for (let i = 0; i < 6; i += 1) await runtime.stepOnce();

    const probe = runtime.getObject("Probe");
    expect(probe).toBeTruthy();
    expect(Number.isFinite(probe?.position.x)).toBe(true);
    expect(Number.isFinite(probe?.position.y)).toBe(true);
    expect(Number.isFinite(probe?.position.z)).toBe(true);
  });
});

/**
 * State contract coverage for the runtime. The pie.ts step() loop is what
 * decides what enters the sandbox; these tests pin the contract:
 *
 * 1. EVERY project entity (scripted or not) crosses the boundary, so a
 *    scripted hero can observe a static coin via state.find.
 * 2. setProject and stop both clear persistent state before the next step
 *    runs, even when the step is scheduled in the same tick.
 * 3. A "collect the coin" pattern built on state.find + state.world
 *    actually mutates both ends -- the hero's score and the coin's
 *    collected flag.
 */
describe("PieRuntime state contract", () => {
  function twoEntityProject(heroCode: string, coinCode: string, extraEntities: { name: string; kind?: string }[] = []): Project {
    const base = {
      ...starterProject(),
      entities: [
        {
          id: "hero",
          name: "Hero",
          kind: "box",
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          material: { color: "#888888" },
          light: {},
          scriptIds: ["sHero"],
          assetId: null,
        },
        {
          id: "coin",
          name: "Coin",
          kind: "sphere",
          transform: { position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          material: { color: "#ffcc00" },
          light: {},
          scriptIds: ["sCoin"],
          assetId: null,
        },
        ...extraEntities.map((entity, idx) => ({
          id: `extra-${idx}`,
          name: entity.name,
          kind: entity.kind ?? "sphere",
          transform: { position: [5 + idx, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          material: { color: "#888888" },
          light: {},
          scriptIds: [],
          assetId: null,
        })),
      ],
      scripts: [
        { id: "sHero", name: "hero", code: heroCode },
        { id: "sCoin", name: "coin", code: coinCode },
      ],
      tests: [],
    };
    return base as unknown as Project;
  }

  it("sends every project entity into the sandbox, not only scripted ones", async () => {
    // The static Target has no script of its own; the Hero script reads
    // its position via state.find. If the runtime filtered out non-scripted
    // entities (the previous behaviour), state.find("Target") would return
    // null and the hero would never reach it.
    const project = twoEntityProject(
      `function update(entity, state){
        var t = state.find("Target");
        if (t === null) throw new Error("Target not in scene");
        entity.position.x = t.position.x;
      }`,
      `function update(entity, state){
        // Coin is scripted too; sanity check it appears.
        if (state.find("Coin") === null) throw new Error("Coin not in scene");
      }`,
      [{ name: "Target" }],
    );
    const { runtime, logs } = makeRuntime(project);

    await runtime.stepOnce();

    expect(logs.join("\n")).not.toMatch(/Error/);
    expect(runtime.getObject("Hero")?.position.x).toBe(5);
    expect(runtime.getObject("Target")?.position.x).toBe(5);
  });

  it("drives a coin-collection interaction through state.find + state.world", async () => {
    // Hero reads the Coin position; when in range, hero increments a
    // shared score and marks the coin as collected; the coin's own script
    // then sets its position way out so the hero can no longer collide.
    // This exercises (a) read-by-name across scripted entities and
    // (b) shared world state for cross-script coordination.
    const project = twoEntityProject(
      `function update(entity, state){
        var coin = state.find("Coin");
        if (coin === null) return;
        var dx = coin.position.x - entity.position.x;
        if (Math.abs(dx) < 2 && !state.world.coinTaken) {
          state.world.coinTaken = true;
          state.world.score = (state.world.score || 0) + 1;
        }
        entity.position.x = entity.position.x + 0.5;
      }`,
      `function update(entity, state){
        if (state.world.coinTaken) entity.position.x = 100;
      }`,
    );
    const { runtime, logs } = makeRuntime(project);

    // Step enough times for the hero (advancing 0.5/frame) to reach x=3
    // and collide with the coin at x=3.
    for (let i = 0; i < 10; i += 1) await runtime.stepOnce();

    expect(logs.join("\n")).not.toMatch(/Error/);
    const hero = runtime.getObject("Hero");
    const coin = runtime.getObject("Coin");
    expect(hero).toBeTruthy();
    expect(coin).toBeTruthy();
    // After the collision the hero continues forward (x>=6) and the coin
    // has been pushed to x=100. Score in state.world is not exposed via
    // any getter; the proof is the coin moving out of the hero's path.
    expect(coin?.position.x).toBe(100);
    expect(hero?.position.x).toBeGreaterThanOrEqual(3);
  });

  it("clears sandbox state when setProject swaps the project", async () => {
    // Project A writes a sentinel value into state.world. After swapping to
    // project B whose script asserts the sentinel is gone, the runtime
    // must have reset the sandbox across the swap. Without that, B would
    // see A's leftover state and fail the assertion.
    const projectA = scriptedProject(`function update(entity, state){
      state.world.leftover = 1;
    }`);
    const projectB = scriptedProject(`function update(entity, state){
      entity.position.x = (state.world.leftover === undefined) ? 1 : 0;
    }`);

    const { runtime } = makeRuntime(projectA);
    await runtime.stepOnce();
    runtime.setProject(projectB);
    await runtime.stepOnce();

    expect(runtime.getObject("Probe")?.position.x).toBe(1);
  });

  it("clears sandbox state on stop()", async () => {
    // stop() restarts the simulation with the same project; any persistent
    // state the previous run left behind would skew the next one.
    const { runtime } = makeRuntime(
      scriptedProject(`function update(entity, state){
        if (state.self.frame === undefined) state.self.frame = 0;
        state.self.frame += 1;
        entity.position.x = state.self.frame;
      }`),
    );
    for (let i = 0; i < 5; i += 1) await runtime.stepOnce();
    expect(runtime.getObject("Probe")?.position.x).toBe(5);
    runtime.stop();
    await runtime.stepOnce();
    // After stop, the counter should start fresh; a leak would give 6.
    expect(runtime.getObject("Probe")?.position.x).toBe(1);
  });

  it("awaits an in-flight reset so a step after setProject sees fresh state", async () => {
    // Regression for the fire-and-forget reset: if step() ran before the
    // worker had acked the reset, it would run against the previous
    // project's state. Even in the InlineSandbox (where reset() resolves
    // synchronously), the contract is that a step scheduled in the same
    // tick observes cleared state.
    const first = scriptedProject(`function update(entity, state){
      state.world.score = 1;
    }`);
    const { runtime } = makeRuntime(first);
    await runtime.stepOnce();

    const second = scriptedProject(`function update(entity, state){
      state.world.score = 2;
    }`);
    runtime.setProject(second);
    // No await: the call is synchronous. The step that follows must still
    // see the reset committed.
    const third = scriptedProject(`function update(entity, state){
      entity.position.x = state.world.score === undefined ? 1 : 0;
    }`);
    runtime.setProject(third);

    await runtime.stepOnce();
    expect(runtime.getObject("Probe")?.position.x).toBe(1);
  });
});

/**
 * Coverage for the scoped persistent evidence camera runtime. Each case
 * maps to a single bullet in the runtime spec; if a new bullet is added
 * it should grow its own test here, not be folded into an existing one.
 */
describe("PieRuntime scoped evidence camera", () => {
  it("fits on a small selection while keeping a giant backdrop un-clipped", async () => {
    // A 200m backdrop far behind a small hero at the origin. Auto-fit
    // on the whole scene puts the camera so far back the hero becomes a
    // pixel; fit-on-hero should pull the camera in AND keep the
    // backdrop visible by using the whole scene for near/far.
    const initial = scriptedProject("function update(){}");
    const withBackdrop: Project = {
      ...initial,
      entities: [
        initial.entities[0],
        {
          ...initial.entities[0],
          id: "backdrop",
          name: "Backdrop",
          transform: { position: [0, 0, -200], rotation: [0, 0, 0], scale: [400, 200, 0.1] },
        },
      ],
    };
    const { runtime, camera } = makeRuntime(withBackdrop);

    const result = await runtime.frameProject({ entityIds: ["e1"] });
    expect(result.ok).toBe(true);

    // The camera lands close enough to see the hero. Without
    // scene-wide clipping the backdrop would punch through the near
    // plane (it's only 1.2m from the camera) and disappear.
    const heroPos = new THREE.Vector3(0, 0, 0);
    expect(camera.position.distanceTo(heroPos)).toBeLessThan(50);
    expect(camera.far).toBeGreaterThan(200);
  });

  it("excludes a giant backdrop from the fit but keeps it inside the clip range", async () => {
    // Symmetric to the above: same scene, but use excludeEntityIds so
    // the backdrop is NOT considered when sizing the fit. The near/far
    // are still derived from the whole scene.
    const initial = scriptedProject("function update(){}");
    const withBackdrop: Project = {
      ...initial,
      entities: [
        initial.entities[0],
        {
          ...initial.entities[0],
          id: "backdrop",
          name: "Backdrop",
          transform: { position: [0, 0, -200], rotation: [0, 0, 0], scale: [400, 200, 0.1] },
        },
      ],
    };
    const { runtime, camera } = makeRuntime(withBackdrop);

    const result = await runtime.frameProject({ excludeEntityIds: ["backdrop"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.framedEntityIds).toEqual(["e1"]);
    }
    expect(camera.far).toBeGreaterThan(200);
  });

  it("composes against an arbitrary viewDirection and clamps padding to [1.05, 3]", async () => {
    // A side view (looking along -X) verifies direction is honoured,
    // not just the default diagonal. Padding 10 should clamp to 3,
    // not reject.
    const { runtime, camera } = makeRuntime(scriptedProject("function update(){}"));
    const result = await runtime.frameProject({
      viewDirection: [-1, 0, 0],
      padding: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.camera.viewDirection[0]).toBeCloseTo(-1, 5);
      expect(result.camera.viewDirection[1]).toBeCloseTo(0, 5);
      expect(result.camera.viewDirection[2]).toBeCloseTo(0, 5);
      expect(result.camera.padding).toBe(3);
    }
    // Camera sits along -X relative to the scene center.
    expect(camera.position.x).toBeLessThan(0);
  });

  it("rejects unknown entity ids and restores the previous valid pose", async () => {
    const { runtime, camera } = makeRuntime(scriptedProject("function update(){}"));
    const good = await runtime.frameProject();
    expect(good.ok).toBe(true);
    const savedPosition = camera.position.clone();
    const savedQuaternion = camera.quaternion.clone();

    const failed = await runtime.frameProject({ entityIds: ["e1", "missing"] });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.reason).toMatch(/unknown entity id/i);
      expect(failed.restored).toBe(true);
    }
    expect(camera.position.equals(savedPosition)).toBe(true);
    expect(camera.quaternion.equals(savedQuaternion)).toBe(true);
  });

  it("rejects an empty selection (excluded every entity) and restores the previous pose", async () => {
    const initial = scriptedProject("function update(){}");
    const twoEntity: Project = {
      ...initial,
      entities: [
        initial.entities[0],
        { ...initial.entities[0], id: "second", name: "Second" },
      ],
    };
    const { runtime, camera } = makeRuntime(twoEntity);
    const good = await runtime.frameProject();
    expect(good.ok).toBe(true);
    const saved = camera.position.clone();

    const failed = await runtime.frameProject({ excludeEntityIds: ["e1", "second"] });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.reason).toMatch(/removed every entity/i);
      expect(failed.restored).toBe(true);
    }
    expect(camera.position.equals(saved)).toBe(true);
  });

  it("rejects a non-finite viewDirection and restores the previous pose", async () => {
    const { runtime, camera } = makeRuntime(scriptedProject("function update(){}"));
    await runtime.frameProject();
    const saved = camera.position.clone();

    const failed = await runtime.frameProject({ viewDirection: [0, 0, 0] });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.reason).toMatch(/non-zero/i);
      expect(failed.restored).toBe(true);
    }
    expect(camera.position.equals(saved)).toBe(true);
  });

  it("composes correctly when viewDirection is parallel to camera.up", async () => {
    // camera.up defaults to (0,1,0). Looking straight down would
    // collapse the cross-product basis to zero; the runtime must fall
    // back to a world-axis right basis so the framing still resolves.
    const { runtime, camera } = makeRuntime(scriptedProject("function update(){}"));
    const result = await runtime.frameProject({ viewDirection: [0, 1, 0] });
    expect(result.ok).toBe(true);
    expect(camera.position.toArray().every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(camera.near)).toBe(true);
    expect(Number.isFinite(camera.far)).toBe(true);
  });

  it("threades framedEntityIds through the returned pose for explicit calls", async () => {
    // The pose must carry the selection that fed the fit so a
    // subsequent setProject + frameProject() can restore exactly the
    // same view, not just a pose with an empty sourceEntityIds.
    const initial = scriptedProject("function update(){}");
    const two: Project = {
      ...initial,
      entities: [
        initial.entities[0],
 { ...initial.entities[0], id: "second", name: "Second", transform: { position: [10, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      ],
    };
    const { runtime } = makeRuntime(two);
    const result = await runtime.frameProject({ entityIds: ["e1"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.camera.sourceEntityIds).toEqual(["e1"]);
      expect(result.framedEntityIds).toEqual(["e1"]);
    }
  });

  it("applies a saved pose verbatim on no-arg frameProject and fires onFrameCamera", async () => {
    // Persist a pose by mutating project.settings.pie.camera, then
    // build a fresh runtime and confirm the no-arg call restores it
    // unchanged and notifies the editor callback so OrbitControls can
    // sync its target.
    const initial = scriptedProject("function update(){}");
    const events: Array<{ center: THREE.Vector3; radius: number; distance: number }> = [];
    const scene = new THREE.Scene();
    const seed = new PieRuntime(
      initial,
      fakeRenderer(),
      scene,
      new THREE.PerspectiveCamera(50, 1, 0.1, 100),
      {
        onFrame: () => undefined,
        onCapture: () => undefined,
        onLog: () => undefined,
        onStateChange: () => undefined,
        onFrameCamera: (center, radius, distance) => events.push({ center: center.clone(), radius, distance }),
      },
    );
    const framed = await seed.frameProject({ viewDirection: [0.3, 0.6, 0.7], padding: 1.5 });
    expect(framed.ok).toBe(true);
    if (!framed.ok) return;
    const saved: Project = {
      ...initial,
      settings: { ...initial.settings, pie: { ...(initial.settings?.pie ?? {}), camera: framed.camera } },
    };
    seed.dispose();

    // The seed recorded its explicit-options frame; the next assertion
    // is about the SAVED-POSE REPLAY path, so the restored runtime
    // also has to push to `events` and we count only its contributions.
    const replayEvents: Array<{ center: THREE.Vector3; radius: number; distance: number }> = [];
    const restored = new PieRuntime(saved, fakeRenderer(), new THREE.Scene(), new THREE.PerspectiveCamera(50, 1, 0.1, 100), {
      onFrame: () => undefined,
      onCapture: () => undefined,
      onLog: () => undefined,
      onStateChange: () => undefined,
      onFrameCamera: (center, radius, distance) => replayEvents.push({ center: center.clone(), radius, distance }),
    });
    const result = await restored.frameProject();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.camera.position).toEqual(framed.camera.position);
      expect(result.camera.target).toEqual(framed.camera.target);
      expect(result.camera.viewDirection).toEqual(framed.camera.viewDirection);
      expect(result.camera.padding).toBe(framed.camera.padding);
      expect(result.camera.sourceEntityIds).toEqual(framed.camera.sourceEntityIds);
    }
    // Constructor's rebuild applied the saved pose and fired the
    // callback (synchronous from the rebuild's tail); the no-arg
    // frameProject below fires it again. Either contribution is
    // enough to prove the saved-pose replay path is observable.
    expect(replayEvents.length).toBeGreaterThan(0);
    if (replayEvents.length > 0) {
      const evt = replayEvents[replayEvents.length - 1];
      expect(evt.center.x).toBeCloseTo(framed.camera.target[0], 5);
      expect(evt.center.y).toBeCloseTo(framed.camera.target[1], 5);
      expect(evt.center.z).toBeCloseTo(framed.camera.target[2], 5);
      expect(evt.distance).toBeGreaterThan(0);
    }
  });

  it("reuses the saved pose across setProject and rebuild", async () => {
    const initial = scriptedProject("function update(){}");
    const { runtime } = makeRuntime(initial);
    const framed = await runtime.frameProject({ viewDirection: [0.2, 0.4, 0.8], padding: 1.6 });
    expect(framed.ok).toBe(true);
    if (!framed.ok) return;
    const saved: Project = {
      ...initial,
      settings: { ...initial.settings, pie: { ...(initial.settings?.pie ?? {}), camera: framed.camera } },
    };
    // setProject (triggers rebuild) + no-arg frameProject must restore
    // the saved pose deterministically, not auto-fit the new project.
    runtime.setProject(saved);
    const restored = await runtime.frameProject();
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.camera.position).toEqual(framed.camera.position);
      expect(restored.camera.target).toEqual(framed.camera.target);
      expect(restored.camera.viewDirection).toEqual(framed.camera.viewDirection);
    }
  });

  it("falls back to auto-fit when no saved pose is stored (legacy no-settings behaviour)", async () => {
    // A bare starter project with no settings.pie.camera at all. The
    // runtime must not crash; the no-arg call should succeed via the
    // auto-fit path and report the entities that were framed.
    const { runtime } = makeRuntime(scriptedProject("function update(){}"));
    const result = await runtime.frameProject();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.framedEntityIds).toEqual(["e1"]);
      expect(result.camera.sourceEntityIds).toEqual(["e1"]);
    }
  });

  it("ignores a saved pose whose sourceEntityIds no longer resolve in the project", async () => {
    // The validation step requires every saved id to map to a current
    // project entity. If the project has been edited and the saved
    // selection is stale, the runtime should fall through to auto-fit
    // instead of erroring or pretending the missing entities framed.
    const initial = scriptedProject("function update(){}");
    const stale: CameraPoseSetting = {
      position: [3, 4, 5],
      target: [0, 0, 0],
      fov: 50,
      near: 0.1,
      far: 100,
      viewDirection: [1, 0.7, 1],
      padding: 1.2,
      sourceEntityIds: ["ghost-entity-that-does-not-exist"],
    };
    const project: Project = {
      ...initial,
      settings: { ...initial.settings, pie: { ...(initial.settings?.pie ?? {}), camera: stale } },
    };
    const { runtime } = makeRuntime(project);
    const result = await runtime.frameProject();
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Stale pose rejected, so the live framing is auto-fit on the
      // current project's only entity.
      expect(result.framedEntityIds).toEqual(["e1"]);
    }
  });

  it("rejects both entityIds and excludeEntityIds as a programmer error", async () => {
    const { runtime, camera } = makeRuntime(scriptedProject("function update(){}"));
    await runtime.frameProject();
    const saved = camera.position.clone();
    const failed = await runtime.frameProject({ entityIds: ["e1"], excludeEntityIds: ["e2"] });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.reason).toMatch(/either entityIds or excludeEntityIds/i);
      expect(failed.restored).toBe(true);
    }
    expect(camera.position.equals(saved)).toBe(true);
  });

  it("disambiguates entities that share a name but have different ids", async () => {
    // Two entities named "Twin" with different ids and different
    // positions. entityId-based resolution must target the requested
    // one, not whichever happens to be first by name.
    const initial = scriptedProject("function update(){}");
    const twins: Project = {
      ...initial,
      entities: [
        { ...initial.entities[0], id: "twin-a", name: "Twin", transform: { position: [-5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { ...initial.entities[0], id: "twin-b", name: "Twin", transform: { position: [5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      ],
    };
    const { runtime, scene } = makeRuntime(twins);
    // Sanity: the project group contains two top-level children named
    // "Twin", so a name-only lookup would be ambiguous.
    const group = scene.getObjectByName(PROJECT_GROUP)!;
    let nameCount = 0;
    group.traverse((node) => {
      if (node.name === "Twin" && node.userData?.entityId) nameCount += 1;
    });
    expect(nameCount).toBe(2);

    const resultA = await runtime.frameProject({ entityIds: ["twin-a"] });
    expect(resultA.ok).toBe(true);
    if (resultA.ok) {
      expect(resultA.framedEntityIds).toEqual(["twin-a"]);
      const fitCenter = new THREE.Vector3()
        .add(new THREE.Vector3().fromArray(resultA.fitBounds.min))
        .add(new THREE.Vector3().fromArray(resultA.fitBounds.max))
        .multiplyScalar(0.5);
      expect(fitCenter.x).toBeCloseTo(-5, 1);
    }

    const resultB = await runtime.frameProject({ entityIds: ["twin-b"] });
    expect(resultB.ok).toBe(true);
    if (resultB.ok) {
      const fitCenter = new THREE.Vector3()
        .add(new THREE.Vector3().fromArray(resultB.fitBounds.min))
        .add(new THREE.Vector3().fromArray(resultB.fitBounds.max))
        .multiplyScalar(0.5);
      expect(fitCenter.x).toBeCloseTo(5, 1);
    }
  });

  it("computes near/far from the live camera position, not the clip bounds center", async () => {
    // A hero offset from world origin, with a backdrop 200m further
    // along -Z. The fit center is the hero (close to origin), but the
    // clip center sits roughly halfway between hero and backdrop. The
    // backdrop is 200m further along the view direction from the hero
    // but only ~100m further from the clip center; using the clip
    // center would set far ~100m short of the backdrop and clip it.
    const initial = scriptedProject("function update(){}");
    const withBackdrop: Project = {
      ...initial,
      entities: [
        { ...initial.entities[0], id: "hero", name: "Hero", transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { ...initial.entities[0], id: "backdrop", name: "Backdrop", transform: { position: [0, 0, -200], rotation: [0, 0, 0], scale: [400, 200, 0.1] } },
      ],
    };
    const { runtime, camera } = makeRuntime(withBackdrop);
    const result = await runtime.frameProject({ entityIds: ["hero"] });
    expect(result.ok).toBe(true);
    // The backdrop sits ~200m further along the view direction from
    // the camera. With the fix, far must reach that distance.
    expect(camera.far).toBeGreaterThan(200);
  });
});
