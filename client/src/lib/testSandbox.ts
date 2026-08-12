import { canUseCspFrame } from "./cspFrameWorker";
import { FrameTestSandbox } from "./frameTestSandbox";
import { deepFreeze } from "./scriptSandboxState";
import type { EntitySnapshot, HostCall, HostResult, RunRequest, RunResult } from "./testSandbox.worker";

/** Capabilities a test body may reach, answered on the main thread. */
export interface TestHost {
  /** Live transforms for every named object; re-read after each host call. */
  snapshot: () => Record<string, EntitySnapshot>;
  /** Fresh structured clone of scripts' shared state. */
  worldSnapshot: () => Promise<Record<string, unknown>>;
  assert: (condition: boolean, message: string) => void;
  log: (message: string) => void;
  step: (frames: number) => Promise<void>;
  baseline: (
    name: string,
    dataUrl: string,
    threshold?: number,
  ) => Promise<{ pass: boolean; distance: number; threshold: number }>;
}

export interface TestSandbox {
  run(testId: string, script: string, scene: RunRequest["scene"], host: TestHost, timeoutMs: number): Promise<void>;
  dispose(): void;
}

/**
 * Worker-backed runner for scripted game tests.
 *
 * Tests need real main-thread capabilities — stepping PIE, reading scene
 * objects, comparing baselines through core — so the worker calls back over a
 * request/response channel instead of being handed those objects. It never
 * holds a reference to anything real, only a call id, so a hostile test body
 * cannot reach the renderer or the RPC surface.
 */
class WorkerTestSandbox implements TestSandbox {
  private worker: Worker | null = null;

  async run(
    testId: string,
    script: string,
    scene: RunRequest["scene"],
    host: TestHost,
    timeoutMs: number,
  ): Promise<void> {
    this.dispose();
    const worker = new Worker(new URL("./testSandbox.worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    const world = await host.worldSnapshot();

    return new Promise<void>((resolve, reject) => {
      // A test that loops forever must not wedge the suite. Terminating the
      // worker is the only reliable way to stop it.
      const timer = window.setTimeout(() => {
        this.dispose();
        reject(new Error(`test timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const settle = (error?: Error) => {
        window.clearTimeout(timer);
        this.dispose();
        if (error) reject(error);
        else resolve();
      };

      worker.onerror = (event) => settle(new Error(event.message || "test worker crashed"));

      worker.onmessage = (event: MessageEvent<HostCall | RunResult>) => {
        const message = event.data;
        if (message.type === "done") {
          settle(message.error ? new Error(message.error) : undefined);
          return;
        }
        void answer(worker, message, host);
      };

      worker.postMessage({ type: "run", testId, script, scene, snapshot: host.snapshot(), world } satisfies RunRequest);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

async function answer(worker: Worker, call: HostCall, host: TestHost): Promise<void> {
  // Every reply carries the post-call scene state so the worker can serve
  // entityFor synchronously.
  const reply = async (result: Omit<HostResult, "type" | "callId" | "snapshot" | "world">) =>
    worker.postMessage({
      type: "callResult",
      callId: call.callId,
      snapshot: host.snapshot(),
      world: await host.worldSnapshot(),
      ...result,
    } satisfies HostResult);
  try {
    switch (call.method) {
      case "assert":
        host.assert(Boolean(call.args[0]), String(call.args[1] ?? "assertion failed"));
        return void (await reply({ value: true }));
      case "log":
        host.log(String(call.args[0]));
        return void (await reply({ value: true }));
      case "step":
        await host.step(Number(call.args[0]));
        return void (await reply({ value: true }));
      case "baseline":
        return void (await reply({
          value: await host.baseline(
            String(call.args[0]),
            String(call.args[1]),
            call.args[2] === undefined ? undefined : Number(call.args[2]),
          ),
        }));
      default:
        return void (await reply({ error: `unknown host call ${String(call.method)}` }));
    }
  } catch (error) {
    await reply({ error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Same contract, executed in-process.
 *
 * Used where Workers are unavailable (jsdom under vitest). It provides **no
 * isolation** and is never selected in a browser.
 */
class InlineTestSandbox implements TestSandbox {
  async run(_testId: string, script: string, scene: RunRequest["scene"], host: TestHost, timeoutMs: number) {
    // Matches the worker's synchronous entityFor exactly, so the fallback
    // cannot mask an API difference the way an async version did.
    const entityFor = (name: string) => host.snapshot()[name] ?? null;
    let world = deepFreeze(await host.worldSnapshot());
    const state = Object.freeze({ get world() { return world; } });
    const outstanding: Promise<void>[] = [];
    let capabilityError: Error | null = null;
    const track = <T>(operation: () => T | Promise<T>): Promise<T> => {
      const raw = Promise.resolve().then(operation);
      const promise = raw.then(
        (value) => value,
        (error) => {
          capabilityError ??= error instanceof Error ? error : new Error(String(error));
          return undefined as T;
        },
      );
      outstanding.push(promise.then(() => undefined));
      return promise;
    };
    const assert = (condition: boolean, message = "assertion failed") =>
      track(() => host.assert(condition, message));
    const log = (message: string) => track(() => host.log(message));
    const step = (frames: number) => track(async () => {
      await host.step(frames);
      world = deepFreeze(await host.worldSnapshot());
    });
    const baseline = (name: string, dataUrl: string, threshold?: number) =>
      track(() => host.baseline(name, dataUrl, threshold));
    const drainCalls = async () => {
      let cursor = 0;
      while (cursor < outstanding.length) {
        const batch = outstanding.slice(cursor);
        cursor = outstanding.length;
        await Promise.all(batch);
      }
      if (capabilityError) throw capabilityError;
    };
    const body = [
      "const scene = context.scene;",
      "const state = context.state;",
      "const entityFor = context.entityFor;",
      "const assert = context.assert;",
      "const log = context.log;",
      "const step = context.step;",
      "const baseline = context.baseline;",
      script,
    ].join("\n");
    // eslint-disable-next-line no-new-func
    const run = new Function("context", `"use strict"; return (async () => { ${body} })();`) as (
      context: unknown,
    ) => Promise<void>;

    let timer = 0;
    const guard = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(`test timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      await Promise.race([
        run({ scene, state, entityFor, assert, log, step, baseline }).then(drainCalls),
        guard,
      ]);
    } finally {
      window.clearTimeout(timer);
    }
  }

  dispose(): void {
    /* nothing to tear down */
  }
}

/**
 * Picks the strongest available isolation.
 *
 * The CSP frame is preferred: a bare Worker cannot refuse dynamic `import()`,
 * and an audit used exactly that to exfiltrate project data out of a scripted
 * test and execute attacker code inside the worker.
 */
export function createTestSandbox(): TestSandbox {
  if (canUseCspFrame()) {
    try {
      return new FrameTestSandbox();
    } catch {
      /* fall through to a bare worker */
    }
  }
  if (typeof Worker !== "undefined") {
    try {
      return new WorkerTestSandbox();
    } catch {
      /* fall through to the inline runner */
    }
  }
  return new InlineTestSandbox();
}
