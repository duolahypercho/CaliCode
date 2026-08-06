import { FrameSandbox, canUseFrameSandbox } from "./frameSandbox";
import type { SandboxEntity, StepRequest, StepResponse } from "./scriptSandbox.worker";

export type { SandboxEntity, SandboxVec3 } from "./scriptSandbox.worker";

export interface StepOutcome {
  patches: StepResponse["patches"];
  logs: string[];
}

export interface ScriptSandbox {
  step(request: Omit<StepRequest, "type" | "seq">): Promise<StepOutcome>;
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
  private pending = new Map<number, { resolve: (value: StepOutcome) => void; timer: number }>();

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
    worker.onmessage = (event: MessageEvent<StepResponse>) => {
      const entry = this.pending.get(event.data.seq);
      if (!entry) return;
      this.pending.delete(event.data.seq);
      window.clearTimeout(entry.timer);
      entry.resolve({ patches: event.data.patches, logs: event.data.logs });
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

      this.pending.set(seq, { resolve, timer });
      this.worker.postMessage({ type: "step", seq, ...request } satisfies StepRequest);
    });
  }

  private restart(): void {
    this.worker.terminate();
    for (const entry of this.pending.values()) {
      window.clearTimeout(entry.timer);
      entry.resolve({ patches: [], logs: ["sandbox restarted"] });
    }
    this.pending.clear();
    this.worker = this.spawn();
  }

  dispose(): void {
    for (const entry of this.pending.values()) window.clearTimeout(entry.timer);
    this.pending.clear();
    this.worker.terminate();
  }
}

/**
 * Same protocol, executed in-process.
 *
 * Used where Workers are unavailable (jsdom under vitest). It provides **no
 * isolation** and is never selected in a browser — `createScriptSandbox`
 * prefers the worker whenever one can be constructed.
 */
class InlineSandbox implements ScriptSandbox {
  private compiled = new Map<string, { code: string; fn: (...args: unknown[]) => unknown }>();

  async step(request: Omit<StepRequest, "type" | "seq">): Promise<StepOutcome> {
    const logs: string[] = [];
    const names = request.entities.map((entity) => entity.name);

    for (const entity of request.entities) {
      for (const scriptId of entity.scriptIds) {
        const script = request.scripts.find((item) => item.id === scriptId);
        if (!script) continue;
        try {
          this.compile(script.id, script.code)(entity, { time: request.time, entities: names }, request.delta);
        } catch (error) {
          logs.push(`script ${script.name}: ${String(error)}`);
        }
      }
    }

    return {
      patches: request.entities.map((entity) => ({
        id: entity.id,
        position: entity.position,
        rotation: entity.rotation,
        scale: entity.scale,
      })),
      logs,
    };
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
  }
}

/**
 * Picks the strongest available isolation.
 *
 * A Worker inside a CSP-locked iframe is preferred because it is the only
 * arrangement that gets both properties. A bare Worker has thread isolation
 * but cannot carry a policy, so dynamic `import()` — syntax, not a property —
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
  scriptIds: string[],
  object: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number } },
): SandboxEntity {
  return {
    id,
    name,
    scriptIds,
    position: { x: object.position.x, y: object.position.y, z: object.position.z },
    rotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z },
    scale: { x: object.scale.x, y: object.scale.y, z: object.scale.z },
  };
}
