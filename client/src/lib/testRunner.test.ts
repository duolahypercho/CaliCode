import { describe, expect, it } from "vitest";
import { starterProject } from "./store";
import { runTests } from "./testRunner";

class FakeRuntime {
  private frame = 0;
  private world = { frame: 0, nested: { score: 7 } };
  getObject(name: string) {
    if (name === "Hero Cube") {
      return {
        position: { x: 0, y: 0.6, z: 0 },
        rotation: { x: 0, y: this.frame * 0.02, z: 0 },
      };
    }
    return null;
  }
  async waitFrames(count: number) {
    this.frame += count;
    this.world.frame = this.frame;
  }
  async getWorldState() {
    return structuredClone(this.world);
  }
}

describe("test runner", () => {
  it("reports passing tests", async () => {
    const project = starterProject();
    const results = await runTests(project, new FakeRuntime() as never, project.tests, () => undefined);
    expect(results.every((result) => result.pass)).toBe(true);
  });

  it("reports failures", async () => {
    const project = starterProject();
    project.tests = [{ id: "bad", name: "Fails", script: "assert(false, 'nope');" }];
    const results = await runTests(project, new FakeRuntime() as never, project.tests, () => undefined);
    expect(results[0].pass).toBe(false);
    expect(results[0].error).toContain("nope");
  });

  it("fails when an async assertion is not awaited", async () => {
    const project = starterProject();
    project.tests = [{
      id: "unawaited-bad",
      name: "Unawaited failure",
      script: "assert(false, 'unawaited failure');",
    }];

    const results = await runTests(project, new FakeRuntime() as never, project.tests, () => undefined);

    expect(results[0]).toMatchObject({ id: "unawaited-bad", pass: false });
    expect(results[0].error).toContain("unawaited failure");
  });

  it("drains capability calls appended by an unawaited continuation", async () => {
    const project = starterProject();
    project.tests = [{
      id: "chained-bad",
      name: "Chained failure",
      script: "step(1).then(() => assert(false, 'chained failure'));",
    }];

    const results = await runTests(project, new FakeRuntime() as never, project.tests, () => undefined);

    expect(results[0]).toMatchObject({ id: "chained-bad", pass: false });
    expect(results[0].error).toContain("chained failure");
  });

  it("runs baseline comparisons in tests", async () => {
    const project = starterProject();
    project.tests = [
      {
        id: "baseline",
        name: "Visual",
        script:
          "const result = await baseline('shot', 'data:image/png;base64,abc', 8); assert(result.pass, 'baseline failed');",
      },
    ];
    const results = await runTests(
      project,
      new FakeRuntime() as never,
      project.tests,
      () => undefined,
      async () => ({ pass: true, distance: 2, threshold: 8 }),
    );
    expect(results[0].pass).toBe(true);
  });

  it("fails a baseline assertion when no comparator was supplied", async () => {
    const project = starterProject();
    project.tests = [
      {
        id: "baseline",
        name: "Visual",
        script:
          "const result = await baseline('shot', 'data:image/png;base64,abc', 8); assert(result.pass, 'baseline failed');",
      },
    ];
    // No comparator: this must not resolve to a synthetic pass, or a suite
    // could certify a scene it never compared.
    const results = await runTests(project, new FakeRuntime() as never, project.tests, () => undefined);
    expect(results[0].pass).toBe(false);
    expect(results[0].error).toContain("baseline comparator");
  });

  it("exposes an immutable state.world snapshot and refreshes it after step", async () => {
    const project = starterProject();
    project.tests = [{
      id: "world",
      name: "Shared world",
      script: [
        "await assert(state.world.frame === 0, 'initial world missing');",
        "let immutable = false;",
        "try { state.world.nested.score = 99; } catch { immutable = true; }",
        "await assert(immutable, 'world snapshot is mutable');",
        "await step(5);",
        "await assert(state.world.frame === 5, 'world did not refresh after step');",
        "await assert(state.world.nested.score === 7, 'test mutation leaked into runtime');",
      ].join("\n"),
    }];

    const results = await runTests(project, new FakeRuntime() as never, project.tests, () => undefined);
    expect(results).toMatchObject([{ id: "world", pass: true }]);
  });
});
