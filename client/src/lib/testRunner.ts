import type { GameTest, Project, TestResult } from "./types";
import type { PieRuntime } from "./pie";
import { createTestSandbox, type TestHost } from "./testSandbox";

export const DEFAULT_TEST_TIMEOUT_MS = 15_000;

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
  const sandbox = createTestSandbox();
  // The scene the test can see: names only. Handing over the project document
  // would put asset payloads and script source inside the sandbox for no
  // reason.
  const scene = {
    slug: project.slug,
    entities: project.entities.map((entity) => ({ id: entity.id, name: entity.name, kind: entity.kind })),
  };

  try {
    for (const test of tests) {
      const logs: string[] = [];
      // Records the worst distance any baseline() call in this test reported,
      // instead of the previous `baseline === baselineCompare` check, which
      // compared a freshly-created arrow against the raw callback and was
      // therefore always false — baselineDistance was permanently undefined.
      let worstDistance: number | undefined;

      const host: TestHost = {
        snapshot: () =>
          Object.fromEntries(
            project.entities.flatMap((entity) => {
              const object = runtime.getObject(entity.name);
              return object
                ? [[
                    entity.name,
                    {
                      position: { x: object.position.x, y: object.position.y, z: object.position.z },
                      rotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z },
                    },
                  ] as const]
                : [];
            }),
          ),
        assert: (condition, message) => {
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
        await sandbox.run(test.id, test.script, scene, host, timeoutMs);
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
  } finally {
    sandbox.dispose();
  }
  return results;
}
