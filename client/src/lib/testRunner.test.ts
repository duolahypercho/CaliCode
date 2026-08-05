import { describe, expect, it } from "vitest";
import { starterProject } from "./store";
import { runTests } from "./testRunner";

class FakeRuntime {
  private frame = 0;
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
});

