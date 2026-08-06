import * as THREE from "three";
import { buildScene } from "./procedural";
import { createScriptSandbox, toSandboxEntity, type ScriptSandbox } from "./scriptSandbox";
import type { CapturedFrame, Project } from "./types";

export type PieState = "idle" | "running" | "paused";

/** Name of the group the runtime owns. Everything else in the scene belongs
 *  to the editor (lights, grid, gizmos) and must survive a rebuild. */
export const PROJECT_GROUP = "__project__";

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
  private sandbox: ScriptSandbox = createScriptSandbox();
  /** Set while a sandbox round trip is in flight, so a slow frame drops
   *  rather than queueing an unbounded backlog of step requests. */
  private stepping = false;
  /** Steps are async now, so an in-flight one can outlive teardown. Every
   *  post-await use of the renderer checks this first. */
  private disposed = false;
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

  async stepOnce(): Promise<void> {
    if (this.disposed) return;
    const delta = 1000 / this.fixedHz;
    await this.step(delta);
    if (this.disposed) return;
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
        await this.stepOnce();
      }
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ target, resolve, reject });
    });
  }

  capture(): string {
    if (this.disposed) return "";
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

    // Scripts now run in a worker, so a step is asynchronous. Render and
    // reschedule regardless; only the simulation waits on the sandbox.
    if (!this.stepping && this.accumulatorMs >= stepMs) {
      this.stepping = true;
      const budget = Math.min(Math.floor(this.accumulatorMs / stepMs), 8);
      void (async () => {
        try {
          for (let i = 0; i < budget && this.running && !this.disposed; i += 1) {
            await this.step(stepMs);
            if (this.disposed) return;
            this.accumulatorMs -= stepMs;
            this.simTimeMs += stepMs;
            this.frameIndex += 1;
          }
        } finally {
          this.stepping = false;
        }
        // The renderer may have been torn down while the sandbox round trip
        // was in flight; capture() would then draw into a disposed context.
        if (this.disposed) return;
        this.resolveWaiters();
        this.callbacks.onFrame(this.frameIndex, this.simTimeMs);
        if (shouldCaptureFrame(this.frameIndex, this.captureEvery)) {
          this.capture();
        }
      })();
    }

    this.renderer.render(this.scene, this.camera);
    this.rafId = requestAnimationFrame(this.tick);
  };

  /**
   * Advances the simulation by one fixed step.
   *
   * Scripts execute in the sandbox, never here: they receive plain vectors
   * and return a transform patch, which is applied to the live three.js
   * objects on this side of the boundary.
   */
  private async step(delta: number): Promise<void> {
    const scripted = this.project.entities
      .filter((entity) => entity.scriptIds.length > 0)
      .map((entity) => {
        const object = this.scene.getObjectByName(entity.name);
        return object ? toSandboxEntity(entity.id, entity.name, entity.scriptIds, object) : null;
      })
      .filter((entity): entity is NonNullable<typeof entity> => entity !== null);

    if (scripted.length === 0) return;

    const outcome = await this.sandbox.step({
      delta: delta / 1000,
      // The monotonic sim clock. This used to read the fixed-step
      // accumulator, which never exceeds one step — so `state.time` sat at
      // ~0.0167s forever and every time-driven script silently did nothing.
      time: this.simTimeMs / 1000,
      entities: scripted,
      scripts: this.project.scripts.map((script) => ({
        id: script.id,
        name: script.name,
        code: script.code,
      })),
    });

    for (const patch of outcome.patches) {
      const entity = this.project.entities.find((item) => item.id === patch.id);
      const object = entity ? this.scene.getObjectByName(entity.name) : null;
      if (!object) continue;
      object.position.set(patch.position.x, patch.position.y, patch.position.z);
      object.rotation.set(patch.rotation.x, patch.rotation.y, patch.rotation.z);
      object.scale.set(patch.scale.x, patch.scale.y, patch.scale.z);
    }
    for (const line of outcome.logs) this.callbacks.onLog(line);
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
    this.disposed = true;
    this.pause();
    this.rejectWaiters("PIE runtime disposed");
    this.sandbox.dispose();
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
