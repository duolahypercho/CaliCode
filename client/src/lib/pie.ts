import * as THREE from "three";
import { buildScene } from "./procedural";
import type { CapturedFrame, Project } from "./types";

export type PieState = "idle" | "running" | "paused";

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
  private elapsedMs = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;
  private captureEvery = 3;
  private fixedHz = 60;
  private compiled = new Map<string, (entity: THREE.Object3D, state: Record<string, unknown>, delta: number) => unknown>();
  private waiters: Array<{ target: number; resolve: () => void }> = [];

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
    const settings = (project.settings.pie ?? {}) as { captureEvery?: number; fixedStepHz?: number };
    this.captureEvery = settings.captureEvery ?? 3;
    this.fixedHz = settings.fixedStepHz ?? 60;
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
    const settings = (project.settings.pie ?? {}) as { captureEvery?: number; fixedStepHz?: number };
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
    this.elapsedMs = 0;
    this.waiters = [];
    this.rebuild();
    this.renderer.render(this.scene, this.camera);
  }

  stepOnce(): void {
    const delta = 1000 / this.fixedHz;
    this.step(delta);
    this.frameIndex += 1;
    this.elapsedMs += delta;
    this.resolveWaiters();
    this.callbacks.onFrame(this.frameIndex, this.elapsedMs);
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
    await new Promise<void>((resolve) => {
      this.waiters.push({ target, resolve });
    });
  }

  capture(): string {
    this.renderer.render(this.scene, this.camera);
    const dataUrl = this.renderer.domElement.toDataURL("image/png");
    this.callbacks.onCapture({ frame: this.frameIndex, timeMs: this.elapsedMs, dataUrl });
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
    this.elapsedMs += dt;
    let guard = 0;
    while (this.elapsedMs >= stepMs && guard < 8) {
      this.step(stepMs);
      this.elapsedMs -= stepMs;
      this.frameIndex += 1;
      guard += 1;
    }
    this.resolveWaiters();
    this.callbacks.onFrame(this.frameIndex, this.elapsedMs);
    if (shouldCaptureFrame(this.frameIndex, this.captureEvery)) {
      this.capture();
    }
    this.renderer.render(this.scene, this.camera);
    this.rafId = requestAnimationFrame(this.tick);
  };

  private step(delta: number): void {
    const state: Record<string, unknown> = { time: this.elapsedMs / 1000, entities: this.scene.children };
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

  private compile(id: string, code: string): (entity: THREE.Object3D, state: Record<string, unknown>, delta: number) => unknown {
    let fn = this.compiled.get(id);
    if (!fn) {
      // eslint-disable-next-line no-new-func
      fn = new Function(
        "entity",
        "state",
        "delta",
        `${code}\nreturn typeof update === "function" ? update(entity, state, delta) : state;`,
      ) as (entity: THREE.Object3D, state: Record<string, unknown>, delta: number) => unknown;
      this.compiled.set(id, fn);
    }
    return fn;
  }

  private resolveWaiters(): void {
    const ready = this.waiters.filter((waiter) => waiter.target <= this.frameIndex);
    this.waiters = this.waiters.filter((waiter) => waiter.target > this.frameIndex);
    for (const waiter of ready) waiter.resolve();
  }

  private rebuild(): void {
    while (this.scene.children.length > 0) {
      const child = this.scene.children[0];
      this.scene.remove(child);
      if (child instanceof THREE.Object3D) {
        child.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.geometry.dispose();
            const material = Array.isArray(node.material) ? node.material[0] : node.material;
            material?.dispose();
          }
        });
      }
    }
    const group = buildScene(this.project);
    while (group.children.length > 0) {
      this.scene.add(group.children[0]);
    }
  }

  dispose(): void {
    this.stop();
    this.compiled.clear();
  }
}
