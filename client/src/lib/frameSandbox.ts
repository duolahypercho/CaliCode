import type { SandboxEntity, StepResponse } from "./scriptSandbox.worker";

/**
 * Runs project scripts in a Worker hosted inside a CSP-locked, opaque-origin
 * iframe.
 *
 * Neither layer is sufficient alone, which is why both are here:
 *
 * - A **Worker** gives thread isolation, so `while (true) {}` is contained and
 *   can be terminated. But a Worker cannot carry a Content-Security-Policy,
 *   and dynamic `import()` is syntax rather than a property — so no amount of
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

const compiled = new Map();
function compile(id, code) {
  const cached = compiled.get(id);
  if (cached && cached.code === code) return cached.fn;
  const fn = new Function(
    "entity", "state", "delta",
    '"use strict";\n' + code + '\nreturn typeof update === "function" ? update(entity, state, delta) : state;'
  );
  compiled.set(id, { code, fn });
  return fn;
}
self.onmessage = (event) => {
  const request = event.data;
  if (!request || request.type !== "step") return;
  const logs = [];
  const names = request.entities.map((e) => e.name);
  for (const entity of request.entities) {
    for (const scriptId of entity.scriptIds) {
      const script = request.scripts.find((s) => s.id === scriptId);
      if (!script) continue;
      try {
        compile(script.id, script.code)(entity, { time: request.time, entities: names }, request.delta);
      } catch (error) {
        logs.push("script " + script.name + ": " + String(error));
      }
    }
  }
  reply({
    type: "step",
    seq: request.seq,
    patches: request.entities.map((e) => ({ id: e.id, position: e.position, rotation: e.rotation, scale: e.scale })),
    logs,
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
  if (request.type === "step" && worker) worker.postMessage(request);
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
  private readonly onMessage: (event: MessageEvent) => void;

  constructor() {
    this.onMessage = (event: MessageEvent) => {
      if (!this.frame || event.source !== this.frame.contentWindow) return;
      const data = event.data as StepResponse | { type: string };
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

  dispose(): void {
    for (const entry of this.pending.values()) window.clearTimeout(entry.timer);
    this.pending.clear();
    window.removeEventListener("message", this.onMessage);
    this.frame?.remove();
    this.frame = null;
  }
}

/**
 * True when this environment can host the frame transport.
 *
 * `Worker` is part of the requirement, not incidental: the frame's whole
 * purpose is to host one. Environments without it — jsdom under vitest — also
 * do not execute scripts inside a srcdoc iframe, so the mount would simply
 * time out. Requiring it keeps the fallback selection correct rather than
 * special-casing the test runner.
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
