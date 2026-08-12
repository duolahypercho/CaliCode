import { SCRIPT_STATE_NORMALIZER_SOURCE } from "./scriptSandboxState";
import { SCRIPT_VECTOR_NORMALIZER_SOURCE } from "./scriptSandboxVector";
import type {
  GetWorldStateRequest,
  GetWorldStateResponse,
  SandboxEntity,
  StepRequest,
  StepResponse,
} from "./scriptSandbox.worker";

/**
 * Runs project scripts in a Worker hosted inside a CSP-locked, opaque-origin
 * iframe.
 *
 * Neither layer is sufficient alone, which is why both are here:
 *
 * - A **Worker** gives thread isolation, so `while (true) {}` is contained and
 *   can be terminated. But a Worker cannot carry a Content-Security-Policy,
 *   and dynamic `import()` is syntax rather than a property -- so no amount of
 *   global hardening stops `import("http://host/?" + secret)`.
 * - A **CSP iframe** can refuse `import()` (`script-src` permits no URL
 *   source) and every network call (`connect-src 'none'`). But a same-process
 *   iframe shares the main thread, so an infinite loop freezes the editor.
 *
 * A Worker *inside* the frame inherits the frame's CSP while keeping its own
 * thread. Measured in a real browser: `fetch` to `/rpc` rejects, `import()` of
 * it rejects, and the worker still runs off the main thread.
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` additionally puts the
 * frame on an opaque origin, so a policy bypass still would not be same-origin
 * with the `/rpc` proxy.
 */

const CSP = [
  "default-src 'none'",
  // blob: is required for the worker script; 'unsafe-eval' because user
  // scripts compile with new Function. No http(s) source is permitted, which
  // is what refuses import().
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "worker-src blob:",
  "child-src blob:",
  "connect-src 'none'",
  "img-src 'none'",
  "style-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Runs inside the worker. Compiles and applies scripts; sees only plain data. */
const WORKER_SOURCE = String.raw`
// Defence in depth alongside the CSP. The policy refuses the *request*; this
// removes the *API*, so a script cannot even start one. Deleting along the
// whole prototype chain matters: these live on
// DedicatedWorkerGlobalScope.prototype, not on the instance, so an own-property
// shadow is walked straight past with Object.getPrototypeOf(self).fetch.
var reply = self.postMessage.bind(self);
(function harden() {
  var blocked = ["fetch","XMLHttpRequest","WebSocket","EventSource","Request","Response",
                 "indexedDB","caches","Worker","SharedWorker","BroadcastChannel","navigator",
                 "postMessage","importScripts"];
  var target = self;
  while (target && target !== Object.prototype) {
    for (var i = 0; i < blocked.length; i++) {
      var name = blocked[i];
      if (!Object.prototype.hasOwnProperty.call(target, name)) continue;
      try { delete target[name]; } catch (e) {}
      try { Object.defineProperty(target, name, { value: undefined, configurable: false, writable: false }); } catch (e) {}
    }
    target = Object.getPrototypeOf(target);
  }
})();

${SCRIPT_VECTOR_NORMALIZER_SOURCE}

${SCRIPT_STATE_NORMALIZER_SOURCE}

// Mirrors the standalone worker's persistent state boundary.
var selfState = new Map();
var worldState = {};

var compiled = new Map();
function compile(id, code) {
  var cached = compiled.get(id);
  if (cached && cached.code === code) return cached.fn;
  var fn = new Function(
    "entity", "state", "delta",
    '"use strict";\n' + code + '\nreturn typeof update === "function" ? update(entity, state, delta) : state;'
  );
  compiled.set(id, { code, fn });
  return fn;
}
function buildScene(entities) {
  var snapshots = entities.map(function (entity) {
    return {
      id: entity.id,
      name: entity.name,
      kind: entity.kind,
      visible: entity.visible,
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      rotation: { x: entity.rotation.x, y: entity.rotation.y, z: entity.rotation.z },
      scale: { x: entity.scale.x, y: entity.scale.y, z: entity.scale.z },
    };
  });
  for (var i = 0; i < snapshots.length; i++) deepFreeze(snapshots[i]);
  var frozen = deepFreeze(snapshots);
  var byName = new Map();
  var byId = new Map();
  for (var k = 0; k < snapshots.length; k++) {
    byName.set(snapshots[k].name, snapshots[k]);
    byId.set(snapshots[k].id, snapshots[k]);
  }
  function find(nameOrId) {
    return byName.get(nameOrId) || byId.get(nameOrId) || null;
  }
  return { scene: frozen, find: find };
}
function buildPatch(entities, logs, scriptName, lastScriptName) {
  var byName = new Map();
  var byId = new Map();
  for (var i = 0; i < entities.length; i++) {
    byName.set(entities[i].name, entities[i]);
    byId.set(entities[i].id, entities[i]);
  }
  return function patchEntity(nameOrId, input) {
    if (typeof nameOrId !== "string" || nameOrId.length === 0) {
      logs.push("script " + scriptName + ": state.patch target must be a non-empty entity name or id; ignored");
      return false;
    }
    var target = byName.get(nameOrId) || byId.get(nameOrId);
    if (!target) {
      logs.push("script " + scriptName + ": state.patch could not find entity \"" + nameOrId + "\"; ignored");
      return false;
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      logs.push("script " + scriptName + ": state.patch(\"" + nameOrId + "\") expects an object containing position, rotation, or scale; ignored");
      return false;
    }
    var fields = ["position", "rotation", "scale"];
    var components = ["x", "y", "z"];
    var keys = Object.keys(input);
    var unsupported = keys.filter(function (key) { return fields.indexOf(key) < 0; });
    if (unsupported.length > 0) {
      logs.push("script " + scriptName + ": state.patch(\"" + nameOrId + "\") only supports position, rotation, and scale; ignored " + unsupported.join(", "));
    }
    var changed = false;
    for (var fi = 0; fi < fields.length; fi++) {
      var field = fields[fi];
      if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
      var candidate = input[field];
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        logs.push("script " + scriptName + ": state.patch(\"" + nameOrId + "\")." + field + " must be an object with finite x, y, or z values; ignored");
        continue;
      }
      var supplied = false;
      for (var ci = 0; ci < components.length; ci++) {
        var component = components[ci];
        if (!Object.prototype.hasOwnProperty.call(candidate, component)) continue;
        supplied = true;
        var value = candidate[component];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          logs.push("script " + scriptName + ": state.patch(\"" + nameOrId + "\")." + field + "." + component + " must be finite; ignored");
          continue;
        }
        target[field][component] = value;
        changed = true;
      }
      if (!supplied) {
        logs.push("script " + scriptName + ": state.patch(\"" + nameOrId + "\")." + field + " must include x, y, or z; ignored");
      }
    }
    if (changed) lastScriptName.set(target.id, scriptName);
    var hasTransform = fields.some(function (field) { return field in input; });
    if (!changed && unsupported.length === 0 && !hasTransform) {
      logs.push("script " + scriptName + ": state.patch(\"" + nameOrId + "\") did not include position, rotation, or scale; ignored");
    }
    return changed;
  };
}
self.onmessage = function (event) {
  var request = event.data;
  if (!request) return;
  if (request.type === "getWorldState") {
    reply({ type: "getWorldState", seq: request.seq, world: worldState });
    return;
  }
  if (request.type === "reset") {
    selfState.clear();
    worldState = {};
    compiled.clear();
    reply({ type: "reset-ack" });
    return;
  }
  if (request.type !== "step") return;
  var logs = [];
  var names = request.entities.map(function (e) { return e.name; });
  // Capture the pre-step vectors so a script that writes an array or
  // NaN-poisons a component is reverted to a known-finite value rather
  // than corrupting the live scene.
  var preStep = new Map();
  var lastScriptName = new Map();
  for (var pi = 0; pi < request.entities.length; pi++) {
    preStep.set(request.entities[pi].id, snapshotEntity(request.entities[pi]));
  }
  var built = buildScene(request.entities);
  var scene = built.scene;
  var find = built.find;
  for (var ei = 0; ei < request.entities.length; ei++) {
    var entity = request.entities[ei];
    for (var si = 0; si < entity.scriptIds.length; si++) {
      var scriptId = entity.scriptIds[si];
      var script = null;
      for (var ss = 0; ss < request.scripts.length; ss++) {
        if (request.scripts[ss].id === scriptId) { script = request.scripts[ss]; break; }
      }
      if (!script) continue;
      var perScript = selfState.get(script.id);
      if (!perScript) { perScript = new Map(); selfState.set(script.id, perScript); }
      var selfSlot = perScript.get(entity.id);
      if (!selfSlot) { selfSlot = {}; perScript.set(entity.id, selfSlot); }
      try {
        var patch = buildPatch(request.entities, logs, script.name, lastScriptName);
        compile(script.id, script.code)(entity, {
          time: request.time,
          entities: names,
          scene: scene,
          find: find,
          patch: patch,
          self: selfSlot,
          world: worldState,
        }, request.delta);
        lastScriptName.set(entity.id, script.name);
      } catch (error) {
        logs.push("script " + script.name + ": " + String(error));
      }
    }
  }
  // Normalize persistent stores. Same contract as the standalone worker:
  // JSON-safe, depth-bounded, drop-and-log rather than throw.
  selfState.forEach(function (perScript, scriptId) {
    perScript.forEach(function (slot, entityId) {
      var r = sanitizeScriptState(slot, scriptId + "/" + entityId);
      for (var li = 0; li < r.logs.length; li++) logs.push(r.logs[li]);
      if (r.value && typeof r.value === "object" && !Array.isArray(r.value)) {
        perScript.set(entityId, r.value);
      } else {
        perScript.set(entityId, {});
      }
    });
  });
  var worldResult = sanitizeScriptState(worldState, "world");
  for (var wi = 0; wi < worldResult.logs.length; wi++) logs.push(worldResult.logs[wi]);
  if (worldResult.value && typeof worldResult.value === "object" && !Array.isArray(worldResult.value)) {
    worldState = worldResult.value;
  } else {
    worldState = {};
  }
  reply({
    type: "step",
    seq: request.seq,
    patches: request.entities.map(function (e) {
      var original = preStep.get(e.id);
      if (!original) {
        return { id: e.id, position: e.position, rotation: e.rotation, scale: e.scale };
      }
      var attributed = lastScriptName.get(e.id) || "unknown";
      var normalized = normalizeEntity(original, e, attributed);
      for (var ni = 0; ni < normalized.logs.length; ni++) logs.push(normalized.logs[ni]);
      return {
        id: e.id,
        position: normalized.entity.position,
        rotation: normalized.entity.rotation,
        scale: normalized.entity.scale,
      };
    }),
    logs: logs,
  });
};
`;

/** Runs in the frame. Owns the worker and relays messages to the parent. */
const FRAME_HARNESS = String.raw`
var reply = parent.postMessage.bind(parent);
var source = ${JSON.stringify(WORKER_SOURCE)};
var worker = null;

function spawn() {
  var url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  worker = new Worker(url);
  worker.onmessage = function (event) { reply(event.data, "*"); };
  worker.onerror = function (event) {
    reply({ type: "error", message: String((event && event.message) || "worker error") }, "*");
  };
}

window.addEventListener("message", function (event) {
  var request = event.data;
  if (!request) return;
  if (request.type === "terminate") {
    // Only the frame can stop a spinning worker; the parent has no handle.
    if (worker) worker.terminate();
    spawn();
    reply({ type: "restarted" }, "*");
    return;
  }
  if (request.type === "reset") {
    if (worker) worker.postMessage(request);
    return;
  }
  if ((request.type === "step" || request.type === "getWorldState") && worker) worker.postMessage(request);
});

spawn();
reply({ type: "ready" }, "*");
`;

const SRCDOC = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body><script>${FRAME_HARNESS}<\/script></body></html>`;

const STEP_TIMEOUT_MS = 2000;
const READY_TIMEOUT_MS = 8000;

export interface FrameStepRequest {
  delta: number;
  time: number;
  entities: SandboxEntity[];
  scripts: Array<{ id: string; name: string; code: string }>;
}

export interface FrameStepOutcome {
  patches: StepResponse["patches"];
  logs: string[];
}

export class FrameSandbox {
  private frame: HTMLIFrameElement | null = null;
  private ready: Promise<void>;
  private seq = 0;
  private pending = new Map<number, { resolve: (value: FrameStepOutcome) => void; timer: number }>();
  private worldPending = new Map<number, { resolve: (value: Record<string, unknown>) => void; timer: number }>();
  private resetPending: Array<{ resolve: () => void; timer: number }> = [];
  private readonly onMessage: (event: MessageEvent) => void;

  constructor() {
    this.onMessage = (event: MessageEvent) => {
      if (!this.frame || event.source !== this.frame.contentWindow) return;
      const data = event.data as StepResponse | GetWorldStateResponse | { type: string };
      if (data?.type === "reset-ack") {
        const pending = this.resetPending.shift();
        if (!pending) return;
        window.clearTimeout(pending.timer);
        pending.resolve();
        return;
      }
      if (data?.type === "getWorldState") {
        const response = data as GetWorldStateResponse;
        const pending = this.worldPending.get(response.seq);
        if (!pending) return;
        this.worldPending.delete(response.seq);
        window.clearTimeout(pending.timer);
        pending.resolve(response.world);
        return;
      }
      if (data?.type !== "step") return;
      const response = data as StepResponse;
      const entry = this.pending.get(response.seq);
      if (!entry) return;
      this.pending.delete(response.seq);
      window.clearTimeout(entry.timer);
      entry.resolve({ patches: response.patches, logs: response.logs });
    };
    window.addEventListener("message", this.onMessage);
    this.ready = this.mount();
  }

  private mount(): Promise<void> {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("title", "script sandbox");
    frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    frame.srcdoc = SRCDOC;
    this.frame = frame;

    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("script sandbox did not start")), READY_TIMEOUT_MS);
      const onReady = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow) return;
        if ((event.data as { type?: string })?.type !== "ready") return;
        window.clearTimeout(timer);
        window.removeEventListener("message", onReady);
        resolve();
      };
      window.addEventListener("message", onReady);
      document.body.appendChild(frame);
    });
  }

  async step(request: FrameStepRequest): Promise<FrameStepOutcome> {
    await this.ready;
    const seq = ++this.seq;
    return new Promise<FrameStepOutcome>((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(seq);
        // The frame owns the worker handle, so termination is delegated. Its
        // own event loop is free because the spin is on the worker thread.
        this.frame?.contentWindow?.postMessage({ type: "terminate" }, "*");
        resolve({ patches: [], logs: [`scripts exceeded ${STEP_TIMEOUT_MS}ms and were terminated`] });
      }, STEP_TIMEOUT_MS);

      this.pending.set(seq, { resolve, timer });
      this.frame?.contentWindow?.postMessage({ type: "step", seq, ...request }, "*");
    });
  }

  async getWorldState(): Promise<Record<string, unknown>> {
    await this.ready;
    const seq = ++this.seq;
    return new Promise<Record<string, unknown>>((resolve) => {
      const timer = window.setTimeout(() => {
        this.worldPending.delete(seq);
        resolve({});
      }, STEP_TIMEOUT_MS);
      this.worldPending.set(seq, { resolve, timer });
      this.frame?.contentWindow?.postMessage({ type: "getWorldState", seq } satisfies GetWorldStateRequest, "*");
    });
  }

  reset(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        const index = this.resetPending.findIndex((entry) => entry.resolve === resolve);
        if (index >= 0) this.resetPending.splice(index, 1);
        resolve();
      }, STEP_TIMEOUT_MS);
      this.resetPending.push({ resolve, timer });
      this.frame?.contentWindow?.postMessage({ type: "reset" }, "*");
    });
  }

  dispose(): void {
    for (const entry of this.pending.values()) window.clearTimeout(entry.timer);
    this.pending.clear();
    for (const entry of this.worldPending.values()) {
      window.clearTimeout(entry.timer);
      entry.resolve({});
    }
    this.worldPending.clear();
    for (const pending of this.resetPending) {
      window.clearTimeout(pending.timer);
      pending.resolve();
    }
    this.resetPending = [];
    window.removeEventListener("message", this.onMessage);
    this.frame?.remove();
    this.frame = null;
  }
}

/**
 * True when this environment can host the frame transport.
 *
 * `Worker` is part of the requirement, not incidental: the frame's whole
 * purpose is to host one. Environments without it -- jsdom under vitest --
 * also do not execute scripts inside a srcdoc iframe, so the mount would
 * simply time out. Requiring it keeps the fallback selection correct rather
 * than special-casing the test runner.
 */
export function canUseFrameSandbox(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.createElement === "function" &&
    Boolean(document.body) &&
    typeof Worker !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}
