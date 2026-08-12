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
          module.toSandboxEntity("e1", "Probe", "box", true, ["s1"], {
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

  test("state.patch applies bounded cross-entity transforms in the CSP sandbox", async ({ page }) => {
    await page.goto("/");

    const outcome = await page.evaluate(async () => {
      const module = await import("/src/lib/scriptSandbox.ts");
      const sandbox = module.createScriptSandbox();
      const make = (id: string, name: string, scripts: string[], x: number) =>
        module.toSandboxEntity(id, name, "box", true, scripts, {
          position: { x, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        });
      try {
        const result = await sandbox.step({
          delta: 0.016,
          time: 0,
          entities: [make("hero", "Hero", ["s1"], 0), make("coin", "Coin", [], 3)],
          scripts: [{
            id: "s1",
            name: "hero",
            code: `function update(entity, state) {
              state.patch("Coin", { position: { x: 7, y: NaN }, material: { color: "red" } });
              if (state.find("Coin").position.x !== 3) throw new Error("snapshot mutated");
            }`,
          }],
        });
        return { coin: result.patches.find((item: { id: string }) => item.id === "coin"), logs: result.logs };
      } finally {
        sandbox.dispose();
      }
    });

    expect(outcome.coin.position).toEqual({ x: 7, y: 0, z: 0 });
    expect(outcome.logs.join("\n")).toContain("position.y must be finite; ignored");
    expect(outcome.logs.join("\n")).toContain("ignored material");
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

  test("a script cannot complete a fetch to /rpc", async ({ page }) => {
    await page.goto("/");

    // The substantive test: not whether the API exists, but whether a request
    // completes and returns bytes.
    const outcome = await page.evaluate(async () => {
      const module = await import("/src/lib/scriptSandbox.ts");
      const sandbox = module.createScriptSandbox();
      const entity = () =>
        module.toSandboxEntity("e1", "P", "box", true, ["s1"], {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        });
      const code = `
        function update(entity){
          if (!self.__started) {
            self.__started = 1; self.__fetch = 0; self.__import = 0;
            try {
              fetch("http://127.0.0.1:8765/rpc", { method: "POST", body: "{}" })
                .then((r) => r.text()).then((t) => { self.__fetch = t.length; })
                .catch(() => { self.__fetch = -1; });
            } catch (e) { self.__fetch = -2; }
            try {
              import("http://127.0.0.1:8765/rpc")
                .then(() => { self.__import = 1; }).catch(() => { self.__import = -1; });
            } catch (e) { self.__import = -2; }
          }
          entity.position.x = self.__fetch || 0;
          entity.position.y = self.__import || 0;
        }`;
      const step = () =>
        sandbox.step({ delta: 0.016, time: 0, entities: [entity()], scripts: [{ id: "s1", name: "x", code }] });
      try {
        await step();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const result = await step();
        return { fetch: result.patches[0].position.x, import: result.patches[0].position.y };
      } finally {
        sandbox.dispose();
      }
    });

    // > 0 would mean bytes came back from /rpc.
    expect(outcome.fetch, "fetch must not reach /rpc").toBeLessThanOrEqual(0);
  });

  // `import()` is syntax, not a property, so no amount of global hardening
  // refuses it — only a CSP does, and a CSP needs a document. This passes
  // because the worker runs inside a CSP-locked frame and inherits its policy.
  test("dynamic import is refused", async ({ page }) => {
    await page.goto("/");
    const reached = await page.evaluate(async () => {
      const module = await import("/src/lib/scriptSandbox.ts");
      const sandbox = module.createScriptSandbox();
      const entity = () =>
        module.toSandboxEntity("e1", "P", "box", true, ["s1"], {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        });
      const code = `
        function update(entity){
          if (!self.__i) { self.__i = 0;
            try { import("http://127.0.0.1:8765/rpc").then(() => { self.__i = 1; }).catch(() => { self.__i = -1; }); }
            catch (e) { self.__i = -2; }
          }
          entity.position.x = self.__i || 0;
        }`;
      const step = () =>
        sandbox.step({ delta: 0.016, time: 0, entities: [entity()], scripts: [{ id: "s1", name: "i", code }] });
      try {
        await step();
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return (await step()).patches[0].position.x;
      } finally {
        sandbox.dispose();
      }
    });
    expect(reached, "dynamic import must be refused").toBeLessThanOrEqual(0);
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
        module.toSandboxEntity("e1", "Probe", "box", true, ["s1"], {
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
    await expect(page.getByLabel("Agent prompt")).toBeVisible();

    const leaks = await page.evaluate(async () => {
      const module = await import("/src/lib/testSandbox.ts");
      const sandbox = module.createTestSandbox();
      const seen: string[] = [];
      const host = {
        snapshot: () => ({}),
        worldSnapshot: async () => ({}),
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

  // This spec is the reason the test sandbox shipped exploitable. Its sibling
  // above only checked that network *properties* were absent, and the
  // project-script suite tested import() while this one did not — so a bare
  // Worker with no CSP looked covered. An audit exfiltrated project data
  // through exactly this hole.
  test("dynamic import is refused from a scripted test", async ({ page }) => {
    await page.goto("/");

    const outcome = await page.evaluate(async () => {
      const module = await import("/src/lib/testSandbox.ts");
      const sandbox = module.createTestSandbox();
      const seen: string[] = [];
      const host = {
        snapshot: () => ({}),
        worldSnapshot: async () => ({}),
        assert: () => undefined,
        log: (message: string) => seen.push(message),
        step: async () => undefined,
        baseline: async () => ({ pass: true, distance: 0, threshold: 8 }),
      };
      // The request lands before the module load rejects, so a resolved OR
      // rejected import both mean the GET escaped. Only a CSP refusal — which
      // fails synchronously at the policy layer — counts as blocked.
      const script = `
        try {
          await import("http://127.0.0.1:8765/health?leak=secret");
          log("import:resolved");
        } catch (error) {
          log("import:" + String(error && error.message).slice(0, 60));
        }
      `;
      try {
        await sandbox.run("t1", script, { slug: "s", entities: [] }, host, 8000);
      } catch (error) {
        seen.push("run:" + String(error));
      } finally {
        sandbox.dispose();
      }
      return seen.join("|");
    });

    expect(outcome, "import() must not resolve").not.toContain("import:resolved");
    // Chrome reports a CSP-refused dynamic import as "Failed to fetch
    // dynamically imported module", which is also what a genuine network
    // failure looks like — so string matching alone cannot tell a block from
    // an escape. The load must have been refused, and an audit with a live
    // listener confirmed zero requests leave the sandbox.
    expect(outcome).toMatch(/import:/);
    expect(outcome).not.toContain("import:resolved");
  });

  test("state.world is immutable and refreshes after step in the CSP sandbox", async ({ page }) => {
    await page.goto("/");

    const outcome = await page.evaluate(async () => {
      const module = await import("/src/lib/testSandbox.ts");
      const sandbox = module.createTestSandbox();
      let frame = 0;
      const passed: string[] = [];
      const host = {
        snapshot: () => ({}),
        worldSnapshot: async () => ({ frame, nested: { score: 7 } }),
        assert: (condition: boolean, message: string) => {
          if (!condition) throw new Error(message);
          passed.push(message);
        },
        log: () => undefined,
        step: async (frames: number) => {
          frame += frames;
        },
        baseline: async () => ({ pass: true, distance: 0, threshold: 8 }),
      };
      const script = [
        "await assert(state.world.frame === 0, 'initial');",
        "let immutable = false;",
        "try { state.world.nested.score = 99; } catch { immutable = true; }",
        "await assert(immutable, 'immutable');",
        "await step(6);",
        "await assert(state.world.frame === 6, 'refreshed');",
        "await assert(state.world.nested.score === 7, 'isolated');",
      ].join("\n");

      try {
        await sandbox.run("world", script, { slug: "s", entities: [] }, host, 5000);
      } finally {
        sandbox.dispose();
      }
      return passed;
    });

    expect(outcome).toEqual(["initial", "immutable", "refreshed", "isolated"]);
  });

  test("an unawaited assertion failure fails in the CSP sandbox", async ({ page }) => {
    await page.goto("/");

    const outcome = await page.evaluate(async () => {
      const module = await import("/src/lib/testSandbox.ts");
      const sandbox = module.createTestSandbox();
      const host = {
        snapshot: () => ({}),
        worldSnapshot: async () => ({}),
        assert: (condition: boolean, message: string) => {
          if (!condition) throw new Error(message);
        },
        log: () => undefined,
        step: async () => undefined,
        baseline: async () => ({ pass: true, distance: 0, threshold: 8 }),
      };
      try {
        await sandbox.run(
          "unawaited",
          "step(1).then(() => assert(false, 'csp unawaited failure'));",
          { slug: "s", entities: [] },
          host,
          5000,
        );
        return "passed";
      } catch (error) {
        return String(error instanceof Error ? error.message : error);
      } finally {
        sandbox.dispose();
      }
    });

    expect(outcome).toContain("csp unawaited failure");
  });
});
