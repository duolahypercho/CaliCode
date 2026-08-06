import type { GameTest, Project, TestResult } from "./types";
import type { PieRuntime } from "./pie";

export const DEFAULT_TEST_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface TestRunContext {
  scene: Project;
  entityFor: (name: string) => { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } } | null;
  assert: (condition: boolean, message?: string) => void;
  log: (message: string) => void;
  step: (frames: number) => Promise<void>;
  baseline: (name: string, dataUrl: string, threshold?: number) => Promise<{ pass: boolean; distance: number; threshold: number }>;
}

export async function runTests(
  project: Project,
  runtime: PieRuntime,
  tests: GameTest[],
  onLog: (message: string) => void,
  baselineCompare?: (name: string, dataUrl: string, threshold?: number) => Promise<{ pass: boolean; distance: number; threshold: number }>,
  timeoutMs = DEFAULT_TEST_TIMEOUT_MS,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const test of tests) {
    const logs: string[] = [];
    // Records the worst distance any baseline() call in this test reported,
    // instead of the previous `baseline === baselineCompare` check, which
    // compared a freshly-created arrow against the raw callback and was
    // therefore always false — baselineDistance was permanently undefined.
    let worstDistance: number | undefined;
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
      baseline: async (name, dataUrl, threshold = 8) => {
        const result = baselineCompare
          ? await baselineCompare(name, dataUrl, threshold)
          : { pass: true, distance: 0, threshold };
        worstDistance = Math.max(worstDistance ?? 0, result.distance);
        return result;
      },
    };
    try {
      const body = [
        "const baseline = context.baseline;",
        "const scene = context.scene;",
        "const entityFor = context.entityFor;",
        "const assert = context.assert;",
        "const log = context.log;",
        "const step = context.step;",
        test.script,
      ].join("\n");
      // eslint-disable-next-line no-new-func
      const run = new Function("context", `return (async () => { ${body} })();`) as (context: TestRunContext) => Promise<void>;
      // A test that awaits step() while PIE is paused, or that loops, would
      // otherwise hang the whole suite with no way to recover.
      await withTimeout(run(context), timeoutMs, `test timed out after ${timeoutMs}ms`);
      results.push({ id: test.id, name: test.name, pass: true, logs, baselineDistance: worstDistance });
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
