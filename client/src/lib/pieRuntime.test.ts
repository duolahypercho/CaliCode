import * as THREE from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PieRuntime, PROJECT_GROUP } from "./pie";
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
  const runtime = new PieRuntime(project, fakeRenderer(), scene, camera, {
    onFrame: () => undefined,
    onCapture: () => undefined,
    onLog: (message) => logs.push(message),
    onStateChange: () => undefined,
  });
  return { runtime, scene, logs };
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

    expect(runtime.getObject("Probe")?.position.x).toBe(101);
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
