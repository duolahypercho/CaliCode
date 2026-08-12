/// <reference lib="webworker" />

/**
 * Runs project scripts off the main thread.
 *
 * Scripts arrive from three untrusted sources -- agent output, project JSON
 * loaded from disk, and imported `.cali` assets. They used to be evaluated
 * with `new Function` in the page realm, same origin as the `/rpc` proxy, so
 * a "game script" could `fetch('/rpc', ...)` and reach `file_read` on frame 1.
 *
 * A worker gives real isolation: no `document`, no `window`, no parent DOM.
 * Network APIs are additionally shadowed below, so the common exfiltration
 * paths are gone rather than merely inconvenient.
 *
 * Scripts see plain `{x, y, z}` vectors, never live three.js objects -- the
 * boundary is the point, and scripts had no business touching renderer
 * internals anyway.
 *
 * The state boundary exposes legacy entity names, frozen scene snapshots and
 * lookup by name/id. `state.self` persists per script/entity and `state.world`
 * is shared across scripts; both are reset with the runtime and sanitized to
 * bounded JSON-safe data after each step.
 */

import { hardenWorkerScope } from "./hardenWorkerScope";
import { normalizeEntity, snapshotEntity } from "./scriptSandboxVector";
import { deepFreeze, sanitizeScriptState } from "./scriptSandboxState";

export interface SandboxVec3 {
  x: number;
  y: number;
  z: number;
}

export interface SandboxEntity {
  id: string;
  name: string;
  kind: string;
  visible: boolean;
  position: SandboxVec3;
  rotation: SandboxVec3;
  scale: SandboxVec3;
  scriptIds: string[];
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

export interface ResetResponse {
  type: "reset-ack";
}

/**
 * A test sandbox asks the script sandbox for the latest `state.world`
 * snapshot. The reply is a structured clone (postMessage semantics) so the
 * host receives an unshared value; the test sandbox freezes its own copy.
 */
export interface GetWorldStateRequest {
  type: "getWorldState";
  seq: number;
}

export interface GetWorldStateResponse {
  type: "getWorldState";
  seq: number;
  world: Record<string, unknown>;
}

type ScriptFn = (entity: SandboxEntity, state: Record<string, unknown>, delta: number) => unknown;

const compiled = new Map<string, { code: string; fn: ScriptFn }>();

// Persistent across messages: one entry per (scriptId, entityId) for
// `state.self`, one object for `state.world`. Cleared by the `reset`
// request, never by the step loop itself.
const selfState = new Map<string, Map<string, Record<string, unknown>>>();
let worldState: Record<string, unknown> = {};

// Captured before hardening: the harness still needs to reply, and
// postMessage is removed from the scope so a script body cannot use it to
// exfiltrate.
const reply = self.postMessage.bind(self);
hardenWorkerScope(self);

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

/**
 * Builds a frozen scene snapshot and a `find` closure bound to it for a
 * given step. Both are recreated every step so position/rotation/scale are
 * fresh, but the objects themselves are frozen so a script body cannot
 * mutate them and corrupt the next step's view.
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
  // Freeze the array and every record inside so `state.scene[i].position.x = 0`
  // throws in strict mode (every script body runs `"use strict"`).
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

/**
 * Builds the only cross-entity write capability exposed to game scripts.
 * The frozen scene/find snapshots remain read-only and stable for the whole
 * step; this closure writes only finite transform components on the separate
 * mutable protocol entities that are returned to the host as patches.
 */
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

interface InboundMessage extends StepRequest {
  type: "step";
}

self.onmessage = (event: MessageEvent<StepRequest | { type: "reset" } | GetWorldStateRequest>) => {
  const request = event.data;
  if (!request || typeof request !== "object") return;

  if (request.type === "getWorldState") {
    // postMessage structured-clones the payload, so the host receives an
    // unshared copy and the worker's `worldState` stays private. A test
    // sandbox that mutates the reply cannot leak back into the next step.
    reply({
      type: "getWorldState",
      seq: request.seq,
      world: worldState,
    } satisfies GetWorldStateResponse);
    return;
  }

  if (request.type === "reset") {
    selfState.clear();
    worldState = {};
    compiled.clear();
    reply({ type: "reset-ack" } satisfies ResetResponse);
    return;
  }

  if (request.type !== "step") return;
  const stepRequest = request;

  const logs: string[] = [];
  const names = stepRequest.entities.map((entity) => entity.name);
  // Scripts can write an array where the protocol requires a {x,y,z}
  // object, or poison a component with NaN; the boundary normalizer
  // turns either into a usable vec3 and reverts the rest to the pre-step
  // value. Capture the originals before any script runs.
  const preStep = new Map<string, ReturnType<typeof snapshotEntity>>();
  const lastScriptName = new Map<string, string>();
  for (const entity of stepRequest.entities) {
    preStep.set(entity.id, snapshotEntity(entity));
  }

  const { scene, find } = buildScene(stepRequest.entities);

  for (const entity of stepRequest.entities) {
    for (const scriptId of entity.scriptIds) {
      const script = stepRequest.scripts.find((item) => item.id === scriptId);
      if (!script) continue;
      let perScript = selfState.get(script.id);
      if (!perScript) {
        perScript = new Map();
        selfState.set(script.id, perScript);
      }
      let selfSlot = perScript.get(entity.id);
      if (!selfSlot) {
        selfSlot = {};
        perScript.set(entity.id, selfSlot);
      }
      // Snapshot the world per script call so a script that swaps
      // `state.world = "string"` mid-step does not corrupt the next script's
      // view. Re-bound to the live object only after every script for this
      // entity has run, via the post-step normalization below.
      const worldSnapshot = worldState;
      try {
        const patch = buildPatch(stepRequest.entities, logs, script.name, lastScriptName);
        compile(script.id, script.code)(
          entity,
          {
            time: stepRequest.time,
            entities: names,
            scene,
            find,
            patch,
            self: selfSlot,
            world: worldSnapshot,
          },
          stepRequest.delta,
        );
        lastScriptName.set(entity.id, script.name);
        if (worldState !== worldSnapshot) worldState = worldSnapshot;
      } catch (error) {
        logs.push(`script ${script.name}: ${String(error)}`);
      }
    }
  }

  // Normalize the persistent stores after every step. A script that pinned
  // a function, a DOM node, or a 200KB string is dropped here so the next
  // step never has to clone it. The log lines surface the misbehaviour
  // without halting the runtime.
  for (const [scriptId, perScript] of selfState) {
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
  const worldResult = sanitizeScriptState(worldState, "world");
  for (const line of worldResult.logs) logs.push(line);
  if (worldResult.value && typeof worldResult.value === "object" && !Array.isArray(worldResult.value)) {
    worldState = worldResult.value as Record<string, unknown>;
  } else {
    worldState = {};
  }

  const response: StepResponse = {
    type: "step",
    seq: stepRequest.seq,
    patches: stepRequest.entities.map((entity) => {
      const original = preStep.get(entity.id);
      // A script id is always present for a scripted entity, so this
      // lookup is for logging attribution only; "unknown" keeps the
      // message actionable without claiming a wrong culprit.
      const attributed = lastScriptName.get(entity.id) ?? "unknown";
      if (!original) {
        return {
          id: entity.id,
          position: entity.position,
          rotation: entity.rotation,
          scale: entity.scale,
        };
      }
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
  reply(response);
};
