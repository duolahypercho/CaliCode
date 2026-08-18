import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ACTIVITY_VIEWPORT = { width: 1440, height: 900 };

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

test.describe("persisted agent activity", () => {
  test.use({ viewport: ACTIVITY_VIEWPORT });

  test("resumes one completed turn, expands its actions, and opens the edited file", async ({ page }, testInfo) => {
    test.setTimeout(45_000);

    const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now().toString(36)}`;
    const projectSlug = `activity-${suffix}`;
    const projectTitle = `Activity ${suffix}`;
    const sessionTitle = `Persisted activity ${suffix}`;
    const turnId = `activity-turn-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
    const now = Date.now();
    const startedAtMs = now - 4_500;
    const completedAtMs = now - 500;
    let sessionId: string | null = null;

    try {
      await page.goto("/");

      // A private game keeps this workspace binding from changing Starter
      // underneath the parallel PLAY and scene specs.
      await callRpc(page, "project_create", {
        slug: projectSlug,
        title: projectTitle,
        template: "blank",
      });
      await callRpc(page, "project_set_workspace", {
        slug: projectSlug,
        workspaceRoot: REPO_ROOT,
      });
      const created = (await callRpc(page, "session_create", { projectSlug })) as {
        id?: string;
        workspaceRoot?: string | null;
        worktreeId?: string | null;
        branch?: string | null;
      };
      sessionId = String(created.id ?? "");
      const workspaceRoot = created.workspaceRoot;
      if (!sessionId || !workspaceRoot) throw new Error("session_create did not return a workspace root");

      const messages = [
        {
          role: "tool",
          tool: "turn",
          content: "",
          status: "done",
          turnId,
          startedAtMs,
          completedAtMs,
        },
        {
          role: "tool",
          tool: "file_read",
          content: "Read README.md",
          status: "done",
          toolCallId: "read-readme",
          turnId,
          startedAtMs: startedAtMs + 200,
          completedAtMs: startedAtMs + 900,
          activity: {
            path: "README.md",
            workspaceRoot,
            projectSlug,
            operation: "read",
            additions: 0,
            deletions: 0,
            diff: [],
            turnId,
            toolCallId: "read-readme",
          },
        },
        {
          role: "tool",
          tool: "file_edit",
          content: "Edited README.md +1 -1",
          status: "done",
          toolCallId: "edit-readme",
          turnId,
          startedAtMs: startedAtMs + 1_100,
          completedAtMs: completedAtMs,
          activity: {
            path: "README.md",
            workspaceRoot,
            projectSlug,
            operation: "edit",
            additions: 1,
            deletions: 1,
            diff: [
              { type: "removed", oldLine: 1, newLine: null, text: "before" },
              { type: "added", oldLine: null, newLine: 1, text: "after" },
            ],
            turnId,
            toolCallId: "edit-readme",
          },
        },
      ];

      await callRpc(page, "session_save", {
        id: sessionId,
        title: sessionTitle,
        projectSlug,
        provider: null,
        model: null,
        workspaceRoot,
        worktreeId: created.worktreeId ?? null,
        branch: created.branch ?? null,
        messages,
      });
      const loaded = (await callRpc(page, "session_load", { id: sessionId })) as {
        messages?: Array<{ turnId?: string; tool?: string }>;
        workspaceRoot?: string | null;
      };
      expect(loaded.workspaceRoot).toBe(workspaceRoot);
      expect(loaded.messages?.filter((message) => message.turnId === turnId)).toHaveLength(3);
      expect(loaded.messages?.filter((message) => message.tool === "turn")).toHaveLength(1);

      await page.reload();
      const sidebar = page.locator("aside").first();
      const projectButton = sidebar.getByRole("button", { name: new RegExp(`^${escapeRegExp(projectTitle)}$`) }).first();
      await expect(projectButton).toBeVisible({ timeout: 10_000 });
      if ((await projectButton.getAttribute("aria-expanded")) !== "true") await projectButton.click();

      const savedSession = sidebar
        .getByRole("button", { name: new RegExp(`^${escapeRegExp(sessionTitle)}(?:\\s|$)`) })
        .first();
      await expect(savedSession).toBeVisible({ timeout: 10_000 });
      await savedSession.click();

      const activity = page.locator(`[data-role="activity-turn"][data-turn-id="${turnId}"]`);
      await expect(activity).toHaveCount(1, { timeout: 10_000 });
      const compact = activity.getByRole("button", { name: `Expand activity for turn ${turnId}` });
      await expect(compact).toHaveCount(1);
      await expect(compact).toContainText("Worked for 4s");
      await expect(compact).not.toContainText("actions");
      await expect(compact).not.toContainText("Edited README.md +1 -1");
      await expect(compact).not.toContainText("Read README.md");
      await expect(page.locator("[data-session-worked-time]")).toContainText(/Worked [1-9]\d*s this session/);

      await compact.click();
      await expect(activity.getByText("Read README.md", { exact: true })).toBeVisible();
      await expect(activity.getByText("Edited README.md +1 -1", { exact: true }).last()).toBeVisible();
      // Each action holds its own output until that row is clicked.
      await expect(activity.getByRole("button", { name: "Open README.md" })).toHaveCount(0);
      await activity.getByRole("button", { name: /Read README\.md/ }).click();
      await activity.getByRole("button", { name: /Edited README\.md/ }).click();
      await expect(activity.getByRole("button", { name: "Open README.md" })).toHaveCount(2);
      // The expanded action already carries its totals in the summary. Do
      // not repeat a second detached stat label; the compact file summary is
      // the only separate aggregate and is hidden while details are open.
      await expect(activity.getByText("+1 -1", { exact: true })).toHaveCount(0);
      await expect(activity.locator("[data-activity-change-summary]")).toHaveCount(0);

      await activity.getByRole("button", { name: "Open README.md" }).last().click();
      await expect(page.getByRole("tab", { name: "code", exact: true })).toHaveAttribute("aria-selected", "true");
      const fileView = page.getByRole("group", { name: "File view" });
      await expect(fileView).toBeVisible({ timeout: 10_000 });
      await expect(fileView.getByRole("button", { name: "Show diff" })).toBeVisible();
      await expect(fileView.getByRole("button", { name: "Show file" })).toBeVisible();
      await expect(fileView.getByLabel("1 addition, 1 deletion")).toBeVisible();
      await expect(page.getByRole("region", { name: "README.md diff" })).toBeVisible();

      await fileView.getByRole("button", { name: "Show file" }).click();
      await expect(page.getByLabel("README.md source")).toBeVisible();
      await fileView.getByRole("button", { name: "Show diff" }).click();
      await expect(page.getByRole("region", { name: "README.md diff" })).toBeVisible();
    } finally {
      if (sessionId) await callRpc(page, "session_delete", { id: sessionId }).catch(() => undefined);
      await callRpc(page, "project_delete", { slug: projectSlug }).catch(() => undefined);
    }
  });
});
