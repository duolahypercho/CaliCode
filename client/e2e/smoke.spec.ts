import { expect, test } from "@playwright/test";

test("editor boots with the CaliCode workspace shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /CaliCode/i })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
  for (const name of ["play", "code", "art", "scene", "test"]) {
    await expect(page.getByRole("tab", { name, exact: true })).toBeVisible();
  }
});

test("play transport runs PIE and captures frames", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "play", exact: true }).click();

  await page.getByRole("button", { name: "PLAY", exact: true }).click();
  await expect(page.getByRole("button", { name: "PAUSE", exact: true })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "RESET", exact: true }).click();
  await expect(page.getByRole("button", { name: "PLAY", exact: true })).toBeVisible();
});

test("live bar exposes build, fps, and a console", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("FPS", { exact: false }).first()).toBeVisible();

  const consoleToggle = page.getByRole("button", { name: /CONSOLE/ });
  await expect(consoleToggle).toHaveAttribute("aria-expanded", "false");
  await consoleToggle.click();
  await expect(consoleToggle).toHaveAttribute("aria-expanded", "true");
});

test("tweak pins open a live inspector over the viewport", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "play", exact: true }).click();

  const pin = page.getByRole("button", { name: "RUNTIME", exact: true });
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await pin.click();

  await expect(page.getByLabel("Capture every")).toBeVisible();
  await page.getByRole("button", { name: "Close tweak panel" }).click();
  await expect(page.getByLabel("Capture every")).toBeHidden();
});
