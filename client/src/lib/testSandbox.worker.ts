/// <reference lib="webworker" />

/**
 * Runs scripted game tests off the main thread.
 *
 * Test bodies come from the same untrusted sources as project scripts — agent
 * output, project JSON loaded from disk — and were the last thing still
 * evaluated with `new Function` in the page realm, same origin as the `/rpc`
 * proxy. A test could `fetch('/rpc', …)` and reach `file_read`.
 *
 * Unlike project scripts, tests genuinely need main-thread capabilities
 * (stepping PIE, reading scene objects, comparing baselines through core), so
 * the worker calls back over a request/response channel rather than being
 * handed those objects directly. The worker never holds a reference to
 * anything real — only a call id.
 */

import { hardenWorkerScope } from "./hardenWorkerScope";
import { deepFreeze } from "./scriptSandboxState";

/** Live transform of one scene object, as scripts observe it. */
export interface EntitySnapshot {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
}

export interface RunRequest {
  type: "run";
  testId: string;
  script: string;
  /** Transforms at the moment the test starts. Refreshed on every host reply. */
  snapshot: Record<string, EntitySnapshot>;
  /** Read-only shared script state at test start. */
  world: Record<string, unknown>;
  /** Lightweight scene descriptor. Deliberately excludes asset payloads and
   *  script source — a test never needs them inside the sandbox. */
  scene: { slug: string; entities: Array<{ id: string; name: string; kind: string }> };
}

export interface HostCall {
  type: "call";
  callId: number;
  method: "assert" | "log" | "step" | "baseline";
  args: unknown[];
}

export interface HostResult {
  type: "callResult";
  callId: number;
  value?: unknown;
  error?: string;
  /** Scene state after the call, so `entityFor` can stay synchronous. */
  snapshot: Record<string, EntitySnapshot>;
  /** Shared script state after the call, especially after step(). */
  world: Record<string, unknown>;
}

export interface RunResult {
  type: "done";
  testId: string;
  error?: string;
}

type Outbound = HostCall | RunResult;

const NETWORK_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "importScripts",
  "EventSource",
  "Request",
  "Response",
  "indexedDB",
  "caches",
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
  "navigator",
];

// Captured before hardening: the harness still needs to reply, and
// postMessage is removed from the scope so a test body cannot use it to
// exfiltrate.
const reply = self.postMessage.bind(self);
hardenWorkerScope(self);

/**
 * Latest known transforms.
 *
 * `entityFor` has always been synchronous — `entityFor('Hero Cube').rotation.y`
 * is the documented shape and the starter project uses it. Round-tripping the
 * read to the host would have made it return a Promise and silently broken
 * every existing test script, so the host attaches a fresh snapshot to each
 * reply and reads are served from here.
 */
let snapshot: Record<string, EntitySnapshot> = {};
let world: Record<string, unknown> = {};

let nextCallId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let outstanding: Promise<void>[] = [];
let capabilityError: Error | null = null;

function post(message: Outbound): void {
  reply(message);
}

/** Round-trips one capability call to the host. */
function callHost(method: HostCall["method"], args: unknown[]): Promise<unknown> {
  const callId = nextCallId++;
  const raw = new Promise<unknown>((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    post({ type: "call", callId, method, args });
  });
  // The caller-facing promise resolves after recording failures instead of
  // rejecting. drainCalls() is the sole rejection point, so both awaited and
  // unawaited capability failures follow the same deterministic path without
  // creating a global unhandled rejection.
  const promise = raw.then(
    (value) => value,
    (error) => {
      capabilityError ??= error instanceof Error ? error : new Error(String(error));
      return undefined;
    },
  );
  outstanding.push(promise.then(() => undefined));
  return promise;
}

/**
 * Waits until the capability queue reaches quiescence. A promise continuation
 * can issue another call (step().then(() => assert(...))), so one snapshot of
 * the queue is insufficient; the loop includes calls appended while draining.
 */
async function drainCalls(): Promise<void> {
  let cursor = 0;
  while (cursor < outstanding.length) {
    const batch = outstanding.slice(cursor);
    cursor = outstanding.length;
    await Promise.all(batch);
  }
  if (capabilityError) throw capabilityError;
}

self.onmessage = (event: MessageEvent<RunRequest | HostResult>) => {
  const message = event.data;

  if (message.type === "callResult") {
    const entry = pending.get(message.callId);
    if (!entry) return;
    pending.delete(message.callId);
    if (message.snapshot) snapshot = message.snapshot;
    if (message.world) world = deepFreeze(message.world);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.value);
    return;
  }

  if (message.type !== "run") return;

  snapshot = message.snapshot;
  world = deepFreeze(message.world ?? {});
  outstanding = [];
  capabilityError = null;

  void (async () => {
    const state = Object.freeze({
      get world() {
        return world;
      },
    });
    const context = {
      scene: message.scene,
      state,
      entityFor: (name: string): EntitySnapshot | null => snapshot[name] ?? null,
      assert: async (condition: boolean, text = "assertion failed") => {
        await callHost("assert", [condition, text]);
      },
      log: (text: string) => void callHost("log", [text]),
      step: (frames: number) => callHost("step", [frames]),
      baseline: (name: string, dataUrl: string, threshold?: number) =>
        callHost("baseline", [name, dataUrl, threshold]),
    };

    try {
      const body = [
        "const scene = context.scene;",
        "const state = context.state;",
        "const entityFor = context.entityFor;",
        "const assert = context.assert;",
        "const log = context.log;",
        "const step = context.step;",
        "const baseline = context.baseline;",
        message.script,
      ].join("\n");

      // eslint-disable-next-line no-new-func
      const run = new Function(
        ...NETWORK_GLOBALS,
        "context",
        `"use strict"; return (async () => { ${body} })();`,
      ) as (...args: unknown[]) => Promise<void>;

      try {
        await run(...NETWORK_GLOBALS.map(() => undefined), context);
      } catch (error) {
        // A failed capability call resolves `undefined` into the script, so the
        // script's own TypeError surfaces first and buries the real cause. The
        // capability error happened earlier; report that.
        throw capabilityError ?? error;
      }
      await drainCalls();
      post({ type: "done", testId: message.testId });
    } catch (error) {
      post({ type: "done", testId: message.testId, error: error instanceof Error ? error.message : String(error) });
    }
  })();
};
