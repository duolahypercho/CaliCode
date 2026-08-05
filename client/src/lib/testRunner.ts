import type { GameTest, Project, TestResult } from "./types";
import type { PieRuntime } from "./pie";

export interface TestRunContext {
  scene: Project;
  entityFor: (name: string) => { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } } | null;
  assert: (condition: boolean, message?: string) => void;
  log: (message: string) => void;
  step: (frames: number) => Promise<void>;
}

export async function runTests(
  project: Project,
  runtime: PieRuntime,
  tests: GameTest[],
  onLog: (message: string) => void,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const test of tests) {
    const logs: string[] = [];
    const context: TestRunContext = {
      scene: project,
      entityFor: (name) => {
        const object = runtime.getObject(name);
        if (!object) return null;
        return {
          position: { x: object.position.x, y: object.position.y, z: object.position.z },
          rotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z },
        };
      },
      assert: (condition, message = "assertion failed") => {
        if (!condition) throw new Error(message);
        logs.push(`assert passed: ${message}`);
      },
      log: (message) => logs.push(message),
      step: (frames) => runtime.waitFrames(frames),
    };
    try {
      const body = [
        "const scene = context.scene;",
        "const entityFor = context.entityFor;",
        "const assert = context.assert;",
        "const log = context.log;",
        "const step = context.step;",
        test.script,
      ].join("\n");
      // eslint-disable-next-line no-new-func
      const run = new Function("context", `return (async () => { ${body} })();`) as (context: TestRunContext) => Promise<void>;
      await run(context);
      results.push({ id: test.id, name: test.name, pass: true, logs });
    } catch (error) {
      results.push({
        id: test.id,
        name: test.name,
        pass: false,
        logs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const log of logs) onLog(log);
  }
  return results;
}

