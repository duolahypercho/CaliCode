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
  // project_open resolves asynchronously and rekeys <AgentPanel key={slug:revision}>
  // (App.tsx). Anything typed — or any loop started — before that second remount
  // is discarded with the old panel instance.
  await expect(page.locator("[data-empty-game-hint]")).toContainText(slug, { timeout: 10_000 });
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

  // The DONE gate itself moved to core with the driver, and is covered there
  // by `loop_run::tests::an_aaa_loop_refuses_done_it_cannot_prove` — a real
  // run against a scripted provider, rather than this suite stubbing our own
  // `agent_chat` at the browser boundary, which a core-driven loop never
  // sends. What is left for the browser to prove is the contract it still
  // owns: the right run is asked for, and Stop reaches core rather than only
  // this tab.
  test("hands /loop to core and stops it there", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now().toString(36)}`;
    const started: Array<Record<string, unknown>> = [];
    const stopped: Array<Record<string, unknown>> = [];

    await page.route("**/rpc", async (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = request.postDataJSON() as { id?: string; method?: string; params?: Record<string, unknown> };
      if (body.method === "loop_start") {
        started.push(body.params ?? {});
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              loop: {
                loopId: "loop-e2e",
                slug: String(body.params?.projectSlug ?? ""),
                goal: String(body.params?.goal ?? ""),
                profile: String(body.params?.profile ?? "standard"),
                status: "running",
                iteration: 0,
                startedAtMs: Date.now(),
              },
            },
          }),
        });
        return;
      }
      if (body.method === "loop_stop") {
        stopped.push(body.params ?? {});
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { loop: { loopId: "loop-e2e", status: "stopped", iteration: 1 } },
          }),
        });
        return;
      }
      await route.fallback();
    });

    const { slug } = await (async () => {
      await page.goto("/");
      return createLoopProject(page, suffix);
    })();
    const goal = `core-driven loop ${suffix}`;

    try {
      const prompt = page.getByRole("textbox", { name: "Agent prompt" });
      await prompt.fill(`/loop --aaa ${goal}`);
      await prompt.press("Enter");

      await expect(page.getByText(`▶ loop started: ${goal}`)).toBeVisible({ timeout: 15_000 });
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ goal, profile: "aaa", projectSlug: slug });
      // The run carries this panel's session, which is what routes its turns
      // back into this transcript.
      expect(typeof started[0].sessionId).toBe("string");

      await page.getByRole("button", { name: "Stop agent loop" }).click();
      await expect.poll(() => stopped.length, { timeout: 15_000 }).toBe(1);
      expect(stopped[0]).toMatchObject({ loopId: "loop-e2e" });
    } finally {
      await callRpc(page, "project_delete", { slug }).catch(() => undefined);
    }
  });
});
