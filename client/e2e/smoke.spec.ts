import { expect, test } from "@playwright/test";

test("editor boots with the CaliCode workspace shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Agent prompt")).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.locator("[data-empty-workspace]")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await page.getByRole("button", { name: "Show Play" }).click();
  await expect(page.getByRole("tab", { name: "play", exact: true })).toBeVisible();
});

test("play transport runs PIE and captures frames", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Show Play" }).click();

  await page.getByRole("button", { name: "PLAY", exact: true }).click();
  await expect(page.getByRole("button", { name: "PAUSE", exact: true })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "RESET", exact: true }).click();
  await expect(page.getByRole("button", { name: "PLAY", exact: true })).toBeVisible();
});

test("live bar exposes build, fps, and a console", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Show Play" }).click();
  await expect(page.getByText("FPS", { exact: false }).first()).toBeVisible();

  // The log lives in the bottom dock now, behind the panel toggle.
  const dockToggle = page.getByRole("button", { name: "Toggle terminal panel" });
  await expect(dockToggle).toHaveAttribute("aria-pressed", "false");
  await dockToggle.click();
  await expect(dockToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("tab", { name: "Console" })).toBeVisible();
});

test("tweak pins open a live inspector over the viewport", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Show Play" }).click();

  const pin = page.getByRole("button", { name: "RUNTIME", exact: true });
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await pin.click();

  await expect(page.getByLabel("Capture every")).toBeVisible();
  await page.getByRole("button", { name: "Close tweak panel" }).click();
  await expect(page.getByLabel("Capture every")).toBeHidden();
});
