import { expect, test } from "@playwright/test";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("workbench generates, promotes, and library shows usage", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Workbench" }).click();
  await page.getByRole("button", { name: /Add to library/i }).click();
  await page.getByRole("tab", { name: "Assets", exact: true }).first().click();
  await expect(page.locator("aside").getByText("Box Asset").first()).toBeVisible();
  await page.getByRole("button", { name: "Promote Box Asset" }).click();
  await page.getByRole("tab", { name: "Scene", exact: true }).first().click();
  await expect(page.locator("aside").getByRole("button", { name: /Box Asset/i })).toBeVisible();
});

test("creates and opens a new project", async ({ page }) => {
  const title = `E2E ${Date.now()}`;
  await page.goto("/");
  await page.getByLabel("New project").click();
  await page.getByLabel("Name").fill(title);
  await page.getByRole("button", { name: "Create & open" }).click();
  await expect(page.locator("header").getByText(title, { exact: true })).toBeVisible();
  await expect(page.locator("aside").getByText(title, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Caliber/i })).toBeVisible();
});

test("scene graph selects and inspector renames an entity", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Hero Cube").click();
  await page.getByLabel("Name").fill("Renamed Hero");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("Renamed Hero").first()).toBeVisible();
});

test("script editor saves edits", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Scripts" }).click();
  await page.getByLabel("spin source").fill("function update(e) { return e; }");
  await page.getByRole("button", { name: "Save script" }).click();
  await expect(page.getByLabel("spin source")).toHaveValue("function update(e) { return e; }");
});

test("theme toggles between light and dark", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  const initial = await html.getAttribute("class");
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect
    .poll(async () => html.getAttribute("class"))
    .not.toBe(initial);
});

test("image import triggers image-to-3D and lands in the library", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Workbench" }).click();
  await page.getByRole("tab", { name: "Import" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "asset.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1PX, "base64"),
  });
  await page.getByRole("tab", { name: "Console" }).click();
  await expect(page.getByText(/imported asset\.png/i)).toBeVisible();
  await page.getByRole("tab", { name: "Assets", exact: true }).first().click();
  await expect(page.locator("aside").getByText("asset.png").first()).toBeVisible();
});

test("generated cali asset promotes into the scene", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Workbench" }).click();
  await page.getByRole("tab", { name: "Import" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "cali.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1PX, "base64"),
  });
  await page.getByRole("tab", { name: "Console" }).click();
  await expect(page.getByText(/generated image-to-3D spec/i)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: "Assets", exact: true }).first().click();
  await page.getByRole("button", { name: "Promote cali.png" }).first().click();
  await page.getByRole("tab", { name: "Scene", exact: true }).first().click();
  await expect(page.locator("aside").getByRole("button", { name: /cali\.png/i })).toBeVisible();
});

test("save, checkpoint, and tests report in console", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Checkpoint" }).click();
  await page.getByRole("button", { name: "Run tests" }).click();
  await page.getByRole("tab", { name: "Console" }).click();
  await expect(page.getByText(/saved starter/i)).toBeVisible();
  await expect(page.getByText(/checkpoint cp-/i)).toBeVisible();
  await page.getByRole("tab", { name: "Tests" }).click();
  await expect(page.getByText(/2 \/ 2 passed/i)).toBeVisible();
});

test("agent panel shows the active model", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Agent" })).toBeVisible();
  await expect(page.getByText("Caliber Agent")).toBeVisible();
  await expect(page.getByLabel("Model provider")).toBeVisible();
  await expect(page.getByLabel("Target model")).toBeVisible();
  await expect(page.getByLabel("Switch model")).toBeVisible();
  await expect(page.getByLabel("Spawn subagent")).toBeVisible();
});

test("agent panel sends commands and surfaces errors", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Agent" }).click();
  await page.getByLabel("Agent prompt").fill("/model missing-provider:test");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/unknown provider missing-provider/i)).toBeVisible();
});

test("agent panel runs a live model reply", async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto("/");
  await page.getByRole("tab", { name: "Agent" }).click();
  await page.getByLabel("Agent prompt").fill("Reply with exactly: live-ready");
  await page.keyboard.press("Enter");
  await expect(page.getByText("live-ready")).toBeVisible({ timeout: 30_000 });
});

test("supervised agent tool approval completes live", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.getByRole("tab", { name: "Agent" }).click();
  const select = page.getByRole("combobox", { name: "Permission mode" });
  await select.click();
  await page.getByRole("option", { name: "Supervised" }).click();
  await page.getByLabel("Agent prompt").fill(
    "Call editor_scene_inspect. Then reply with the number of entities.",
  );
  await page.keyboard.press("Enter");
  await page.getByText("Approve editor_scene_inspect?").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/3 entities/i)).toBeVisible({ timeout: 45_000 });
});
