import { expect, test } from "@playwright/test";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const openTab = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("tab", { name, exact: true }).click();

test("art tab generates an asset and promotes it into the scene", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "art");
  await page.getByRole("button", { name: /Add to library/i }).click();
  await expect(page.getByText("Box Asset").first()).toBeVisible();

  await page.getByRole("button", { name: "Promote Box Asset" }).first().click();
  await openTab(page, "scene");
  await expect(page.getByRole("button", { name: /Box Asset/i }).first()).toBeVisible();
});

test("new game creates a project and switches the workspace to it", async ({ page }) => {
  const title = `E2E ${Date.now()}`;
  await page.goto("/");
  await page.locator("main").getByRole("button", { name: "NEW GAME" }).click();
  await page.getByLabel("Name").fill(title);
  await page.getByRole("button", { name: "Create & open" }).click();

  await expect(page.locator("header").getByText(title, { exact: false })).toBeVisible();
});

test("scene tab renames an entity through the inspector", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "scene");
  await page.getByText("Hero Cube").click();
  await page.getByLabel("Name").fill("Renamed Hero");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("Renamed Hero").first()).toBeVisible();
});

test("code tab edits and saves a script", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "code");
  await page.getByLabel("spin source").fill("function update(e) { return e; }");
  await page.getByRole("button", { name: "Save script" }).click();
  await expect(page.getByLabel("spin source")).toHaveValue("function update(e) { return e; }");
});

test("importing an image reaches the asset library and the console", async ({ page }) => {
  await page.goto("/");
  await openTab(page, "art");
  await page.getByRole("tab", { name: "Import" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "asset.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1PX, "base64"),
  });

  await page.getByRole("button", { name: /CONSOLE/ }).click();
  await expect(page.getByText(/imported asset\.png/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("asset.png").first()).toBeVisible();
});

test("generated cali asset promotes into the scene", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await openTab(page, "art");
  await page.getByRole("tab", { name: "Import" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "cali.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1PX, "base64"),
  });

  await page.getByRole("button", { name: /CONSOLE/ }).click();
  await expect(page.getByText(/generated image-to-3D spec/i)).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Promote cali.png" }).first().click();
  await openTab(page, "scene");
  await expect(page.getByRole("button", { name: /cali\.png/i }).first()).toBeVisible();
});

test("export saves the project and the test tab runs the suite", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "EXPORT" }).click();
  await page.getByRole("button", { name: /CONSOLE/ }).click();
  await expect(page.getByText(/saved starter/i)).toBeVisible();

  await openTab(page, "test");
  await page.getByRole("button", { name: "Run playtest" }).click();
  await expect(page.getByText(/passing/i)).toBeVisible({ timeout: 30_000 });
});

test("games sidebar nests agent sessions under each game", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator("aside").first();
  await sidebar.getByRole("button", { name: /Starter/i }).first().click();
  await sidebar.getByRole("button", { name: "+ new session" }).click();
  await expect(sidebar.getByRole("button", { name: /Session 1/ })).toBeVisible();
});

test("agent panel shows the active model", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("CaliCode Agent")).toBeVisible();
  await expect(page.getByLabel("Model provider")).toBeVisible();
  await expect(page.getByLabel("Target model")).toBeVisible();
  await expect(page.getByLabel("Switch model")).toBeVisible();
  await expect(page.getByLabel("Spawn subagent")).toBeVisible();
});

test("agent panel sends commands and surfaces errors", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Agent prompt").fill("/model missing-provider:test");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/unknown provider missing-provider/i)).toBeVisible();
});

test("agent panel runs a live model reply", async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto("/");
  await page.getByLabel("Agent prompt").fill("Reply with exactly: live-ready");
  await page.keyboard.press("Enter");
  await expect(page.getByText("live-ready")).toBeVisible({ timeout: 30_000 });
});

test("supervised agent tool approval completes live", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const select = page.getByRole("combobox", { name: "Permission mode" });
  await select.click();
  await page.getByRole("option", { name: "Supervised" }).click();
  await page.getByLabel("Agent prompt").fill("Call editor_scene_inspect. Then reply with the number of entities.");
  await page.keyboard.press("Enter");
  await page.getByText("Approve editor_scene_inspect?").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/3 entities/i)).toBeVisible({ timeout: 45_000 });
});
