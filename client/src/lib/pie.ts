import * as THREE from "three";
import { buildScene } from "./procedural";
import type { CapturedFrame, Project } from "./types";

export type PieState = "idle" | "running" | "paused";

/** Name of the group the runtime owns. Everything else in the scene belongs
 *  to the editor (lights, grid, gizmos) and must survive a rebuild. */
export const PROJECT_GROUP = "__project__";

type ScriptFn = (entity: THREE.Object3D, state: Record<string, unknown>, delta: number) => unknown;

/** Cached compile plus the source it came from, so an edited script
 *  recompiles instead of silently running the previous version. */
interface CompiledScript {
  code: string;
  fn: ScriptFn;
}

export function shouldCaptureFrame(frameIndex: number, captureEvery: number): boolean {
  return frameIndex > 0 && frameIndex % Math.max(1, captureEvery) === 0;
}

export interface PieCallbacks {
  onFrame: (frame: number, timeMs: number) => void;
  onCapture: (frame: CapturedFrame) => void;
  onLog: (message: string) => void;
  onStateChange: (state: PieState) => void;
}

export class PieRuntime {
  private project: Project;
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private scene: THREE.Scene;
  private callbacks: PieCallbacks;
  private frameIndex = 0;
  /** Monotonic simulation clock. Scripts read this as `state.time`. */
  private simTimeMs = 0;
  /** Fixed-step leftover. Never exposed — it only ever holds < one step. */
  private accumulatorMs = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;
  private captureEvery = 3;
  private fixedHz = 60;
  private compiled = new Map<string, CompiledScript>();
  private waiters: Array<{ target: number; resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(
    project: Project,
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    callbacks: PieCallbacks,
  ) {
    this.project = project;
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.callbacks = callbacks;
    const settings = (project.settings?.pie ?? {}) as { captureEvery?: number; fixedStepHz?: number };
    this.captureEvery = settings.captureEvery ?? 3;
    this.fixedHz = settings.fixedStepHz ?? 60;
    // Own the project group from construction rather than depending on the
    // caller having populated the scene first.
    this.rebuild();
  }

  get state(): PieState {
    return this.running ? "running" : "paused";
  }

  get frames(): number {
    return this.frameIndex;
  }

  setCaptureEvery(value: number): void {
    this.captureEvery = Math.max(1, value);
  }

  setProject(project: Project): void {
    this.project = project;
    const settings = (project.settings?.pie ?? {}) as { captureEvery?: number; fixedStepHz?: number };
    this.captureEvery = settings.captureEvery ?? this.captureEvery;
    this.fixedHz = settings.fixedStepHz ?? this.fixedHz;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.callbacks.onStateChange("running");
    this.rafId = requestAnimationFrame(this.tick);
  }

  pause(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.callbacks.onStateChange("paused");
  }

  stop(): void {
    this.pause();
    this.frameIndex = 0;
    this.simTimeMs = 0;
    this.accumulatorMs = 0;
    // Discarding waiters without settling them left every in-flight
    // waitFrames() permanently pending, so "Run tests" followed by Stop froze
    // the results panel with no way back short of a reload.
    this.rejectWaiters("PIE stopped before the requested frames elapsed");
    this.rebuild();
    this.renderer.render(this.scene, this.camera);
  }

  stepOnce(): void {
    const delta = 1000 / this.fixedHz;
    this.step(delta);
    this.frameIndex += 1;
    this.simTimeMs += delta;
    this.resolveWaiters();
    this.callbacks.onFrame(this.frameIndex, this.simTimeMs);
    if (shouldCaptureFrame(this.frameIndex, this.captureEvery)) {
      this.capture();
    }
    this.renderer.render(this.scene, this.camera);
  }

  async waitFrames(count: number): Promise<void> {
    if (count <= 0) return;
    const target = this.frameIndex + count;
    if (!this.running) {
      for (let i = 0; i < count; i += 1) {
        this.stepOnce();
      }
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ target, resolve, reject });
    });
  }

  capture(): string {
    this.renderer.render(this.scene, this.camera);
    const dataUrl = this.renderer.domElement.toDataURL("image/png");
    this.callbacks.onCapture({ frame: this.frameIndex, timeMs: this.simTimeMs, dataUrl });
    return dataUrl;
  }

  getObject(name: string): THREE.Object3D | null {
    return this.scene.getObjectByName(name) ?? null;
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    const dt = Math.min(now - this.lastTime, 100);
    this.lastTime = now;
    const stepMs = 1000 / this.fixedHz;
    this.accumulatorMs += dt;
    let guard = 0;
    while (this.accumulatorMs >= stepMs && guard < 8) {
      this.step(stepMs);
      this.accumulatorMs -= stepMs;
      this.simTimeMs += stepMs;
      this.frameIndex += 1;
      guard += 1;
    }
    this.resolveWaiters();
    this.callbacks.onFrame(this.frameIndex, this.simTimeMs);
    if (shouldCaptureFrame(this.frameIndex, this.captureEvery)) {
      this.capture();
    }
    this.renderer.render(this.scene, this.camera);
    this.rafId = requestAnimationFrame(this.tick);
  };

  private step(delta: number): void {
    // Reads the monotonic sim clock. This used to read the fixed-step
    // accumulator, which never exceeds one step — so `state.time` sat at
    // ~0.0167s forever and every time-driven script silently did nothing.
    const state: Record<string, unknown> = { time: this.simTimeMs / 1000, entities: this.scene.children };
    for (const entity of this.project.entities) {
      const object = this.scene.getObjectByName(entity.name);
      if (!object) continue;
      for (const scriptId of entity.scriptIds) {
        const script = this.project.scripts.find((s) => s.id === scriptId);
        if (!script) continue;
        try {
          const fn = this.compile(script.id, script.code);
          fn(object, state, delta / 1000);
        } catch (error) {
          this.callbacks.onLog(`script ${script.name}: ${String(error)}`);
        }
      }
    }
  }

  private compile(id: string, code: string): ScriptFn {
    // The cache used to key on id alone and was never invalidated by
    // setProject, so editing a script and pressing Play re-ran the previous
    // build until a full page reload. Compare the source too.
    const cached = this.compiled.get(id);
    if (cached && cached.code === code) return cached.fn;

    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "entity",
      "state",
      "delta",
      `${code}\nreturn typeof update === "function" ? update(entity, state, delta) : state;`,
    ) as ScriptFn;
    this.compiled.set(id, { code, fn });
    return fn;
  }

  private resolveWaiters(): void {
    const ready = this.waiters.filter((waiter) => waiter.target <= this.frameIndex);
    this.waiters = this.waiters.filter((waiter) => waiter.target > this.frameIndex);
    for (const waiter of ready) waiter.resolve();
  }

  private rejectWaiters(message: string): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) waiter.reject(new Error(message));
  }

  /**
   * Replaces the runtime-owned group in place.
   *
   * This used to clear every child of the scene, which took the editor's
   * hemisphere light, key light and grid with it — they never came back, and
   * because the `__project__` group went too, the next edit added a second
   * copy of every entity alongside the first.
   */
  private rebuild(): void {
    const existing = this.scene.getObjectByName(PROJECT_GROUP);
    if (existing) {
      this.scene.remove(existing);
      disposeTree(existing);
    }
    const group = buildScene(this.project);
    group.name = PROJECT_GROUP;
    this.scene.add(group);
  }

  dispose(): void {
    // Deliberately not stop(): that rebuilds a whole fresh scene immediately
    // before the renderer is torn down, allocating GPU resources that are
    // then never freed.
    this.pause();
    this.rejectWaiters("PIE runtime disposed");
    this.compiled.clear();
    const group = this.scene.getObjectByName(PROJECT_GROUP);
    if (group) {
      this.scene.remove(group);
      disposeTree(group);
    }
  }
}

/** Frees geometry, every material slot, and each material's textures. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry?.dispose();
    // Multi-material meshes only had slot 0 disposed, and textures were never
    // touched at all — procedural noise maps are ~256KB each.
    const materials: THREE.Material[] = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}
