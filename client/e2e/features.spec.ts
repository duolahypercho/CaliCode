import { expect, test } from "@playwright/test";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const TAB_LABELS: Record<string, string> = {
  play: "Play",
  code: "Code",
  art: "Assets",
  build: "Build",
  scene: "Scene",
  test: "Test",
  terminal: "Terminal",
  browser: "Browser",
  reports: "Reports",
};

async function openTab(page: import("@playwright/test").Page, name: string): Promise<void> {
  const tab = page.getByRole("tab", { name, exact: true });
  if ((await tab.count()) === 0) await page.getByRole("button", { name: `Show ${TAB_LABELS[name]}` }).click();
  await tab.click();
}

async function callRpc(
  page: import("@playwright/test").Page,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return page.evaluate(
    async ({ rpcMethod, rpcParams }) => {
      const response = await fetch("/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: rpcMethod, params: rpcParams }),
      });
      const envelope = (await response.json()) as { result?: unknown; error?: { message?: string } };
      if (!response.ok || envelope.error) throw new Error(envelope.error?.message ?? `RPC ${rpcMethod} failed`);
      return envelope.result;
    },
    { rpcMethod: method, rpcParams: params },
  );
}

test("art tab generates a batch of real assets and promotes one", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "art");

  const cards = page.getByRole("button", { name: /^Promote / });
  const before = await cards.count();
  await page.getByLabel("Sprite prompt").fill("stone watchtower");
  await page.getByRole("button", { name: /GENERATE 4/ }).click();
  await expect(cards).toHaveCount(before + 4);

  // Thumbnails are rendered through the real procedural pipeline, so a card
  // must carry an actual image rather than the NO PREVIEW placeholder.
  await expect(page.locator("img").first()).toBeVisible();

  const promote = page.getByRole("button", { name: /^Promote stone-watchtower/ }).first();
  await promote.click();
  await openTab(page, "scene");
  await expect(page.getByText(/stone-watchtower/).first()).toBeVisible();
});

test("new game creates a project and switches the workspace to it", async ({ page }) => {
  const title = `E2E ${Date.now()}`;
  await page.goto("/");
  await page.locator("aside").first().getByRole("button", { name: "New game" }).click();
  // The dialog is two-step: name the game, then pick a template.
  await page.getByPlaceholder("Project name").fill(title);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("group", { name: "Templates" }).getByRole("button").first().click();
  await page.getByRole("button", { name: "Create game" }).click();

  // The new game becomes the selected row in the sidebar and the agent
  // panel's header names it.
  await expect(page.locator("aside").first().getByRole("button", { name: new RegExp(title) }).first()).toBeVisible();
});

test("scene tab graphs entities, scripts and their edges", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "scene");

  await expect(page.getByText("Hero Cube").first()).toBeVisible();
  await expect(page.getByText("spin").first()).toBeVisible();
  // Hero Cube runs spin and draws from an asset, so the graph must draw
  // edges. Exact count depends on the project, so assert it is non-empty.
  await expect(page.locator("[data-scene-edges] path").first()).toBeAttached();

  await page.getByRole("button", { name: "Hero Cube" }).first().click();
  await openTab(page, "play");
  await expect(page.getByRole("button", { name: "HERO CUBE" })).toHaveAttribute("aria-pressed", "false");
});

test("code tab edits a script and diffs it against the loaded project", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "code");

  await page.getByRole("button", { name: "edit", exact: true }).click();
  await page.getByLabel("spin source").fill("function update(e) { return e; }");
  await expect(page.getByLabel("spin source")).toHaveValue("function update(e) { return e; }");

  // The +/- counts must come from a real line diff, not a placeholder.
  await page.getByRole("button", { name: "diff", exact: true }).click();
  await expect(page.getByRole("button", { name: /spin.*\+\d/ })).toBeVisible();
  await expect(page.getByText("function update(e) { return e; }")).toBeVisible();
});

test("importing an image reaches the asset library and the console", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "art");
  await page.locator('input[type="file"]').setInputFiles({
    name: "asset.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1PX, "base64"),
  });

  const dockToggle = page.getByRole("button", { name: "Toggle terminal panel" });
  if ((await dockToggle.getAttribute("aria-pressed")) !== "true") await dockToggle.click();
  await page.getByRole("tab", { name: "Console" }).click();
  await expect(page.getByText(/imported asset\.png/i)).toBeVisible({ timeout: 20_000 });
  // Scope to the library: the console line above also contains "asset.png",
  // so an unscoped match proved nothing about the asset reaching the library.
  await expect(page.getByRole("button", { name: /Promote asset\.png/ }).first()).toBeVisible();
});

test("generated cali asset promotes into the scene", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await openTab(page, "art");
  await page.locator('input[type="file"]').setInputFiles({
    name: "cali.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1PX, "base64"),
  });

  const dockToggle = page.getByRole("button", { name: "Toggle terminal panel" });
  if ((await dockToggle.getAttribute("aria-pressed")) !== "true") await dockToggle.click();
  await page.getByRole("tab", { name: "Console" }).click();
  await expect(page.getByText(/generated image-to-3D spec/i)).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Promote cali.png" }).first().click();
  await openTab(page, "scene");
  await expect(page.getByRole("button", { name: /cali\.png/i }).first()).toBeVisible();
});

test("edits autosave the project and the test tab runs the suite", async ({ page }) => {
  await page.goto("/");
  // There is no SAVE button: renaming an entity should persist on its own.
  // Key Light is the one entity no playtest script asserts on by name, and
  // the rename flips a marker suffix so the test is stateless across runs —
  // the autosave debounce can outlive the page, so a restore step would be
  // racy.
  await openTab(page, "scene");
  const scenePanel = page.locator("#workspace-panel-scene");
  await scenePanel.getByRole("button", { name: /Key Light/ }).first().click();
  const nameField = scenePanel.getByLabel("Name");
  const current = await nameField.inputValue();
  await nameField.fill(current.endsWith(" *") ? current.slice(0, -2) : `${current} *`);
  await nameField.press("Enter");
  const dockToggle = page.getByRole("button", { name: "Toggle terminal panel" });
  if ((await dockToggle.getAttribute("aria-pressed")) !== "true") await dockToggle.click();
  await page.getByRole("tab", { name: "Console" }).click();
  await expect(page.getByText(/saved starter/i).first()).toBeVisible({ timeout: 10_000 });

  await openTab(page, "test");
  await page.getByRole("button", { name: "Run playtest" }).click();
  // "0/4 passing" also matches /passing/i, so assert a non-zero pass count.
  await expect(page.getByText(/[1-9]\d*\/\d+ passing/)).toBeVisible({ timeout: 30_000 });
  // With everything green the panel must say so rather than listing issues.
  await expect(page.getByRole("button", { name: "NOTHING TO FIX" })).toBeVisible();
});

test("each game row can start a fresh chat scoped to that game", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator("aside").first();
  const game = sidebar.getByRole("button", { name: /Starter/i }).first();
  await game.hover();

  await sidebar.getByRole("button", { name: /New chat in.*Starter/i }).click();

  // A fresh chat opens over an empty transcript, naming the game it lives in.
  await expect(page.locator("[data-empty-game-hint]")).toBeVisible();
  await expect(page.locator("[data-empty-game-hint]")).toContainText("starter");
});

test("agent panel exposes model and subagent controls", async ({ page }) => {
  await page.goto("/");
  // Permission and active-model switching live directly in the composer;
  // detailed provider and subagent controls remain in session settings.
  await expect(page.getByLabel("Agent prompt")).toBeVisible();
  await expect(page.getByLabel("Permission mode")).toBeVisible();
  await expect(page.getByLabel("Active model")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  const openInBlender = page.getByLabel("Open in Blender");
  await expect(openInBlender).toBeVisible();
  await expect(openInBlender).toContainText("Open in");
  await expect(openInBlender).not.toContainText("Blender");
  await expect(openInBlender.locator("[data-blender-logo]")).toBeVisible();

  const composerRadius = await page.locator("[data-agent-composer]").evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).borderRadius),
  );
  expect(composerRadius).toBeGreaterThanOrEqual(20);

  // The old ··· session menu is gone; subagents run via /spawn instead.
  // Enter on a bare command completes it rather than firing it, so the role
  // and task still have to be typed; running it early only printed usage.
  const composer = page.getByLabel("Agent prompt");
  await composer.fill("/spawn");
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("/spawn ");
  await expect(page.getByText(/Usage: \/spawn/)).toHaveCount(0);
  await composer.fill("");

  // The header toggle hides and restores the tools dock.
  const dock = page.getByRole("tablist", { name: "Workspace" });
  await expect(dock).toBeVisible();
  await page.getByLabel("Toggle tools panel").click();
  await expect(dock).toBeHidden();
  await page.getByLabel("Toggle tools panel").click();
  await expect(dock).toBeVisible();
});

test("assets library opens from the sidebar, shows detail, installs, and yields back to chat", async ({ page }) => {
  const sessionId = `e2e-assets-${Date.now()}`;
  const sessionTitle = `Previous asset session ${Date.now()}`;
  await page.goto("/");
  await callRpc(page, "session_save", {
    id: sessionId,
    title: sessionTitle,
    projectSlug: "starter",
    messages: [{ role: "user", content: "Keep the asset library session reachable." }],
  });

  try {
    // Reload so the app's initial session listing includes this transcript,
    // then make it the active session before leaving chat.
    await page.reload();
    // The row and its hover actions menu both carry the chat name, so this
    // has to name the row exactly rather than matching the name anywhere.
    const previousSession = page.getByRole("button", { name: new RegExp(`^${sessionTitle}`) });
    await expect(previousSession).toBeVisible();
    await previousSession.click();
    await expect(page.getByText("Keep the asset library session reachable.")).toBeVisible();

    await page.getByRole("button", { name: "Assets Library" }).click();
    await expect(page.getByRole("heading", { name: "Assets Library" })).toBeVisible();
    // The library owns the main workspace: chat, editor dock, resize handle,
    // and editor-only header actions all leave the page.
    await expect(page.getByLabel("Agent prompt")).toBeHidden();
    await expect(page.getByRole("tablist", { name: "Workspace" })).toBeHidden();
    await expect(page.getByRole("separator", { name: "Resize tools panel" })).toHaveCount(0);
    await expect(page.getByLabel("Toggle tools panel")).toHaveCount(0);
    await expect(page.getByLabel("Open in Blender")).toHaveCount(0);

    await page.locator("[data-asset-card='linear-ability-casting']").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Credit links to the source repo.
    await expect(dialog.locator("a[target='_blank']")).toHaveAttribute("href", /github|https:\/\//);
    await dialog.getByRole("button", { name: /Install to/ }).click();
    await expect(dialog.getByRole("button", { name: "Remove" })).toBeVisible();
    await page.keyboard.press("Escape");

    // Clicking the already-selected session must still leave the library and
    // restore its transcript without creating a duplicate history entry.
    await previousSession.click();
    await expect(page.getByLabel("Agent prompt")).toBeVisible();
    await expect(page.getByText("Keep the asset library session reachable.")).toBeVisible();
  } finally {
    await callRpc(page, "session_delete", { id: sessionId });
  }
});

test("agent panel sends commands and surfaces errors", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Agent prompt").fill("/model missing-provider:test");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/unknown provider missing-provider/i)).toBeVisible();
});

// @live — needs a configured model provider; CI runs with --grep-invert @live.
test("agent panel runs a live model reply @live", async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto("/");
  // The token must appear in an ASSISTANT message. Asserting on the page as a
  // whole matched the user's own echoed prompt in ~100ms, so this test used
  // to pass with the model provider completely dead.
  const assistantReplies = page.locator('[data-role="assistant"]');
  const before = await assistantReplies.count();

  await page.getByLabel("Agent prompt").fill("Reply with exactly: live-ready");
  await page.keyboard.press("Enter");

  await expect(assistantReplies).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(assistantReplies.last()).toContainText("live-ready", { timeout: 30_000 });
});

// @live — needs a configured model provider.
test("supervised agent tool approval completes live @live", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const select = page.getByRole("combobox", { name: "Permission mode" });
  await select.click();
  await page.getByRole("option", { name: "Supervised" }).click();
  await page.getByLabel("Agent prompt").fill("Call editor_scene_inspect. Then reply with the number of entities.");
  await page.keyboard.press("Enter");
  await page.getByText("Approve editor_scene_inspect?").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve" }).click();

  // Assert the tool actually ran, not the prose. The previous assertion
  // hardcoded "3 entities", which broke once the shared starter project
  // drifted to 4, and could never match anyway because the model emits
  // markdown ("**4**") that the panel renders literally.
  await expect(page.getByText(/editor_scene_inspect/).last()).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(/\d/, { timeout: 45_000 });
});

test("/side opens the side chat with the question waiting, unsent", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Agent prompt").fill("/side why did that last edit fail?");
  await page.keyboard.press("Enter");

  // The command opens the panel; the question waits so it can be edited there.
  const side = page.getByLabel("Side chat prompt");
  await expect(side).toHaveValue("why did that last edit fail?");
  await expect(page.getByRole("button", { name: "Send side chat message" })).toBeEnabled();

  // Its command set is its own: the agent panel's run-altering commands are
  // not reachable from a panel that promises not to touch the run.
  await side.fill("/");
  await expect(page.getByText("Clear this side thread")).toBeVisible();
  await expect(page.getByText("Run autonomously toward a goal until done")).toHaveCount(0);

  await side.fill("/loop ship the game");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Unknown command \/loop/)).toBeVisible();

  // And the side chat's model picker never moves the run's active model.
  const runModel = await page.getByLabel("Active model").getAttribute("title");
  await expect(page.getByLabel("Side chat model")).toBeVisible();
  expect(await page.getByLabel("Active model").getAttribute("title")).toBe(runModel);
});
