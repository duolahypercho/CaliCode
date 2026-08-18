import { expect, test, type APIRequestContext, type Page, type Request, type TestInfo } from "@playwright/test";

const WORKFLOW_VIEWPORT = { width: 1440, height: 900 };

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const slugify = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
const uniqueLabel = (prefix: string, testInfo: TestInfo) =>
  `${prefix} ${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Math.random().toString(36).slice(2, 8)}`;

const openTab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true }).click();

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

async function callRpcFromRunner(
  request: APIRequestContext,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  const response = await request.post("/rpc", {
    data: { jsonrpc: "2.0", id: crypto.randomUUID(), method, params },
  });
  const envelope = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (!response.ok() || envelope.error) {
    throw new Error(envelope.error?.message ?? `RPC ${method} failed`);
  }
  return envelope.result;
}

async function createStarterGame(page: Page, testInfo: TestInfo) {
  const title = uniqueLabel("QA workflow", testInfo);
  const slug = slugify(title);

  await page.goto("/");
  await page.locator("aside").first().getByRole("button", { name: "New game" }).click();
  await page.getByPlaceholder("Project name").fill(title);
  await page.getByRole("button", { name: "Continue" }).click();
  const templates = page.getByRole("group", { name: "Templates" });
  await templates.getByRole("button", { name: /Starter scene/ }).click();
  await page.getByRole("button", { name: "Create game" }).click();

  const row = page
    .locator("aside")
    .first()
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(title)}$`) })
    .first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  return { title, slug };
}

async function reopenGameAfterReload(page: Page, title: string) {
  await page.reload();
  const row = page
    .locator("aside")
    .first()
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(title)}$`) })
    .first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
}

async function expectAutosaved(page: Page, slug: string) {
  // The log moved out of the editor and into the bottom dock's Console tab,
  // which is the dock's first tab and opens with it.
  const dockToggle = page.getByRole("button", { name: "Toggle terminal panel" });
  if ((await dockToggle.getAttribute("aria-pressed")) !== "true") {
    await dockToggle.click();
  }
  await page.getByRole("tab", { name: "Console" }).click();
  await expect(page.getByText(new RegExp(`saved ${escapeRegExp(slug)}`, "i")).last()).toBeVisible({
    timeout: 12_000,
  });
}

async function selectSavedSession(
  page: Page,
  projectTitle: string,
  sessionTitle: string,
  sessionId: string,
  attachRequests: Array<Record<string, any>>,
) {
  await page.reload();
  const sidebar = page.locator("aside").first();
  const projectRow = sidebar
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(projectTitle)}$`) })
    .first();
  await expect(projectRow).toBeVisible({ timeout: 10_000 });
  await projectRow.click();
  const sessionRow = sidebar
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(sessionTitle)}`) })
    .first();
  await expect(sessionRow).toBeVisible({ timeout: 10_000 });
  await sessionRow.click();
  await expect
    .poll(
      () => attachRequests.some((params) => params.sessionId === sessionId),
      { timeout: 10_000 },
    )
    .toBe(true);
}

test.describe("end-to-end game workflow", () => {
  test.use({ viewport: WORKFLOW_VIEWPORT });

  test("persists negative and decimal transforms plus code autosave, then plays and runs tests", async ({ page }, testInfo) => {
    const { title, slug } = await createStarterGame(page, testInfo);
    const updatedCode = "function update(entity, state, delta) {\n  entity.rotation.y -= delta * 1.25;\n  return state;\n}";

    try {
      await openTab(page, "scene");
      const scenePanel = page.locator("#workspace-panel-scene");
      await scenePanel.getByRole("button", { name: "Hero Cube", exact: true }).click();

      // Number inputs must accept values users actually type into an
      // inspector: negative coordinates and decimal precision, not just
      // integer-positive defaults.
      const positionX = scenePanel.getByLabel("Position X", { exact: true });
      const positionY = scenePanel.getByLabel("Position Y", { exact: true });
      const rotationZ = scenePanel.getByLabel("Rotation Z", { exact: true });
      await positionX.fill("-2.75");
      await positionY.fill("1.125");
      await rotationZ.fill("-0.375");
      await expect(positionX).toHaveValue("-2.75");
      await expect(positionY).toHaveValue("1.125");
      await expect(rotationZ).toHaveValue("-0.375");

      await openTab(page, "code");
      await page.getByRole("button", { name: "edit", exact: true }).click();
      const source = page.getByLabel("spin source");
      await source.fill(updatedCode);
      await expect(source).toHaveValue(updatedCode);
      await expectAutosaved(page, slug);

      // A reload must restore the saved project rather than the starter
      // placeholder. Selecting the game row re-opens the project that was
      // created above; the app intentionally boots the default game first.
      await reopenGameAfterReload(page, title);
      await openTab(page, "code");
      await page.getByRole("button", { name: "edit", exact: true }).click();
      await expect(page.getByLabel("spin source")).toHaveValue(updatedCode);

      await openTab(page, "scene");
      const reloadedScene = page.locator("#workspace-panel-scene");
      await reloadedScene.getByRole("button", { name: "Hero Cube", exact: true }).click();
      await expect(reloadedScene.getByLabel("Position X", { exact: true })).toHaveValue("-2.75");
      await expect(reloadedScene.getByLabel("Position Y", { exact: true })).toHaveValue("1.125");
      await expect(reloadedScene.getByLabel("Rotation Z", { exact: true })).toHaveValue("-0.375");

      // Play and reset use the same runtime that the test runner consumes.
      await openTab(page, "play");
      await page.getByRole("button", { name: "PLAY", exact: true }).click();
      await expect(page.getByRole("button", { name: "PAUSE", exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await page.getByRole("button", { name: "RESET", exact: true }).click();
      await expect(page.getByRole("button", { name: "PLAY", exact: true })).toBeVisible();

      await openTab(page, "test");
      const runTests = page.getByRole("button", { name: "Run playtest" });
      await expect(runTests).toBeEnabled({ timeout: 15_000 });
      await runTests.click();
      await expect(page.getByText(/[1-9]\d*\/\d+ passing/)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "NOTHING TO FIX" })).toBeVisible();
    } finally {
      // Keep the isolated project list usable for the rest of the suite even
      // when an assertion aborts halfway through this long workflow.
      await callRpc(page, "project_delete", { slug }).catch(() => undefined);
    }
  });

  test("resuming a fresh chat attaches the editor to that session and game", async ({ page }, testInfo) => {
    const sessionTitle = uniqueLabel("QA attachment", testInfo);
    const attachRequests: Array<Record<string, any>> = [];

    page.on("request", (request) => {
      if (!request.url().endsWith("/rpc") || request.method() !== "POST") return;
      try {
        const body = request.postDataJSON() as { method?: string; params?: Record<string, any> };
        if (body.method === "editor_attach" && body.params) attachRequests.push(body.params);
      } catch {
        // Non-JSON requests are unrelated to RPC attachment routing.
      }
    });

    await page.goto("/");
    let sessionId: string | null = null;

    try {
      const created = await callRpc(page, "session_create", { projectSlug: "starter" });
      sessionId = String(created.id);
      await callRpc(page, "session_save", {
        id: sessionId,
        title: sessionTitle,
        projectSlug: "starter",
        messages: [],
      });

      await page.reload();
      const sidebar = page.locator("aside").first();
      const starter = sidebar.getByRole("button", { name: /^Starter$/ }).first();
      if ((await starter.getAttribute("aria-expanded")) !== "true") await starter.click();

      const sessionRow = sidebar
        .getByRole("button", { name: new RegExp(`^${escapeRegExp(sessionTitle)}`) })
        .first();
      await expect(sessionRow).toBeVisible({ timeout: 10_000 });
      await sessionRow.click();

      await expect(page.locator("[data-empty-game-hint]")).toContainText("starter");
      await expect
        .poll(
          () =>
            attachRequests.some(
              (params) =>
                params.sessionId === sessionId &&
                params.projectSlug === "starter" &&
                typeof params.workspaceRoot === "string" &&
                params.workspaceRoot.length > 0,
            ),
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      if (sessionId) await callRpc(page, "session_delete", { id: sessionId }).catch(() => undefined);
    }
  });

  test("does not carry a task into a newly created game", async ({ page }, testInfo) => {
    const sessionTitle = uniqueLabel("Foreign task", testInfo);
    const gameTitle = uniqueLabel("Fresh game", testInfo);
    const gameSlug = slugify(gameTitle);
    let sessionId: string | null = null;

    try {
      await page.goto("/");
      const created = await callRpc(page, "session_create", { projectSlug: "starter" });
      sessionId = String(created.id);
      await callRpc(page, "session_save", {
        id: sessionId,
        title: sessionTitle,
        projectSlug: "starter",
        messages: [],
      });
      await page.reload();
      const sidebar = page.locator("aside").first();
      const starter = sidebar.getByRole("button", { name: /^Starter$/ }).first();
      if ((await starter.getAttribute("aria-expanded")) !== "true") await starter.click();
      await sidebar
        .getByRole("button", { name: new RegExp(`^${escapeRegExp(sessionTitle)}`) })
        .first()
        .click();
      await expect(page.locator("[data-empty-game-hint]")).toContainText("starter");

      await sidebar.getByRole("button", { name: "New game" }).click();
      await page.getByPlaceholder("Project name").fill(gameTitle);
      await page.getByRole("button", { name: "Continue" }).click();
      await page
        .getByRole("group", { name: "Templates" })
        .getByRole("button", { name: /Starter scene/ })
        .click();
      await page.getByRole("button", { name: "Create game" }).click();

      await expect(page.locator("[data-empty-game-hint]")).toContainText(gameSlug);
      await expect(page.getByText(/Resume failed: session belongs to project/)).toHaveCount(0);
    } finally {
      if (sessionId) await callRpc(page, "session_delete", { id: sessionId }).catch(() => undefined);
      await callRpc(page, "project_delete", { slug: gameSlug }).catch(() => undefined);
    }
  });

  test("keeps a dirty game visible and autosaves it after an RPC transport outage", async ({ page }, testInfo) => {
    const { title, slug } = await createStarterGame(page, testInfo);

    try {
      await openTab(page, "scene");
      const scenePanel = page.locator("#workspace-panel-scene");
      await scenePanel.getByRole("button", { name: "Hero Cube", exact: true }).click();
      const positionX = scenePanel.getByLabel("Position X", { exact: true });

      await page.route("**/rpc", (route) => route.abort("connectionfailed"));
      await positionX.fill("-6.25");
      await positionX.press("Enter");
      await expect(page.getByRole("alert")).toContainText("Your current game remains visible", {
        timeout: 12_000,
      });
      await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
      await expect(positionX).toHaveValue("-6.25");

      await page.unroute("**/rpc");
      const retry = page.getByRole("button", { name: "Retry", exact: true });
      if (await retry.isVisible()) await retry.click();
      await expect(page.locator("[data-core-status='offline']")).toHaveCount(0, { timeout: 10_000 });
      await expectAutosaved(page, slug);

      await reopenGameAfterReload(page, title);
      await openTab(page, "scene");
      const reloadedScene = page.locator("#workspace-panel-scene");
      await reloadedScene.getByRole("button", { name: "Hero Cube", exact: true }).click();
      await expect(reloadedScene.getByLabel("Position X", { exact: true })).toHaveValue("-6.25");
    } finally {
      await page.unroute("**/rpc").catch(() => undefined);
      await callRpc(page, "project_delete", { slug }).catch(() => undefined);
    }
  });

  test("routes concurrent editor calls to the owning page and session", async ({ browser, request }, testInfo) => {
    const context = await browser.newContext({ viewport: WORKFLOW_VIEWPORT });
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Math.random().toString(36).slice(2, 8)}`;
    const projectA = { title: `Route Alpha ${suffix}`, slug: `route-alpha-${suffix}` };
    const projectB = { title: `Route Beta ${suffix}`, slug: `route-beta-${suffix}` };
    const sessionTitleA = `Alpha task ${suffix}`;
    const sessionTitleB = `Beta task ${suffix}`;
    const attachA: Array<Record<string, any>> = [];
    const attachB: Array<Record<string, any>> = [];
    let sessionA: string | null = null;
    let sessionB: string | null = null;

    const captureAttach = (target: Array<Record<string, any>>) => (request: Request) => {
      if (!request.url().endsWith("/rpc") || request.method() !== "POST") return;
      try {
        const body = request.postDataJSON() as { method?: string; params?: Record<string, any> };
        if (body.method === "editor_attach" && body.params) target.push(body.params);
      } catch {
        // Ignore unrelated non-JSON requests.
      }
    };
    // `requestfinished`, not `request`: the poll below gates the first
    // `editor_tool_call` on this list, and a *sent* attach is not an
    // *applied* one. Core registers the owner while handling the call, so
    // firing the tool call on the outgoing request raced the registration —
    // the call arrived with no owner for that session and hung until the
    // 60s test timeout rather than failing with a reason.
    pageA.on("requestfinished", captureAttach(attachA));
    pageB.on("requestfinished", captureAttach(attachB));

    try {
      await pageA.goto("/");
      await pageB.goto("/");
      await callRpc(pageA, "project_create", { ...projectA, template: "starter" });
      await callRpc(pageA, "project_create", { ...projectB, template: "starter" });
      const createdA = await callRpc(pageA, "session_create", { projectSlug: projectA.slug });
      const createdB = await callRpc(pageB, "session_create", { projectSlug: projectB.slug });
      sessionA = String(createdA.id);
      sessionB = String(createdB.id);
      await callRpc(pageA, "session_save", {
        id: sessionA,
        title: sessionTitleA,
        projectSlug: projectA.slug,
        messages: [],
      });
      await callRpc(pageB, "session_save", {
        id: sessionB,
        title: sessionTitleB,
        projectSlug: projectB.slug,
        messages: [],
      });

      await Promise.all([
        selectSavedSession(pageA, projectA.title, sessionTitleA, sessionA, attachA),
        selectSavedSession(pageB, projectB.title, sessionTitleB, sessionB, attachB),
      ]);

      const [snapshotA, snapshotB] = await Promise.all([
        callRpcFromRunner(request, "editor_tool_call", {
          sessionId: sessionA,
          tool: "editor_scene_inspect",
          arguments: {},
        }),
        callRpcFromRunner(request, "editor_tool_call", {
          sessionId: sessionB,
          tool: "editor_scene_inspect",
          arguments: {},
        }),
      ]);
      expect(snapshotA.project.title).toBe(projectA.title);
      expect(snapshotB.project.title).toBe(projectB.title);
    } finally {
      if (sessionA) await callRpc(pageA, "session_delete", { id: sessionA }).catch(() => undefined);
      if (sessionB) await callRpc(pageB, "session_delete", { id: sessionB }).catch(() => undefined);
      await callRpc(pageA, "project_delete", { slug: projectA.slug }).catch(() => undefined);
      await callRpc(pageA, "project_delete", { slug: projectB.slug }).catch(() => undefined);
      await context.close();
    }
  });
});
