import * as THREE from "three";
import {
  buildScene,
  collectAnimationMixers,
  getGltfAssetInstance,
  onAssetAttached,
  waitForAssetReadiness,
} from "./procedural";
import {
  restoreCameraPose,
  snapshotCameraPose,
  validateProjectBounds,
  type CameraPoseSnapshot,
} from "./pieEvidence";
import {
  createScriptSandbox,
  toSandboxEntity,
  type ScriptSandbox,
  type WorldStateSnapshot,
} from "./scriptSandbox";
import { createPostprocessPipeline, type PostprocessPipeline } from "./postprocess";
import type { CapturedFrame, Project, Vec3 } from "./types";

export type PieState = "idle" | "running" | "paused";

/** Name of the group the runtime owns. Everything else in the scene belongs
 *  to the editor (lights, grid, gizmos) and must survive a rebuild. */
export const PROJECT_GROUP = "__project__";
export const PIE_ASSET_READY_TIMEOUT_MS = 250;

/** Padding lower bound for `frameProject`. Closer than this and the
 *  projected bounds start to kiss the viewport edge. */
export const CAMERA_PADDING_MIN = 1.05;
/** Padding upper bound. Beyond this and small scenes float in a sea of
 *  empty pixels, defeating the visual evidence the agent needs. */
export const CAMERA_PADDING_MAX = 3;
const DEFAULT_CAMERA_PADDING = 1.2;
const DEFAULT_CAMERA_DIRECTION: Vec3 = [1, 0.7, 1];

/**
 * Per-call overrides for `frameProject`. `entityIds` and `excludeEntityIds`
 * are mutually exclusive: passing both is a programmer error the runtime
 * surfaces as an actionable failure. With no options, the runtime applies
 * a valid saved pose (`project.settings.pie.camera`) unchanged, falling
 * back to an auto-fit on the whole scene when none is stored.
 */
export type CameraFrameOptions = {
  entityIds?: string[];
  excludeEntityIds?: string[];
  viewDirection?: Vec3;
  padding?: number;
};

/**
 * The exact camera state worth persisting. Stores position, target, fov,
 * near/far, and the framing inputs that produced the position so the pose
 * can be re-applied verbatim after a rebuild and the original selection
 * can be reported back to the caller. Stored under
 * `project.settings.pie.camera`.
 */
export type CameraPoseSetting = {
  position: Vec3;
  target: Vec3;
  fov: number;
  near: number;
  far: number;
  viewDirection: Vec3;
  padding: number;
  sourceEntityIds: string[];
};

/** Box3-shaped fit bounds for the result; Vector3 instances are renderer-
 *  internal, callers should not reach for them. */
export type CameraFrameFitBounds = {
  min: Vec3;
  max: Vec3;
};

/**
 * Result of `frameProject`. On success: the exact pose, the fit bounds
 * the camera was composed against, and the entities that fed them. On
 * failure: a human-readable reason and whether the previous pose was
 * restored on the live camera. Legacy callers that `await` and ignore the
 * value keep compiling; the boolean was never load-bearing.
 */
export type CameraFrameResult =
  | { ok: true; camera: CameraPoseSetting; fitBounds: CameraFrameFitBounds; framedEntityIds: string[] }
  | { ok: false; reason: string; restored: boolean };

export function shouldCaptureFrame(frameIndex: number, captureEvery: number): boolean {
  return frameIndex > 0 && frameIndex % Math.max(1, captureEvery) === 0;
}

export interface PieCallbacks {
  onFrame: (frame: number, timeMs: number) => void;
  onCapture: (frame: CapturedFrame) => void;
  onLog: (message: string) => void;
  onStateChange: (state: PieState) => void;
  /**
   * Fired after `frameProject` has moved the camera. Receives the look-at
   * center, bounding-sphere radius, and resulting camera distance so the
   * host (typically the editor's `OrbitControls`) can keep its target in
   * sync with the runtime's framing. Optional: editor surfaces without a
   * 3D camera control may omit it.
   */
  onFrameCamera?: (center: THREE.Vector3, radius: number, distance: number) => void;
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
  /** Latest reset in the worker FIFO; every step awaits the whole chain. */
  private pendingReset: Promise<void> | null = null;
  private lastValidCameraPose: CameraPoseSnapshot | null = null;
  /** Set while a sandbox round trip is in flight, so a slow frame drops
   *  rather than queueing an unbounded backlog of step requests. */
  private stepping = false;
  /** Steps are async now, so an in-flight one can outlive teardown. Every
   *  post-await use of the renderer checks this first. */
  private disposed = false;
  private waiters: Array<{ target: number; resolve: () => void; reject: (error: Error) => void }> = [];
  private readyGroup: THREE.Object3D | null = null;
  private assetReadyPromise: Promise<void> | null = null;
  /**
   * ACES Filmic tone mapping + Unreal bloom pipeline. Built from the host
   * renderer so every captured frame and every live frame goes through the
   * same curve the judge will see. Nullable for stub renderers used in
   * jsdom tests; `renderScene()` falls back to direct rendering when null.
   */
  private postprocess: PostprocessPipeline | null = null;
  /**
   * Set when something changed the picture — a rebuild, a camera framing, a
   * late-arriving asset, a host resize — and cleared by the next draw.
   *
   * Every draw is a full ACES + bloom composite: a RenderPass, the bloom
   * pass's five-level mip blur chain, and an OutputPass, which measured ~10ms
   * per frame on a software rasteriser (~25ms at 1280x720) against ~2-6ms for
   * a bare `renderer.render`. Repeating that for a scene nobody changed is
   * pure cost, so the editor viewport polls this flag instead of redrawing
   * unconditionally on every animation frame.
   */
  private needsRender = true;
  /** Detaches the asset-attach subscription at dispose. */
  private unsubscribeAssetAttach: () => void = () => undefined;

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
    // Compose tone-mapping + bloom into the capture/live path. Wrapped so a
    // context-less test renderer can still construct the runtime; that path
    // exercises the direct-render fallback in renderScene().
    try {
      this.postprocess = createPostprocessPipeline(this.renderer, this.scene, this.camera);
    } catch (error) {
      if (typeof navigator === "undefined" || !/jsdom/i.test(navigator.userAgent)) {
        console.warn("PIE: postprocess pipeline unavailable, falling back to direct rendering", error);
      }
      this.postprocess = null;
    }
    // glTF scenes and textures attach to an already-built group when their
    // loads resolve. Without this the viewport would keep showing the
    // placeholder until something else happened to dirty the frame.
    this.unsubscribeAssetAttach = onAssetAttached(() => this.invalidate());
  }

  /**
   * Marks the current picture stale so the next host animation tick draws it.
   *
   * Call this from anything that changes what the scene looks like without
   * drawing it itself. The simulation deliberately does NOT call it: a batch
   * of stepped frames is only ever observed at its capture frames and at its
   * end, and `advanceFrame`/`waitFrames` already draw exactly those.
   */
  invalidate(): void {
    this.needsRender = true;
  }

  /** Draws only when something invalidated the frame. Reports whether it did. */
  renderIfNeeded(): boolean {
    if (!this.needsRender) return false;
    this.renderScene();
    return true;
  }

  get state(): PieState {
    return this.running ? "running" : "paused";
  }

  get frames(): number {
    return this.frameIndex;
  }

  /** Fixed-step simulation time represented by the current rendered frame. */
  get timeMs(): number {
    return this.simTimeMs;
  }

  /** Draw calls issued for the most recent frame, straight from the renderer. */
  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  setCaptureEvery(value: number): void {
    this.captureEvery = Math.max(1, value);
  }

  setProject(project: Project): void {
    if (this.project === project) return;
    const settings = (project.settings?.pie ?? {}) as { captureEvery?: number; fixedStepHz?: number };
    // Build and swap before publishing the new runtime project. If malformed
    // data throws, the previous scene/project remain intact and a corrected
    // retry can still land.
    this.rebuild(project);
    this.project = project;
    this.captureEvery = settings.captureEvery ?? this.captureEvery;
    this.fixedHz = settings.fixedStepHz ?? this.fixedHz;
    // Scripts hold `state.self` and `state.world` across frames; without a
    // reset the new project inherits the old project's score/coin map. The
    // reset is tracked so the next step awaits it; a step scheduled in the
    // same tick must not run against the previous project's persistent
    // state.
    this.queueSandboxReset();
    // No explicit render here. The Viewport's animate loop owns every render
    // outside explicit captures, and a forced render at this point would
    // commit an empty frame before any glTF asset has finished loading —
    // producing a one-frame flicker the user can see on every edit.
  }

  /**
  * Frame the entire live project for agent evidence captures. Awaits glTF
  * readiness so the box used for the fit reflects what is actually visible,
  * then fits the box's eight corners exactly in camera space.
   *
   * Options (all optional):
   * - `entityIds` or `excludeEntityIds` (mutually exclusive): scope the
   *   fit to specific entities. Whole-scene geometry still drives
   *   near/far/fog so a giant backdrop in front of or behind the
   *   selection does not get clipped or pop through the fog.
   * - `viewDirection`: finite, non-zero. Defaults to a low-elevation
   *   diagonal so the agent is not looking down at a flat scene.
   * - `padding`: clamped to [1.05, 3]. Defaults to 1.2.
   *
   * With no options the runtime tries to apply a valid saved pose
   * (`project.settings.pie.camera`) unchanged; if the saved pose is
   * missing, malformed, or references entity ids that no longer exist,
   * the runtime falls back to an auto-fit on the whole scene.
   *
   * Validation failures (unknown ids, empty/no-geometry selection, bad
   * view direction) return `{ok:false, reason, restored:true}` so the
   * caller's last good view is preserved on the live camera.
  */
  async frameProject(options?: CameraFrameOptions): Promise<CameraFrameResult> {
    if (this.disposed) return { ok: false, reason: "PIE runtime disposed", restored: false };
    await this.waitForAssets();
    if (this.disposed) return { ok: false, reason: "PIE runtime disposed", restored: false };
    const group = this.scene.getObjectByName(PROJECT_GROUP);
    if (!group) return { ok: false, reason: "PIE project group is missing from the scene", restored: false };

    if (options && options.entityIds && options.excludeEntityIds) {
      return this.failWithRestore(
        "frameProject: pass either entityIds or excludeEntityIds, not both",
      );
    }

    // No-arg + valid saved pose -> apply the saved pose verbatim. The
    // saved pose is treated as a black box: we trust the values that
    // validation already accepted, and we don't recompute fog because
    // fog is scene state, not camera state.
    if (!options) {
      const saved = readSavedCameraPose(this.project);
      if (saved) {
        const applied = this.applyPoseSetting(saved);
        this.lastValidCameraPose = snapshotCameraPose(this.camera);
        this.renderScene();
        return {
          ok: true,
          camera: saved,
          fitBounds: boundsToVec3(applied.fitBounds),
          framedEntityIds: applied.framedEntityIds,
        };
      }
    }

    const selection = this.resolveSelection(group, options);
    if (selection.error) {
      return this.failWithRestore(selection.error);
    }
    const { fitBounds, clipBounds, framedEntityIds } = selection;

    const directionValidation = validateViewDirection(options?.viewDirection);
    if (!directionValidation.ok) {
      return this.failWithRestore(directionValidation.reason);
    }
    const direction = directionValidation.value;
    const padding = clampPadding(options?.padding);

    const framed = this.composeAndApplyFraming({
      fitBounds,
      clipBounds,
      direction,
      padding,
      framedEntityIds,
    });
    if (!framed.ok) {
      return this.failWithRestore(framed.reason);
    }
    const pose = framed.pose;
    this.lastValidCameraPose = snapshotCameraPose(this.camera);
    this.renderScene();
    return {
      ok: true,
      camera: pose,
      fitBounds: boundsToVec3(framed.fitBounds),
      framedEntityIds,
    };
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
    // Stop restarts the simulation from frame zero with the same project;
    // any persistent script state from the previous run would otherwise
    // survive the reset and skew the next run's first frames.
    this.queueSandboxReset();
    this.rebuild();
    this.renderScene();
  }

  async stepOnce(): Promise<void> {
    if (this.disposed) return;
    // capture() draws the same frame it encodes, so re-drawing after it is
    // a second full pass through the bloom composer for a picture that is
    // already on screen.
    if (!(await this.advanceFrame())) this.renderScene();
  }

  /**
   * Simulate exactly one fixed step, capturing it when it is a capture
   * frame. Returns whether the frame reached the canvas — the caller owns
   * presentation, because a batch of steps is only ever observed at its
   * captures and at its end.
   */
  private async advanceFrame(): Promise<boolean> {
    if (this.disposed) return false;
    const delta = 1000 / this.fixedHz;
    await this.step(delta);
    if (this.disposed) return false;
    this.frameIndex += 1;
    this.simTimeMs += delta;
    this.resolveWaiters();
    this.callbacks.onFrame(this.frameIndex, this.simTimeMs);
    if (!shouldCaptureFrame(this.frameIndex, this.captureEvery)) return false;
    this.capture();
    return true;
  }

  async waitFrames(count: number): Promise<void> {
    if (count <= 0) return;
    const target = this.frameIndex + count;
    if (!this.running) {
      // Stepping by hand: every intermediate frame used to be drawn through
      // the full tone-map + bloom composer, then thrown away when the next
      // step overwrote it. Nothing observes those frames — the filmstrip
      // sees only capture frames (which draw themselves) and the viewport
      // sees only the last one — but the wasted passes are what pushed the
      // starter project's `step(30)` past the scripted-test timeout on a
      // software rasterizer.
      let presented = false;
      for (let i = 0; i < count; i += 1) {
        if (this.disposed) return;
        presented = await this.advanceFrame();
      }
      if (!presented && !this.disposed) this.renderScene();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ target, resolve, reject });
    });
  }

  /**
   * Waits for the current project group's asynchronous assets. A stalled
   * loader is deliberately failure-soft so scripts and verification can still
   * make progress against the rest of the scene.
   */
  async waitForAssets(timeoutMs = PIE_ASSET_READY_TIMEOUT_MS): Promise<void> {
    const group = this.scene.getObjectByName(PROJECT_GROUP);
    if (!group) return;
    if (group !== this.readyGroup || this.assetReadyPromise === null) {
      this.readyGroup = group;
      this.assetReadyPromise = waitForAssetReadiness(group, timeoutMs);
    }
    await this.assetReadyPromise;
  }

  async captureWhenReady(timeoutMs = PIE_ASSET_READY_TIMEOUT_MS): Promise<string> {
    await this.waitForAssets(timeoutMs);
    return this.capture();
  }

  capture(): string {
    if (this.disposed) return "";
    this.renderScene();
    const dataUrl = this.renderer.domElement.toDataURL("image/png");
    this.callbacks.onCapture({ frame: this.frameIndex, timeMs: this.simTimeMs, dataUrl });
    return dataUrl;
  }

  getObject(name: string): THREE.Object3D | null {
    return this.scene.getObjectByName(name) ?? null;
  }

  /** Read-only snapshot of the shared script state for the test harness. */
  getWorldState(): Promise<WorldStateSnapshot> {
    return this.sandbox.getWorldState();
  }

  /**
   * Single render dispatch used by every render call site (animate tick,
   * stepOnce, capture, frameProject, stop). Routes through the ACES + bloom
   * pipeline when one was built; falls back to a direct `renderer.render`
   * when the postprocess factory threw during construction (jsdom stub
   * renderer, headless contexts that lack the extensions composer needs).
   * The fallback is identical to the pre-pipeline behaviour so unit tests
   * that pass a stub renderer keep working unchanged.
   */
  renderScene(): void {
    if (this.disposed) return;
    this.needsRender = false;
    if (this.postprocess) {
      this.postprocess.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /**
   * Resize the underlying postprocess render targets. Hosts that resize the
   * renderer (Viewport's ResizeObserver) must call this in lockstep so the
   * composer's offscreen targets do not desync from the canvas.
   */
  setPostprocessSize(width: number, height: number): void {
    this.postprocess?.setSize(width, height);
    // Fresh render targets come up empty; the canvas has to be redrawn at
    // the new size or the viewport keeps the pre-resize picture.
    this.invalidate();
  }

  /** Exposed for inspection; useful for tests verifying bloom is wired. */
  getPostprocess(): PostprocessPipeline | null {
    return this.postprocess;
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

    this.renderScene();
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
    // `sandbox.reset()` is asynchronous in the worker-backed sandboxes: the
    // reset message must reach the worker and be acknowledged before the
    // next step posts, or a step posted in the same tick would run against
    // the previous project's `state.self` / `state.world`. Awaiting here
    // makes the lifecycle linear; tracking the promise means setProject/stop
    // can stay synchronous callers.
    const pendingReset = this.pendingReset;
    if (pendingReset) {
      try {
        await pendingReset;
      } finally {
        if (this.pendingReset === pendingReset) this.pendingReset = null;
      }
    }
    await this.waitForAssets();
    const group = this.scene.getObjectByName(PROJECT_GROUP);
    if (group) {
      for (const mixer of collectAnimationMixers(group)) {
        mixer.update(delta / 1000);
      }
    }

    // Every entity with a live three.js object goes into the step payload --
    // not just the scripted ones. `state.scene` and `state.find` are how a
    // hero reads a static coin's position; filtering by `scriptIds` here
    // would silently hide every non-scripted target from the very view
    // whose job it is to expose them. The worker still drives execution by
    // `entity.scriptIds`, so a coin without a script is observable but
    // never has its `update` called.
    const sandboxEntities = this.project.entities.flatMap((entity) => {
      const object = this.scene.getObjectByName(entity.name);
      if (!object) return [];
      return [
        toSandboxEntity(entity.id, entity.name, entity.kind, object.visible, entity.scriptIds, object),
      ];
    });

    if (sandboxEntities.length === 0) return;

    const outcome = await this.sandbox.step({
      delta: delta / 1000,
      // The monotonic sim clock. This used to read the fixed-step
      // accumulator, which never exceeds one step — so `state.time` sat at
      // ~0.0167s forever and every time-driven script silently did nothing.
      time: this.simTimeMs / 1000,
      entities: sandboxEntities,
      scripts: this.project.scripts.map((script) => ({
        id: script.id,
        name: script.name,
        code: script.code,
      })),
    });

    // The patch list still keys by entity id, but a non-scripted entity
    // never has its transform changed because the worker does not run its
    // `update`. Defensive: any unexpected patch for a name that has no
    // matching entity is ignored.
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

  private queueSandboxReset(): void {
    const previous = this.pendingReset ?? Promise.resolve();
    this.pendingReset = previous.catch(() => undefined).then(() => this.sandbox.reset());
  }

  /**
   * Replaces the runtime-owned group in place.
   *
   * This used to clear every child of the scene, which took the editor's
   * hemisphere light, key light and grid with it — they never came back, and
   * because the `__project__` group went too, the next edit added a second
   * copy of every entity alongside the first.
   */
  private rebuild(project = this.project): void {
    // Construct first: removing the live group before a failing build left a
    // blank viewport and made every later recovery depend on a full remount.
    const group = buildScene(project);
    group.name = PROJECT_GROUP;
    const existing = this.scene.getObjectByName(PROJECT_GROUP);
    if (existing) {
      this.scene.remove(existing);
    }
    this.scene.add(group);
    if (existing) disposeTree(existing);
    this.readyGroup = null;
    this.assetReadyPromise = null;
    // After the new scene is in place, reapply the persisted pose so
    // setProject/stop/initial-construction all leave the camera at the
    // agent's last valid view instead of wherever the editor happened to
    // initialise it. The saved pose is treated as authoritative: a missing
    // or invalid stored value falls through to whatever the live camera
    // was before the rebuild, which is the deterministic "no change"
    // outcome the spec asks for.
    const saved = readSavedCameraPose(project);
    if (saved) {
      this.applyPoseSetting(saved, project);
      this.lastValidCameraPose = snapshotCameraPose(this.camera);
    }
    // A rebuild replaces every object in the scene; nothing on screen is
    // valid any more.
    this.invalidate();
  }

  /**
   * Pulls a `CameraPoseSetting` out of storage and writes it back to the
   * live camera. The pose is treated as authoritative: fog and clipping
   * planes are NOT recomputed because (a) near/far travel with the pose
   * and (b) fog is scene state, not camera state. The previous valid
   * snapshot is refreshed so a later failed framing falls back to this
   * exact view rather than a derived one.
   *
   * `project` defaults to the live project but can be passed explicitly
   * from `rebuild` when the project reference on the runtime is still
   * the previous one. Without the override, lookups by entity id would
   * resolve against the wrong project's entity list.
   */
  private applyPoseSetting(pose: CameraPoseSetting, project: Project = this.project): {
    fitBounds: THREE.Box3;
    framedEntityIds: string[];
  } {
    this.camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    this.camera.fov = pose.fov;
    this.camera.near = pose.near;
    this.camera.far = pose.far;
    this.camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    const fitBounds = new THREE.Box3();
    const framedEntityIds: string[] = [];
    const entityById = new Map(project.entities.map((entity) => [entity.id, entity]));
    for (const id of pose.sourceEntityIds) {
      const entity = entityById.get(id);
      if (!entity) continue;
      const object = this.findEntityObject(entity);
      if (!object) continue;
      fitBounds.expandByObject(object);
      framedEntityIds.push(id);
    }
    // Fire the editor's camera-sync callback even on a saved-pose replay:
    // OrbitControls' target was tracking the old look-at, and without
    // this signal it would still be panning to catch up while the user
    // stares at a still frame that disagrees with their gizmo.
    const target = new THREE.Vector3(pose.target[0], pose.target[1], pose.target[2]);
    const size = fitBounds.getSize(new THREE.Vector3());
    const radius = fitBounds.isEmpty() ? 1 : Math.max(size.length() / 2, 1);
    const distance = this.camera.position.distanceTo(target);
    this.callbacks.onFrameCamera?.(target, radius, distance);
    return { fitBounds, framedEntityIds };
  }

  /**
   * Resolves a project entity to its scene object. Prefers the
   * `userData.entityId` tag set by `buildScene` so two entities that
   * happen to share a name still resolve to the right one. Falls back
   * to a name match inside the project group for objects added by
   * paths that never went through `buildScene` (e.g. tests or future
   * editor features that mutate the scene directly). The fallback
   * scopes to the project group so it never picks up editor lights or
   * gizmos that happen to share a name.
   */
  private findEntityObject(entity: { id: string; name: string }): THREE.Object3D | null {
    const group = this.scene.getObjectByName(PROJECT_GROUP);
    if (!group) return null;
    let byId: THREE.Object3D | null = null;
    group.traverse((node) => {
      if (byId) return;
      if (node.userData?.entityId === entity.id) byId = node;
    });
    if (byId) return byId;
    let byName: THREE.Object3D | null = null;
    group.traverse((node) => {
      if (byName) return;
      if (node.name === entity.name) byName = node;
    });
    return byName;
  }

  /**
   * Decides which entities feed the fit bounds. Whole-scene bounds are
   * always returned as `clipBounds` for near/far/fog so a giant backdrop
   * is never clipped (or popped by the fog plane) just because the
   * caller asked to fit on a smaller selection.
  */
  private resolveSelection(
    group: THREE.Object3D,
    options: CameraFrameOptions | undefined,
  ): {
    fitBounds: THREE.Box3;
    clipBounds: THREE.Box3;
    framedEntityIds: string[];
    error?: string;
  } {
    const clipBounds = new THREE.Box3().setFromObject(group);
    const entityById = new Map(this.project.entities.map((entity) => [entity.id, entity]));
    const names: string[] = [];
    const ids: string[] = [];

    if (options?.entityIds) {
      const unknown: string[] = [];
      for (const id of options.entityIds) {
        const entity = entityById.get(id);
        if (!entity) {
          unknown.push(id);
          continue;
        }
        names.push(entity.name);
        ids.push(id);
      }
      if (unknown.length > 0) {
        return {
          fitBounds: new THREE.Box3(),
          clipBounds,
          framedEntityIds: [],
          error: `frameProject: unknown entity id(s) [${unknown.join(", ")}]; restore the selection and retry`,
        };
      }
    } else if (options?.excludeEntityIds) {
      const excluded = new Set(options.excludeEntityIds);
      for (const entity of this.project.entities) {
        if (excluded.has(entity.id)) continue;
        names.push(entity.name);
        ids.push(entity.id);
      }
      if (ids.length === 0) {
        return {
          fitBounds: new THREE.Box3(),
          clipBounds,
          framedEntityIds: [],
          error: "frameProject: excludeEntityIds removed every entity; add at least one to the selection",
        };
      }
    } else {
      for (const entity of this.project.entities) {
        names.push(entity.name);
        ids.push(entity.id);
      }
      if (ids.length === 0) {
        return {
          fitBounds: new THREE.Box3(),
          clipBounds,
          framedEntityIds: [],
          error: "PIE project has no entities to frame",
        };
      }
    }

    const fitBounds = new THREE.Box3();
    let resolved = 0;
    for (let i = 0; i < names.length; i += 1) {
      const entity = entityById.get(ids[i]);
      if (!entity) continue;
      const object = this.findEntityObject(entity);
      if (!object) continue;
      fitBounds.expandByObject(object);
      resolved += 1;
    }
    if (resolved === 0 || fitBounds.isEmpty()) {
      return {
        fitBounds: new THREE.Box3(),
        clipBounds,
        framedEntityIds: [],
        error: "frameProject: selection has no visible geometry to frame",
      };
    }
    return { fitBounds, clipBounds, framedEntityIds: ids };
  }

  /**
   * Composition: fit the selected bounds into the viewport using
   * `direction`/`padding`; clipping: derive near/far/fog from the WHOLE
   * scene so a giant backdrop in front of the camera doesn't punch
   * through the near plane and a backdrop far behind doesn't clip at
   * the far plane. Returns the exact pose as a persistable
   * `CameraPoseSetting` plus the fit bounds used for composition.
   */
  private composeAndApplyFraming(input: {
    fitBounds: THREE.Box3;
    clipBounds: THREE.Box3;
    direction: THREE.Vector3;
    padding: number;
    framedEntityIds: string[];
  }): {
    ok: true;
    pose: CameraPoseSetting;
    fitBounds: THREE.Box3;
  } | { ok: false; reason: string } {
    const { fitBounds, clipBounds, direction, padding, framedEntityIds } = input;
    const clipValidation = validateProjectBounds(clipBounds);
    if (!clipValidation.ok) {
      return { ok: false, reason: clipValidation.reason };
    }
    const center = fitBounds.getCenter(new THREE.Vector3());
    const size = fitBounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const fallbackPose = this.lastValidCameraPose ?? snapshotCameraPose(this.camera);
    // If the view direction is parallel to camera.up, the cross product
    // collapses to a zero vector and `up = direction x right` is also
    // zero, which would flatten the projection math. Fall back to the
    // world X axis so the basis stays right-handed; the camera up
    // vector stays unchanged in the camera state, only the temporary
    // composition basis is rotated.
    let right = new THREE.Vector3().crossVectors(this.camera.up, direction);
    if (right.lengthSq() < 1e-6) {
      right.set(1, 0, 0);
    }
    right.normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    const targetNdc = 1 / padding;
    const tanVertical = Math.max(Math.tan(verticalFov / 2), 0.01);
    const horizontalFov = 2 * Math.atan(tanVertical * Math.max(this.camera.aspect, 0.1));
    const tanHorizontal = Math.max(Math.tan(horizontalFov / 2), 0.01);
    let distance = 1;
    const relative = new THREE.Vector3();
    for (const corner of boundsCorners(fitBounds)) {
      relative.copy(corner).sub(center);
      const alongView = relative.dot(direction);
      const widthFit = Math.abs(relative.dot(right)) / (targetNdc * tanHorizontal);
      const heightFit = Math.abs(relative.dot(up)) / (targetNdc * tanVertical);
      distance = Math.max(distance, alongView + widthFit, alongView + heightFit);
    }
    // Set the camera first so clip-depth math can use the actual
    // camera position. Clip ranges come from the whole scene, not the
    // selection, so a giant backdrop in front of the camera does not
    // punch through the near plane and a backdrop far behind does not
    // clip at the far plane. Without this, a "huge backdrop behind a
    // small hero" composition has the backdrop clipped at the far
    // plane; the previous implementation referenced `clipBounds.center`,
    // which is wrong when the selection center is offset from the
    // scene center (e.g. a hero at (0,0,0) with a backdrop 50m behind).
    this.camera.position.copy(center).addScaledVector(direction, distance);
    const depthRelative = new THREE.Vector3();
    let minDepth = Number.POSITIVE_INFINITY;
    let maxDepth = 0;
    for (const corner of boundsCorners(clipBounds)) {
      // depth = (cameraPos - corner) . direction, i.e. the along-view
      // distance from the camera plane to the corner, positive in front
      // of the camera. This is the same value `distance - (corner -
      // center) . direction` would give, but stated in terms of the
      // live camera position so a future change to the placement math
      // stays consistent.
      const depth = depthRelative.copy(this.camera.position).sub(corner).dot(direction);
      minDepth = Math.min(minDepth, depth);
      maxDepth = Math.max(maxDepth, depth);
    }

    this.camera.near = Math.max(0.05, minDepth * 0.25);
    this.camera.far = Math.max(25, maxDepth * 1.5);
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    if (!cameraPoseIsFinite(this.camera)) {
      restoreCameraPose(this.camera, fallbackPose);
      return {
        ok: false,
        reason: "PIE camera framing produced a non-finite pose; restore the entity transforms and retry.",
      };
    }
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = Math.max(5, minDepth * 0.75);
      this.scene.fog.far = Math.max(this.scene.fog.near + 15, maxDepth * 1.5);
    }
    this.callbacks.onFrameCamera?.(center, radius, distance);
    const pose: CameraPoseSetting = {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [center.x, center.y, center.z],
      fov: this.camera.fov,
      near: this.camera.near,
      far: this.camera.far,
      viewDirection: [direction.x, direction.y, direction.z],
      padding,
      sourceEntityIds: framedEntityIds,
    };
    return { ok: true, pose, fitBounds };
  }

  private failWithRestore(reason: string): CameraFrameResult {
    if (this.lastValidCameraPose) {
      restoreCameraPose(this.camera, this.lastValidCameraPose);
      // Unlike the success paths this one does not draw, so the restored
      // pose has to be marked stale for the host's next tick.
      this.invalidate();
    }
    return { ok: false, reason, restored: !!this.lastValidCameraPose };
  }

  dispose(): void {
    // Deliberately not stop(): that rebuilds a whole fresh scene immediately
    // before the renderer is torn down, allocating GPU resources that are
    // then never freed.
    this.disposed = true;
    this.pause();
    this.rejectWaiters("PIE runtime disposed");
    this.unsubscribeAssetAttach();
    this.sandbox.dispose();
    // Free the composer's render targets before the renderer goes away;
    // without this the GPU holds the offscreen bloom targets for the next
    // mounted viewport, and Chrome's ~16-context cap is hit sooner.
    this.postprocess?.dispose();
    this.postprocess = null;
    const group = this.scene.getObjectByName(PROJECT_GROUP);
    if (group) {
      this.scene.remove(group);
      disposeTree(group);
    }
    this.readyGroup = null;
    this.assetReadyPromise = null;
  }
}

/** Storage path inside `project.settings.pie` for a persisted camera pose. */
export const SAVED_CAMERA_POSE_KEY = "camera";

/**
 * Type guard for a stored `CameraPoseSetting`. A pose is valid when every
 * numeric component is finite, the view direction is non-zero, the padding
 * is in the runtime's accepted range, and every `sourceEntityIds` still
 * resolves to a current project entity. Returning the cast value (rather
 * than just `true`) means the caller does not need a second narrowing.
 */
export function validateCameraPoseSetting(
  value: unknown,
  project: Project,
): value is CameraPoseSetting {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!isFiniteVec3(v.position) || !isFiniteVec3(v.target) || !isFiniteVec3(v.viewDirection)) {
    return false;
  }
  if (
    typeof v.fov !== "number" ||
    typeof v.near !== "number" ||
    typeof v.far !== "number" ||
    typeof v.padding !== "number" ||
    !Number.isFinite(v.fov) ||
    !Number.isFinite(v.near) ||
    !Number.isFinite(v.far) ||
    !Number.isFinite(v.padding)
  ) {
    return false;
  }
  if (v.padding < CAMERA_PADDING_MIN || v.padding > CAMERA_PADDING_MAX) {
    return false;
  }
  const vd = v.viewDirection as Vec3;
  if (vd[0] * vd[0] + vd[1] * vd[1] + vd[2] * vd[2] <= 0) {
    return false;
  }
  if (!Array.isArray(v.sourceEntityIds) || !v.sourceEntityIds.every((id) => typeof id === "string")) {
    return false;
  }
  const entityIds = new Set(project.entities.map((entity) => entity.id));
  for (const id of v.sourceEntityIds as string[]) {
    if (!entityIds.has(id)) return false;
  }
  return true;
}

/** Returns the stored pose if it is valid, otherwise null (not an error). */
function readSavedCameraPose(project: Project): CameraPoseSetting | null {
  const settings = (project.settings?.pie ?? {}) as { [SAVED_CAMERA_POSE_KEY]?: unknown };
  const stored = settings[SAVED_CAMERA_POSE_KEY];
  if (!validateCameraPoseSetting(stored, project)) return null;
  return stored;
}

/** Picks the default low-elevation diagonal and normalises it. A zero or
 *  non-finite direction is rejected so the runtime never composes against
 *  a degenerate view vector. */
function validateViewDirection(value: Vec3 | undefined): {
  ok: true;
  value: THREE.Vector3;
} | { ok: false; reason: string } {
  const source: Vec3 = value ?? DEFAULT_CAMERA_DIRECTION;
  if (!Array.isArray(source) || source.length !== 3 || !source.every(Number.isFinite)) {
    return { ok: false, reason: "frameProject: viewDirection must be a finite [x, y, z] triple" };
  }
  const vector = new THREE.Vector3(source[0], source[1], source[2]);
  if (vector.lengthSq() <= 0) {
    return { ok: false, reason: "frameProject: viewDirection must be a non-zero vector" };
  }
  vector.normalize();
  return { ok: true, value: vector };
}

/** Clamp padding to the runtime's accepted range, falling back to the
 *  default when the caller passes nothing or a non-finite value. */
function clampPadding(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CAMERA_PADDING;
  return Math.min(CAMERA_PADDING_MAX, Math.max(CAMERA_PADDING_MIN, value));
}

/** Round-trip a Box3 to a plain object so the result type stays serializable
 *  and the runtime never hands out a live THREE.Vector3 to callers. */
function boundsToVec3(bounds: THREE.Box3): CameraFrameFitBounds {
  return {
    min: [bounds.min.x, bounds.min.y, bounds.min.z],
    max: [bounds.max.x, bounds.max.y, bounds.max.z],
  };
}

function isFiniteVec3(value: unknown): value is Vec3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) => typeof component === "number" && Number.isFinite(component))
  );
}

/** Frees geometry, every material slot, and each material's textures. */
export function disposeTree(root: THREE.Object3D): void {
  const disposedInstances = new Set<ReturnType<typeof getGltfAssetInstance>>();
  root.traverse((node) => {
    const instance = getGltfAssetInstance(node);
    if (instance && !disposedInstances.has(instance)) {
      disposedInstances.add(instance);
      instance.dispose();
    }
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

/** Yields the eight corners of a Box3 as new Vector3 instances. */
function* boundsCorners(bounds: THREE.Box3): IterableIterator<THREE.Vector3> {
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        yield new THREE.Vector3(x, y, z);
      }
    }
  }
}

function cameraPoseIsFinite(camera: THREE.PerspectiveCamera): boolean {
  return [
    camera.position.x,
    camera.position.y,
    camera.position.z,
    camera.quaternion.x,
    camera.quaternion.y,
    camera.quaternion.z,
    camera.quaternion.w,
    camera.near,
    camera.far,
    camera.fov,
    camera.aspect,
  ].every(Number.isFinite);
}
