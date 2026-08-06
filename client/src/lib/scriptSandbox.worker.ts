/// <reference lib="webworker" />

/**
 * Runs project scripts off the main thread.
 *
 * Scripts arrive from three untrusted sources — agent output, project JSON
 * loaded from disk, and imported `.cali` assets. They used to be evaluated
 * with `new Function` in the page realm, same origin as the `/rpc` proxy, so
 * a "game script" could `fetch('/rpc', …)` and reach `file_read` on frame 1.
 *
 * A worker gives real isolation: no `document`, no `window`, no parent DOM.
 * Network APIs are additionally shadowed below, so the common exfiltration
 * paths are gone rather than merely inconvenient.
 *
 * Scripts see plain `{x, y, z}` vectors, never live three.js objects — the
 * boundary is the point, and scripts had no business touching renderer
 * internals anyway.
 */

export interface SandboxVec3 {
  x: number;
  y: number;
  z: number;
}

export interface SandboxEntity {
  id: string;
  name: string;
  scriptIds: string[];
  position: SandboxVec3;
  rotation: SandboxVec3;
  scale: SandboxVec3;
}

export interface StepRequest {
  type: "step";
  seq: number;
  delta: number;
  time: number;
  entities: SandboxEntity[];
  scripts: Array<{ id: string; name: string; code: string }>;
}

export interface StepResponse {
  type: "step";
  seq: number;
  patches: Array<{ id: string; position: SandboxVec3; rotation: SandboxVec3; scale: SandboxVec3 }>;
  logs: string[];
}

type ScriptFn = (entity: SandboxEntity, state: Record<string, unknown>, delta: number) => unknown;

const compiled = new Map<string, { code: string; fn: ScriptFn }>();

/**
 * Network capabilities removed from the worker's own global scope, before any
 * script is compiled.
 *
 * Shadowing them as function parameters alone is not enough: a script body can
 * reach the real global with `Function("return this")()` and read `fetch` off
 * it. This runs once at startup and the worker never needs them, so deleting
 * them closes that path rather than merely obscuring it.
 */
function hardenGlobalScope(): void {
  const scope = self as unknown as Record<string, unknown>;
  for (const name of [
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
  ]) {
    try {
      Object.defineProperty(scope, name, { value: undefined, configurable: false, writable: false });
    } catch {
      /* already locked down, or not present in this runtime */
    }
  }
}

hardenGlobalScope();

/**
 * Names shadowed as `undefined` parameters so a script body referencing them
 * gets undefined rather than the worker's own capability. Blocks the direct
 * exfiltration paths that remain available inside a worker.
 */
const SHADOWED = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "importScripts",
  "EventSource",
  "Request",
  "Response",
  "navigator",
  "self",
  "globalThis",
  "postMessage",
  "indexedDB",
  "caches",
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
] as const;

function compile(id: string, code: string): ScriptFn {
  const cached = compiled.get(id);
  if (cached && cached.code === code) return cached.fn;

  const body = `"use strict";\n${code}\nreturn typeof update === "function" ? update(entity, state, delta) : state;`;
  // eslint-disable-next-line no-new-func
  const factory = new Function(...SHADOWED, "entity", "state", "delta", body);
  const fn: ScriptFn = (entity, state, delta) =>
    factory(...SHADOWED.map(() => undefined), entity, state, delta);

  compiled.set(id, { code, fn });
  return fn;
}

self.onmessage = (event: MessageEvent<StepRequest>) => {
  const request = event.data;
  if (request?.type !== "step") return;

  const logs: string[] = [];
  const names = request.entities.map((entity) => entity.name);

  for (const entity of request.entities) {
    for (const scriptId of entity.scriptIds) {
      const script = request.scripts.find((item) => item.id === scriptId);
      if (!script) continue;
      try {
        // A fresh state object per script: a mutation by one script must not
        // silently leak into the next one's view of the world.
        compile(script.id, script.code)(entity, { time: request.time, entities: names }, request.delta);
      } catch (error) {
        logs.push(`script ${script.name}: ${String(error)}`);
      }
    }
  }

  const response: StepResponse = {
    type: "step",
    seq: request.seq,
    patches: request.entities.map((entity) => ({
      id: entity.id,
      position: entity.position,
      rotation: entity.rotation,
      scale: entity.scale,
    })),
    logs,
  };
  self.postMessage(response);
};
