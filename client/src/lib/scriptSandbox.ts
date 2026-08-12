import { FrameSandbox, canUseFrameSandbox } from "./frameSandbox";
import { normalizeEntity, snapshotEntity } from "./scriptSandboxVector";
import { deepFreeze, sanitizeScriptState } from "./scriptSandboxState";
import type {
  SandboxEntity,
  SandboxVec3,
  StepRequest,
  StepResponse,
  GetWorldStateRequest,
  GetWorldStateResponse,
} from "./scriptSandbox.worker";

export type { SandboxEntity, SandboxVec3 } from "./scriptSandbox.worker";

export interface StepOutcome {
  patches: StepResponse["patches"];
  logs: string[];
}

/**
 * The persistent cross-script `state.world` object, returned as a fresh
 * structured-cloned snapshot. Tests need read access to the same
 * shared state scripts write to; the worker sends a clone, so the
 * host never holds a live reference and a test-side mutation cannot
 * leak back into the next step.
 */
export type WorldStateSnapshot = GetWorldStateResponse["world"];

export interface ScriptSandbox {
  step(request: Omit<StepRequest, "type" | "seq">): Promise<StepOutcome>;
  /**
   * Returns a structured-cloned snapshot of the live `state.world`. The
   * snapshot is the value as of the last completed `step` (or the
   * initial empty object before the first step). A test that mutates
   * the returned object does not affect subsequent steps.
   */
  getWorldState(): Promise<WorldStateSnapshot>;
  /** Clears the per-script and shared state at a runtime boundary. */
  reset(): Promise<void>;
  dispose(): void;
}

/** How long a single frame's scripts may run before the sandbox gives up. */
const STEP_TIMEOUT_MS = 2000;

/**
 * Worker-backed sandbox. Scripts run off the main thread with no DOM and no
 * same-origin fetch, so a hostile project file can no longer reach `/rpc`.
 */
class WorkerSandbox implements ScriptSandbox {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<
    number,
    | { kind: "step"; resolve: (value: StepOutcome) => void; timer: number }
    | { kind: "worldState"; resolve: (value: WorldStateSnapshot) => void; timer: number }
  >();
  private resetPending: Array<{ resolve: () => void; timer: number }> = [];

  constructor() {
    this.worker = this.spawn();
  }

  /**
   * Builds a worker with its handler attached.
   *
   * restart() used to construct a bare worker and never re-attach onmessage,
   * so the replacement was mute: after a single script timeout every later
   * step timed out too, scripting was dead for the session, and each dead step
   * spawned another abandoned worker.
   */
  private spawn(): Worker {
    const worker = new Worker(new URL("./scriptSandbox.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<StepResponse | GetWorldStateResponse | { type: "reset-ack" }>) => {
      const data = event.data;
      if (data?.type === "reset-ack") {
        const pending = this.resetPending.shift();
        if (!pending) return;
        window.clearTimeout(pending.timer);
        pending.resolve();
        return;
      }
      const entry = this.pending.get(data.seq);
      if (!entry) return;
      this.pending.delete(data.seq);
      window.clearTimeout(entry.timer);
      if (data.type === "getWorldState") {
        if (entry.kind === "worldState") entry.resolve(data.world);
      } else if (entry.kind === "step") {
        entry.resolve({ patches: data.patches, logs: data.logs });
      }
    };
    return worker;
  }

  step(request: Omit<StepRequest, "type" | "seq">): Promise<StepOutcome> {
    const seq = ++this.seq;
    return new Promise<StepOutcome>((resolve) => {
      // An infinite loop in a script must not wedge the runtime forever. The
      // worker is torn down and the frame reported rather than hung.
      const timer = window.setTimeout(() => {
        this.pending.delete(seq);
        this.restart();
        resolve({ patches: [], logs: [`scripts exceeded ${STEP_TIMEOUT_MS}ms and were terminated`] });
      }, STEP_TIMEOUT_MS);

      this.pending.set(seq, { kind: "step", resolve, timer });
      this.worker.postMessage({ type: "step", seq, ...request } satisfies StepRequest);
    });
  }

  /**
   * Round-trips a `getWorldState` request to the worker and resolves
   * with the structured-cloned payload. The worker already sanitizes
   * `worldState` after every step, so the reply is safe to expose
   * directly to a test sandbox without a second pass.
   */
  async getWorldState(): Promise<WorldStateSnapshot> {
    const seq = ++this.seq;
    return new Promise<WorldStateSnapshot>((resolve) => {
      // A timed-out read must not leave a dangling pending entry;
      // otherwise the next reply on the same seq would deliver a
      // stale world snapshot to a future caller. An empty fallback
      // is the same default the worker has before the first step.
      const timer = window.setTimeout(() => {
        this.pending.delete(seq);
        resolve({});
      }, STEP_TIMEOUT_MS);
      this.pending.set(seq, {
        kind: "worldState",
        resolve,
        timer,
      });
      this.worker.postMessage({ type: "getWorldState", seq } satisfies GetWorldStateRequest);
    });
  }

  reset(): Promise<void> {
    return new Promise<void>((resolve) => {
      // Worker round-trips outlive the runtime's life; if the worker is
      // gone we resolve immediately rather than hold the reset promise open.
      const timer = window.setTimeout(() => {
        const index = this.resetPending.findIndex((entry) => entry.resolve === resolve);
        if (index >= 0) this.resetPending.splice(index, 1);
        resolve();
      }, STEP_TIMEOUT_MS);
      this.resetPending.push({ resolve, timer });
      this.worker.postMessage({ type: "reset" });
    });
  }

  private restart(): void {
    this.worker.terminate();
    for (const entry of this.pending.values()) {
      window.clearTimeout(entry.timer);
      // A restart that fires while a `getWorldState` read is in flight
      // must not invent a StepOutcome; the read just resolves to an
      // empty world (same default as before the first step).
      if (entry.kind === "worldState") {
        entry.resolve({});
      } else {
        entry.resolve({ patches: [], logs: ["sandbox restarted"] });
      }
    }
    this.pending.clear();
    for (const pending of this.resetPending) {
      window.clearTimeout(pending.timer);
      pending.resolve();
    }
    this.resetPending = [];
    this.worker = this.spawn();
  }

  dispose(): void {
    for (const entry of this.pending.values()) window.clearTimeout(entry.timer);
    this.pending.clear();
    for (const pending of this.resetPending) {
      window.clearTimeout(pending.timer);
      pending.resolve();
    }
    this.resetPending = [];
    this.worker.terminate();
  }
}

/**
 * Same protocol, executed in-process.
 *
 * Used where Workers are unavailable (jsdom under vitest). It provides **no
 * isolation** and is never selected in a browser -- `createScriptSandbox`
 * prefers the worker whenever one can be constructed.
 */
class InlineSandbox implements ScriptSandbox {
  private compiled = new Map<string, { code: string; fn: (...args: unknown[]) => unknown }>();
  /** Persistent across calls; cleared by reset(). */
  private selfState = new Map<string, Map<string, Record<string, unknown>>>();
  private worldState: Record<string, unknown> = {};

  async step(request: Omit<StepRequest, "type" | "seq">): Promise<StepOutcome> {
    const logs: string[] = [];
    const names = request.entities.map((entity) => entity.name);
    // Capture the pre-step vectors so a script that writes an array or
    // NaN-poisons a component is reverted to a known-finite value rather
    // than corrupting the live scene.
    const preStep = new Map<string, ReturnType<typeof snapshotEntity>>();
    const lastScriptName = new Map<string, string>();
    for (const entity of request.entities) {
      preStep.set(entity.id, snapshotEntity(entity));
    }

    const { scene, find } = buildScene(request.entities);

    for (const entity of request.entities) {
      for (const scriptId of entity.scriptIds) {
        const script = request.scripts.find((item) => item.id === scriptId);
        if (!script) continue;
        let perScript = this.selfState.get(script.id);
        if (!perScript) {
          perScript = new Map();
          this.selfState.set(script.id, perScript);
        }
        let selfSlot = perScript.get(entity.id);
        if (!selfSlot) {
          selfSlot = {};
          perScript.set(entity.id, selfSlot);
        }
        try {
          const patch = buildPatch(request.entities, logs, script.name, lastScriptName);
          this.compile(script.id, script.code)(
            entity,
            {
              time: request.time,
              entities: names,
              scene,
              find,
              patch,
              self: selfSlot,
              world: this.worldState,
            },
            request.delta,
          );
          lastScriptName.set(entity.id, script.name);
        } catch (error) {
          logs.push(`script ${script.name}: ${String(error)}`);
        }
      }
    }

    // Post-step normalization keeps the persistent stores honest. The
    // worker path does the same; without it a script that pinned a
    // megabyte string would survive until the next reset.
    for (const [scriptId, perScript] of this.selfState) {
      for (const [entityId, slot] of perScript) {
        const result = sanitizeScriptState(slot, `${scriptId}/${entityId}`);
        for (const line of result.logs) logs.push(line);
        if (result.value && typeof result.value === "object" && !Array.isArray(result.value)) {
          perScript.set(entityId, result.value as Record<string, unknown>);
        } else {
          perScript.set(entityId, {});
        }
      }
    }
    const worldResult = sanitizeScriptState(this.worldState, "world");
    for (const line of worldResult.logs) logs.push(line);
    if (worldResult.value && typeof worldResult.value === "object" && !Array.isArray(worldResult.value)) {
      this.worldState = worldResult.value as Record<string, unknown>;
    } else {
      this.worldState = {};
    }

    return {
      patches: request.entities.map((entity) => {
        const original = preStep.get(entity.id);
        if (!original) {
          return {
            id: entity.id,
            position: entity.position,
            rotation: entity.rotation,
            scale: entity.scale,
          };
        }
        const attributed = lastScriptName.get(entity.id) ?? "unknown";
        const normalized = normalizeEntity(original, entity, attributed);
        for (const line of normalized.logs) logs.push(line);
        return {
          id: entity.id,
          position: normalized.entity.position,
          rotation: normalized.entity.rotation,
          scale: normalized.entity.scale,
        };
      }),
      logs,
    };
  }

  async reset(): Promise<void> {
    this.selfState.clear();
    this.worldState = {};
    this.compiled.clear();
  }

  /** Inline still needs a deep clone: the test sandbox freezes its copy, and
   * freezing nested objects shared with `worldState` would otherwise freeze
   * the live script store too. The state normalizer guarantees clone-safe
   * JSON values before this method can run. */
  getWorldState(): Promise<WorldStateSnapshot> {
    return Promise.resolve(structuredClone(this.worldState));
  }

  private compile(id: string, code: string) {
    const cached = this.compiled.get(id);
    if (cached && cached.code === code) return cached.fn;
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "entity",
      "state",
      "delta",
      `"use strict";\n${code}\nreturn typeof update === "function" ? update(entity, state, delta) : state;`,
    ) as (...args: unknown[]) => unknown;
    this.compiled.set(id, { code, fn });
    return fn;
  }

  dispose(): void {
    this.compiled.clear();
    this.selfState.clear();
    this.worldState = {};
  }
}

/**
 * Builds a frozen scene snapshot and a `find` closure bound to it. Lifted
 * from the worker so the inline runner can produce byte-equivalent state
 * views; the same `deepFreeze` makes a `state.scene[i].position.x = 0`
 * write throw under strict mode.
 */
function buildScene(entities: SandboxEntity[]) {
  const snapshots = entities.map((entity) => ({
    id: entity.id,
    name: entity.name,
    kind: entity.kind,
    position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    rotation: { x: entity.rotation.x, y: entity.rotation.y, z: entity.rotation.z },
    scale: { x: entity.scale.x, y: entity.scale.y, z: entity.scale.z },
    visible: entity.visible,
  }));
  for (const snap of snapshots) deepFreeze(snap);
  const frozen = deepFreeze(snapshots);
  const byName = new Map<string, (typeof snapshots)[number]>();
  const byId = new Map<string, (typeof snapshots)[number]>();
  for (const snap of snapshots) {
    byName.set(snap.name, snap);
    byId.set(snap.id, snap);
  }
  function find(nameOrId: string) {
    return byName.get(nameOrId) ?? byId.get(nameOrId) ?? null;
  }
  return { scene: frozen, find };
}

const TRANSFORM_FIELDS = ["position", "rotation", "scale"] as const;
const VECTOR_COMPONENTS = ["x", "y", "z"] as const;

/** Inline mirror of the worker's bounded cross-entity transform capability. */
function buildPatch(
  entities: SandboxEntity[],
  logs: string[],
  scriptName: string,
  lastScriptName: Map<string, string>,
) {
  const byName = new Map(entities.map((entity) => [entity.name, entity]));
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  return (nameOrId: unknown, input: unknown): boolean => {
    if (typeof nameOrId !== "string" || nameOrId.length === 0) {
      logs.push(`script ${scriptName}: state.patch target must be a non-empty entity name or id; ignored`);
      return false;
    }
    const target = byName.get(nameOrId) ?? byId.get(nameOrId);
    if (!target) {
      logs.push(`script ${scriptName}: state.patch could not find entity "${nameOrId}"; ignored`);
      return false;
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      logs.push(
        `script ${scriptName}: state.patch("${nameOrId}") expects an object containing position, rotation, or scale; ignored`,
      );
      return false;
    }

    const patch = input as Record<string, unknown>;
    const unsupported = Object.keys(patch).filter(
      (key) => !(TRANSFORM_FIELDS as readonly string[]).includes(key),
    );
    if (unsupported.length > 0) {
      logs.push(
        `script ${scriptName}: state.patch("${nameOrId}") only supports position, rotation, and scale; ignored ${unsupported.join(", ")}`,
      );
    }

    let changed = false;
    for (const field of TRANSFORM_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
      const candidate = patch[field];
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        logs.push(
          `script ${scriptName}: state.patch("${nameOrId}").${field} must be an object with finite x, y, or z values; ignored`,
        );
        continue;
      }
      let supplied = false;
      for (const component of VECTOR_COMPONENTS) {
        if (!Object.prototype.hasOwnProperty.call(candidate, component)) continue;
        supplied = true;
        const value = (candidate as Record<string, unknown>)[component];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          logs.push(
            `script ${scriptName}: state.patch("${nameOrId}").${field}.${component} must be finite; ignored`,
          );
          continue;
        }
        target[field][component] = value;
        changed = true;
      }
      if (!supplied) {
        logs.push(
          `script ${scriptName}: state.patch("${nameOrId}").${field} must include x, y, or z; ignored`,
        );
      }
    }
    if (changed) lastScriptName.set(target.id, scriptName);
    if (!changed && unsupported.length === 0 && !TRANSFORM_FIELDS.some((field) => field in patch)) {
      logs.push(
        `script ${scriptName}: state.patch("${nameOrId}") did not include position, rotation, or scale; ignored`,
      );
    }
    return changed;
  };
}

/**
 * Picks the strongest available isolation.
 *
 * A Worker inside a CSP-locked iframe is preferred because it is the only
 * arrangement that gets both properties. A bare Worker has thread isolation
 * but cannot carry a policy, so dynamic `import()` -- syntax, not a property --
 * stays open. A bare CSP iframe refuses `import()` but shares the main
 * thread, so `while (true) {}` freezes the editor. Nesting the worker inside
 * the frame inherits the policy and keeps the thread.
 *
 * The bare Worker remains the fallback: it is the weaker of the two on
 * exfiltration but never hangs the application.
 */
export function createScriptSandbox(): ScriptSandbox {
  if (canUseFrameSandbox()) {
    try {
      return new FrameSandbox();
    } catch {
      /* fall through to a bare worker */
    }
  }
  if (typeof Worker !== "undefined") {
    try {
      return new WorkerSandbox();
    } catch {
      /* fall through to the inline runner */
    }
  }
  return new InlineSandbox();
}

/** Projects a three.js-shaped entity into the plain payload scripts receive. */
export function toSandboxEntity(
  id: string,
  name: string,
  kind: string,
  visible: boolean,
  scriptIds: string[],
  object: {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
  },
): SandboxEntity {
  return {
    id,
    name,
    kind,
    visible,
    scriptIds,
    position: { x: object.position.x, y: object.position.y, z: object.position.z },
    rotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z },
    scale: { x: object.scale.x, y: object.scale.y, z: object.scale.z },
  };
}
