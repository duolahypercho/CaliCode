import { expect, test, type Page } from "@playwright/test";

/**
 * Worker-path coverage for both sandboxes.
 *
 * These have to be e2e tests. Under jsdom `Worker` is undefined, so the vitest
 * suites exercise the in-process fallback exclusively — which is precisely how
 * two serious defects shipped: a prototype-chain escape that let a script read
 * `/rpc`, and a `restart()` that produced a mute worker and killed scripting
 * for the whole session. Neither was reachable by any existing test.
 *
 * Everything below drives the application's own modules, not a copy.
 */

/** Runs `expr` inside a real sandboxed script; 1 = truthy, 0 = falsy, -1 = threw. */
async function probe(page: Page, expr: string): Promise<number> {
  return page.evaluate(async (source) => {
    const module = await import("/src/lib/scriptSandbox.ts");
    const sandbox = module.createScriptSandbox();
    try {
      const result = await sandbox.step({
        delta: 0.016,
        time: 0,
        entities: [
          module.toSandboxEntity("e1", "Probe", ["s1"], {
            position: { x: 9, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
          }),
        ],
        scripts: [
          {
            id: "s1",
            name: "probe",
            code: `function update(entity){ try { entity.position.x = (${source}) ? 1 : 0; } catch (e) { entity.position.x = -1; } }`,
          },
        ],
      });
      return result.patches[0].position.x;
    } finally {
      sandbox.dispose();
    }
  }, expr);
}

test.describe("script sandbox isolation", () => {
  test("scripts still run", async ({ page }) => {
    await page.goto("/");
    expect(await probe(page, "true")).toBe(1);
  });

  test("network capability is unreachable, including via the prototype chain", async ({ page }) => {
    await page.goto("/");

    // Shadowing `self.fetch` as an own property leaves the real function on
    // DedicatedWorkerGlobalScope.prototype. An audit used exactly the third
    // case below to exfiltrate a 60KB project document from /rpc.
    const vectors = [
      'typeof fetch === "function"',
      'typeof Function("return this")().fetch === "function"',
      'typeof Object.getPrototypeOf(Function("return this")()).fetch === "function"',
      'typeof Object.getPrototypeOf(Function("return this")()).XMLHttpRequest === "function"',
      'typeof Object.getPrototypeOf(Function("return this")()).WebSocket === "function"',
      'typeof Object.getPrototypeOf(Function("return this")()).postMessage === "function"',
      'typeof (function(){}).constructor("return this")().fetch === "function"',
      'typeof Object.getPrototypeOf(Object.getPrototypeOf(Function("return this")())).fetch === "function"',
    ];

    for (const vector of vectors) {
      expect(await probe(page, vector), `reachable: ${vector}`).not.toBe(1);
    }
  });

  test("a script cannot read the RPC surface", async ({ page }) => {
    await page.goto("/");
    // The end-to-end version of the above: attempt the actual exfiltration.
    const reached = await probe(
      page,
      '(function(){ const g = Function("return this")();' +
        ' const f = (Object.getPrototypeOf(g) || {}).fetch || g.fetch;' +
        ' if (typeof f !== "function") return false;' +
        ' f.call(g, "/rpc", {method:"POST"}); return true; })()',
    );
    expect(reached).not.toBe(1);
  });

  test("recovers after a script exceeds its time budget", async ({ page }) => {
    await page.goto("/");

    // restart() built a replacement worker without re-attaching onmessage, so
    // it was mute: one timeout killed scripting for the rest of the session
    // and leaked a worker every couple of seconds thereafter.
    const outcome = await page.evaluate(async () => {
      const module = await import("/src/lib/scriptSandbox.ts");
      const sandbox = module.createScriptSandbox();
      const entity = () =>
        module.toSandboxEntity("e1", "Probe", ["s1"], {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        });
      const step = (code: string) =>
        sandbox.step({ delta: 0.016, time: 0, entities: [entity()], scripts: [{ id: "s1", name: "p", code }] });

      try {
        const before = await step("function update(e){ e.position.x = 5; }");
        const hung = await step("function update(){ while (true) {} }");
        const after = await step("function update(e){ e.position.x = 7; }");
        return {
          before: before.patches[0]?.position.x ?? null,
          hungTerminated: hung.logs.join(" ").includes("exceeded"),
          after: after.patches[0]?.position.x ?? null,
        };
      } finally {
        sandbox.dispose();
      }
    });

    expect(outcome.before).toBe(5);
    expect(outcome.hungTerminated).toBe(true);
    expect(outcome.after, "scripting must survive a timeout").toBe(7);
  });
});

test.describe("test sandbox isolation", () => {
  test("network capability is unreachable from a scripted test", async ({ page }) => {
    await page.goto("/");

    const leaks = await page.evaluate(async () => {
      const module = await import("/src/lib/testSandbox.ts");
      const sandbox = module.createTestSandbox();
      const seen: string[] = [];
      const host = {
        snapshot: () => ({}),
        assert: () => undefined,
        log: (message: string) => seen.push(message),
        step: async () => undefined,
        baseline: async () => ({ pass: true, distance: 0, threshold: 8 }),
      };
      const script = `
        const g = Function("return this")();
        const proto = Object.getPrototypeOf(g) || {};
        const reachable = ["fetch","XMLHttpRequest","WebSocket","postMessage"]
          .filter((n) => typeof g[n] === "function" || typeof proto[n] === "function");
        log("reachable:" + reachable.join(","));
      `;
      try {
        await sandbox.run("t1", script, { slug: "s", entities: [] }, host, 5000);
      } finally {
        sandbox.dispose();
      }
      return seen.join("|");
    });

    expect(leaks).toContain("reachable:");
    expect(leaks, "no network global may be reachable").toBe("reachable:");
  });
});
