import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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

async function createLoopProject(page: Page, suffix: string) {
  const slug = `loop-gate-${suffix}`;
  const title = `Loop gate ${suffix}`;
  await callRpc(page, "project_create", { slug, title, template: "blank" });
  await callRpc(page, "project_set_workspace", { slug, workspaceRoot: REPO_ROOT });
  await page.reload();
  const project = page
    .locator("aside")
    .first()
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(title)}$`) })
    .first();
  await expect(project).toBeVisible({ timeout: 10_000 });
  await project.click();
  return { slug, title };
}

test.describe("loop completion gate", () => {
  test("persists synthetic goal and iteration messages across reload and resume", async ({ page }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now().toString(36)}`;
    const { slug, title } = await (async () => {
      await page.goto("/");
      return createLoopProject(page, suffix);
    })();
    let sessionId: string | null = null;

    try {
      const created = (await callRpc(page, "session_create", { projectSlug: slug })) as { id?: string; workspaceRoot?: string };
      sessionId = String(created.id ?? "");
      if (!sessionId) throw new Error("session_create did not return an id");
      const loopId = `loop-${suffix}`;
      const messages = [
        {
          role: "user",
          content: `polish the game ${suffix}\n\nThis is /loop ${loopId}, iteration 1. Keep the goal in context.`,
        },
        { role: "assistant", content: "Keep working." },
        {
          role: "user",
          content: `Continue /loop ${loopId}, iteration 2, toward the goal. Continue from the latest evidence.`,
        },
      ];

      await callRpc(page, "session_save", {
        id: sessionId,
        title: `Saved loop ${suffix}`,
        projectSlug: slug,
        workspaceRoot: created.workspaceRoot ?? REPO_ROOT,
        messages,
      });
      const loaded = (await callRpc(page, "session_load", { id: sessionId })) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      expect(loaded.messages?.filter((message) => message.role === "user")).toHaveLength(2);
      expect(loaded.messages?.some((message) => message.content?.includes(`iteration 2`))).toBe(true);

      await page.reload();
      const sidebar = page.locator("aside").first();
      const project = sidebar
        .getByRole("button", { name: new RegExp(`^${escapeRegExp(title)}$`) })
        .first();
      await expect(project).toBeVisible({ timeout: 10_000 });
      await project.click();
      const saved = sidebar
        .getByRole("button", { name: new RegExp(`^Saved loop ${escapeRegExp(suffix)}(?:\\s|$)`) })
        .first();
      await expect(saved).toBeVisible({ timeout: 10_000 });
      await saved.click();

      await expect(page.getByText(new RegExp(`This is /loop ${escapeRegExp(loopId)}, iteration 1`))).toBeVisible();
      await expect(page.getByText(new RegExp(`Continue /loop ${escapeRegExp(loopId)}, iteration 2`))).toBeVisible();
    } finally {
      await callRpc(page, "project_delete", { slug }).catch(() => undefined);
    }
  });

  test("visibly ignores bare DONE when no fresh graph proof exists", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now().toString(36)}`;
    let sessionId: string | null = null;
    let agentChatCalls = 0;

    await page.route("**/rpc", async (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = request.postDataJSON() as { id?: string; method?: string; params?: Record<string, unknown> };
      if (body.method === "graph_list") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { graphs: [] } }),
        });
        return;
      }
      if (body.method === "agent_chat") {
        agentChatCalls += 1;
        sessionId = String(body.params?.sessionId ?? "");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { sessionId, reply: "DONE", toolCalls: [] },
          }),
        });
        return;
      }
      await route.fallback();
    });

    const { slug, title } = await (async () => {
      await page.goto("/");
      return createLoopProject(page, suffix);
    })();
    const goal = `bare DONE gate ${suffix}`;

    try {
      const prompt = page.getByRole("textbox", { name: "Agent prompt" });
      await prompt.fill(`/loop ${goal}`);
      await prompt.press("Enter");

      await expect(page.getByText(/DONE ignored:/).first()).toBeVisible({ timeout: 15_000 });
      expect(agentChatCalls).toBeGreaterThan(0);
      if (!sessionId) throw new Error("agent_chat did not carry a session id");

      const loaded = (await callRpc(page, "session_load", { id: sessionId })) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      expect(loaded.messages?.some((message) => message.role === "user" && message.content?.includes("This is /loop"))).toBe(
        true,
      );
      expect(page.getByText(/✔ loop complete/)).toHaveCount(0);

      await page.getByRole("button", { name: "Stop agent loop" }).click();
      await expect(page.getByRole("button", { name: "Stop agent loop" })).toBeHidden({ timeout: 15_000 });

      await page.reload();
      const sidebar = page.locator("aside").first();
      const project = sidebar
        .getByRole("button", { name: new RegExp(`^${escapeRegExp(title)}$`) })
        .first();
      await expect(project).toBeVisible({ timeout: 10_000 });
      await project.click();
      const session = sidebar
        .getByRole("button", { name: new RegExp(`^${escapeRegExp(goal)}`) })
        .first();
      await expect(session).toBeVisible({ timeout: 10_000 });
      await session.click();
      await expect(page.locator('[data-role="user"]').filter({ hasText: /This is \/loop/ }).first()).toBeVisible();
      await expect(page.locator('[data-role="tool"]').filter({ hasText: /DONE ignored:/ }).first()).toBeVisible();
    } finally {
      await callRpc(page, "project_delete", { slug }).catch(() => undefined);
    }
  });
});
