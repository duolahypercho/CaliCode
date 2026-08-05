import { expect, test } from "@playwright/test";

test("editor loads and renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Cali/i })).toBeVisible();
  await expect(page.getByText("Scene Graph")).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
});

test("PIE captures frames", async ({ page }) => {
  await page.goto("/");
  const play = page.getByRole("button", { name: "Play", exact: true });
  await expect(play).toBeEnabled({ timeout: 10_000 });
  await play.click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled({ timeout: 10_000 });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("tab", { name: "Filmstrip" }).click();
  await expect(page.locator("figure").first()).toBeVisible();
});
