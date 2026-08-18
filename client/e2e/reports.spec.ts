import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPORTS_VIEWPORT = { width: 1440, height: 900 };
const TWO_HOURS_THIRTY_FIVE_MINUTES_MS = 2 * 60 * 60 * 1_000 + 35 * 60 * 1_000;
const FIRST_ITERATION_DURATION_MS = 80 * 60 * 1_000;
const SECOND_ITERATION_DURATION_MS = TWO_HOURS_THIRTY_FIVE_MINUTES_MS - FIRST_ITERATION_DURATION_MS;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function callRpc(page: Page, method: string, params: Record<string, unknown>): Promise<any> {
  return page.evaluate(
    async ({ rpcMethod, rpcParams }) => {
      const response = await fetch("/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: rpcMethod,
          params: rpcParams,
        }),
      });
      const envelope = (await response.json()) as { result?: unknown; error?: { message?: string } };
      if (!response.ok || envelope.error) {
        throw new Error(envelope.error?.message ?? `RPC ${rpcMethod} failed`);
      }
      return envelope.result;
    },
    { rpcMethod: method, rpcParams: params },
  );
}

function iterationInput({
  startedAtMs,
  completedAtMs,
  summary,
  agents,
  checks,
  changedFiles,
  evidence,
  scores,
  punchList,
  nextIterationMemory,
}: {
  startedAtMs: number;
  completedAtMs: number;
  summary: string;
  agents: Array<Record<string, unknown>>;
  checks: Array<Record<string, unknown>>;
  changedFiles: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  scores: Array<Record<string, unknown>>;
  punchList: Array<Record<string, unknown>>;
  nextIterationMemory: Record<string, string[]>;
}) {
  return {
    startedAtMs,
    completedAtMs,
    outcome: "passed",
    summary,
    agents,
    checks,
    changedFiles,
    evidence,
    scores,
    punchList,
    nextIterationMemory,
  };
}

test.describe("Reports workspace", () => {
  test.use({ viewport: REPORTS_VIEWPORT });

  test("renders a durable completed loop and opens a safe changed file in CODE", async ({ page }, testInfo) => {
    test.setTimeout(60_000);

    const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now().toString(36)}`;
    const projectSlug = `reports-${suffix}`;
    const projectTitle = `Reports ${suffix}`;
    const loopId = `loop-${suffix}`;
    const objective = `Verify durable reports ${suffix}`;
    const now = Date.now();
    const startedAtMs = now - 3 * 60 * 60 * 1_000;
    const firstStartedAtMs = startedAtMs + 60_000;
    const firstCompletedAtMs = firstStartedAtMs + FIRST_ITERATION_DURATION_MS;
    const secondStartedAtMs = firstCompletedAtMs + 10 * 60 * 1_000;
    const secondCompletedAtMs = secondStartedAtMs + SECOND_ITERATION_DURATION_MS;
    let sessionId: string | null = null;

    try {
      await page.goto("/");

      await callRpc(page, "project_create", {
        slug: projectSlug,
        title: projectTitle,
        template: "blank",
      });
      await callRpc(page, "project_set_workspace", {
        slug: projectSlug,
        workspaceRoot: REPO_ROOT,
      });

      const session = (await callRpc(page, "session_create", { projectSlug })) as { id?: string };
      sessionId = session.id ? String(session.id) : null;
      if (!sessionId) throw new Error("session_create did not return an id");

      await callRpc(page, "loop_report_start", {
        slug: projectSlug,
        loopId,
        objective,
        reference: "Reports E2E durable-state reference",
        startedAtMs,
      });
      await callRpc(page, "loop_report_iteration", {
        slug: projectSlug,
        loopId,
        iteration: iterationInput({
          startedAtMs: firstStartedAtMs,
          completedAtMs: firstCompletedAtMs,
          summary: "First pass established the workspace and found one follow-up.",
          agents: [
            {
              role: "builder",
              agentId: "builder-1",
              task: "Set up the report workspace",
              outcome: "passed",
              summary: "Workspace wiring is ready.",
              durationMs: 1_200_000,
            },
            {
              role: "critic",
              agentId: "critic-1",
              task: "Review the first pass",
              outcome: "passed",
              summary: "The report needs one final verification pass.",
              durationMs: 600_000,
            },
          ],
          checks: [
            {
              kind: "build",
              name: "Initial build",
              command: "pnpm build",
              status: "passed",
              durationMs: 30_000,
              details: "Build completed cleanly.",
            },
            {
              kind: "test",
              name: "Initial test",
              command: "pnpm test",
              status: "failed",
              durationMs: 45_000,
              details: "One expected follow-up remained.",
            },
          ],
          changedFiles: [{ path: "README.md", additions: 3, deletions: 1 }],
          evidence: [
            {
              kind: "screenshot",
              path: "evidence/first-pass.png",
              caption: "First-pass workspace capture",
              capturedAtMs: firstCompletedAtMs - 10_000,
            },
          ],
          scores: [
            {
              criterion: "Report completeness",
              score: 78,
              maximum: 100,
              passThreshold: 90,
              rationale: "The first pass still needs final checks.",
            },
          ],
          punchList: [
            {
              priority: "high",
              item: "Run the final report verification",
              source: "critic",
              resolved: false,
            },
          ],
          nextIterationMemory: {
            observations: ["The report survives reload."],
            decisions: ["Keep the workspace bound to the repository root."],
            risks: ["A stale report could hide the newest iteration."],
            nextActions: ["Complete the final verification pass."],
          },
        }),
      });
      await callRpc(page, "loop_report_iteration", {
        slug: projectSlug,
        loopId,
        iteration: iterationInput({
          startedAtMs: secondStartedAtMs,
          completedAtMs: secondCompletedAtMs,
          summary: "Final pass completed the checks and confirmed the durable report.",
          agents: [
            {
              role: "verifier",
              agentId: "verifier-1",
              task: "Verify the completed report",
              outcome: "passed",
              summary: "All report sections are present and ordered.",
              durationMs: 1_500_000,
            },
          ],
          checks: [
            {
              kind: "build",
              name: "Final build",
              command: "pnpm build",
              status: "passed",
              durationMs: 30_000,
              details: "Final build completed cleanly.",
            },
            {
              kind: "test",
              name: "Final test",
              command: "pnpm test",
              status: "passed",
              durationMs: 40_000,
              details: "All targeted tests passed.",
            },
            {
              kind: "play",
              name: "Final play proof",
              command: "editor_run_pie",
              status: "passed",
              durationMs: 8_000,
              details: "PIE completed with persisted visual evidence.",
            },
            {
              // Passed, not skipped: `validate_completion_readiness` requires a
              // passing performance check on the last iteration, because a run
              // that never timed a frame has no evidence for the half of an
              // `aaa` claim a screenshot cannot carry. A skipped one describes a
              // report that can no longer reach `completed`.
              kind: "performance",
              name: "Performance sample",
              command: "game_perf",
              status: "passed",
              durationMs: 12_000,
              details: "60fps average, 52fps one percent low over a 20s sample.",
            },
          ],
          changedFiles: [{ path: "AGENTS.md", additions: 5, deletions: 2 }],
          evidence: [
            {
              kind: "screenshot",
              path: "evidence/final-pass.png",
              caption: "Final report workspace capture",
              capturedAtMs: secondCompletedAtMs - 10_000,
            },
          ],
          scores: [
            {
              criterion: "Report completeness",
              score: 92,
              maximum: 100,
              passThreshold: 90,
              rationale: "The completed report contains every durable section.",
            },
          ],
          punchList: [
            {
              priority: "low",
              item: "Keep the report fixture isolated",
              source: "verifier",
              resolved: true,
            },
          ],
          nextIterationMemory: {
            observations: ["The newest iteration is disclosed by default."],
            decisions: ["Use safe relative paths for file actions."],
            risks: ["Future report fields must remain backward compatible."],
            nextActions: ["Keep this E2E fixture on the normal RPC path."],
          },
        }),
      });
      await callRpc(page, "loop_report_update", {
        slug: projectSlug,
        loopId,
        update: {
          status: "completed",
          completedAtMs: secondCompletedAtMs,
          recordedAtMs: secondCompletedAtMs,
          summary: "The durable report completed after two verification passes.",
          punchList: [
            {
              priority: "medium",
              item: "Keep report evidence paths relative",
              source: "verifier",
              resolved: true,
            },
            {
              priority: "low",
              item: "Retain the newest-iteration disclosure",
              source: "verifier",
              resolved: false,
            },
          ],
          nextIterationMemory: {
            observations: ["Two iterations remain visible after reload."],
            decisions: ["Open safe changed files through CODE."],
            risks: ["A report path must never escape its project."],
            nextActions: ["Preserve the isolated cleanup path."],
          },
        },
      });

      // RPC-created state is not in the already-mounted sidebar list. Reload
      // to exercise the same project-list hydration path users get on reopen.
      await page.reload();
      const sidebar = page.getByRole("complementary", { name: "Games sidebar" });
      const projectButton = sidebar
        .getByRole("button", { name: new RegExp(`^${escapeRegExp(projectTitle)}$`) })
        .first();
      await expect(projectButton).toBeVisible({ timeout: 10_000 });
      await projectButton.click();

      const reportsTab = page.getByRole("tab", { name: "reports", exact: true });
      if ((await reportsTab.count()) === 0) await page.getByRole("button", { name: "Show Reports" }).click();
      await expect(reportsTab).toBeVisible();
      await reportsTab.click();
      await expect(reportsTab).toHaveAttribute("aria-selected", "true");

      const reportsPanel = page.locator("#workspace-panel-reports");
      await expect(reportsPanel.getByText(objective, { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(reportsPanel.getByText("Completed", { exact: true })).toBeVisible();
      await expect(reportsPanel.getByText("The durable report completed after two verification passes.", { exact: true })).toBeVisible();
      await expect(reportsPanel.getByText("Reference: Reports E2E durable-state reference", { exact: true })).toBeVisible();

      const totals = reportsPanel.locator("header dl");
      await expect(totals.getByText("2", { exact: true })).toHaveCount(2);
      await expect(totals.getByText("92%", { exact: true })).toBeVisible();
      // 5 of 6: the final performance check is passed rather than skipped, so
      // `refresh_totals` counts it in checks_passed instead of checks_skipped.
      await expect(totals.getByText("5/6", { exact: true })).toBeVisible();
      await expect(totals.getByText("3", { exact: true })).toHaveCount(1);
      await expect(totals.getByText("2h 35m", { exact: true })).toBeVisible();

      await expect(reportsPanel.getByText("Current handoff", { exact: true })).toBeVisible();
      await expect(reportsPanel.getByText(/Keep report evidence paths relative/)).toBeVisible();
      await expect(reportsPanel.getByText("Two iterations remain visible after reload.", { exact: true })).toBeVisible();
      await expect(reportsPanel.getByText("The newest iteration is disclosed by default.", { exact: true })).toBeVisible();
      await expect(reportsPanel.getByText("Report completeness", { exact: true })).toHaveCount(2);
      await expect(reportsPanel.getByText("Final build", { exact: true })).toBeVisible();
      await expect(reportsPanel.getByText("verifier", { exact: true })).toBeVisible();
      await expect(reportsPanel.getByText("Final report workspace capture", { exact: true })).toBeVisible();

      const iterationTwo = reportsPanel.locator("details").filter({ hasText: "Iteration 2" }).first();
      const iterationOne = reportsPanel.locator("details").filter({ hasText: "Iteration 1" }).first();
      await expect(iterationTwo).toHaveAttribute("open", "");
      await expect(iterationOne).not.toHaveAttribute("open", "");

      await iterationOne.locator("summary").click();
      await expect(iterationOne).toHaveAttribute("open", "");
      await expect(reportsPanel.getByText("Initial test", { exact: true })).toBeVisible();
      await expect(reportsPanel.getByText("builder", { exact: true })).toBeVisible();
      await expect(reportsPanel.getByText("critic", { exact: true })).toBeVisible();
      await expect(reportsPanel.getByText("First-pass workspace capture", { exact: true })).toBeVisible();

      const readmeButton = reportsPanel.getByRole("button", { name: /README\.md/ }).first();
      await expect(readmeButton).toBeEnabled({ timeout: 15_000 });
      await expect(readmeButton.getByText("+3", { exact: true })).toBeVisible();
      await expect(readmeButton.getByText("-1", { exact: true })).toBeVisible();
      await readmeButton.click();

      await expect(page.getByRole("tab", { name: "code", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByLabel("README.md source")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByLabel("README.md source")).toContainText("CaliCode");
    } finally {
      if (sessionId) await callRpc(page, "session_delete", { id: sessionId }).catch(() => undefined);
      // project_delete removes the project-owned durable report bundle through
      // core, so report and project cleanup stay on the RPC path together.
      await callRpc(page, "project_delete", { slug: projectSlug }).catch(() => undefined);
    }
  });
});
