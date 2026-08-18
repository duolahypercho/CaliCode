import { expect, test, type Page } from "@playwright/test";

/**
 * Visual regression baselines for every workspace surface.
 *
 * The suite already asserts behaviour; nothing asserted *appearance*, so a
 * layout regression — a clipped tab strip, a collapsed panel, a contrast
 * change — passed everything. That class of defect has bitten this project
 * more than once.
 *
 * Baselines are per-platform (Playwright suffixes them `-darwin`, `-linux`),
 * because font rasterisation differs. Both sets are committed; the Linux ones
 * are produced by the `visual-baselines` workflow.
 */

/** Regions that legitimately differ between runs and must not fail a diff. */
function unstable(page: Page) {
  return [
    // WebGL output: GPU/driver dependent, and the scene animates.
    page.locator("canvas"),
    // Measured values — fps, frame time, load time — change every run.
    page.locator("[data-live-stats]"),
    // Model name depends on whichever provider is configured.
    page.locator("[data-active-model]"),
    // Other specs in this suite create projects with timestamped names, so
    // the list contents vary run to run. The surrounding layout does not.
    page.locator("[data-games-list]"),
  ];
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  // Let the editor finish its first project load and layout pass.
  await page.waitForTimeout(600);
}

/**
 * Absolute pixel budget, sized to absorb sub-pixel text rendering while still
 * catching a small element appearing, vanishing, or moving. A *ratio* of 0.01
 * was the first attempt and it was useless: at 1440x900 it permits ~13,000
 * differing pixels, and reintroducing the tab-clipping regression changed only
 * ~1,400 — so the broken layout passed.
 */
const MAX_DIFF_PIXELS = 150;

const TABS = ["play", "code", "art", "scene", "test"] as const;
const TAB_PICKER_LABELS: Record<(typeof TABS)[number], string> = {
  play: "Play",
  code: "Code",
  art: "Assets",
  scene: "Scene",
  test: "Test",
};

async function openWorkspaceTab(page: Page, tab: (typeof TABS)[number]): Promise<void> {
  const existing = page.getByRole("tab", { name: tab, exact: true });
  if ((await existing.count()) === 0) {
    await page.getByRole("button", { name: `Show ${TAB_PICKER_LABELS[tab]}` }).click();
  }
  await page.getByRole("tab", { name: tab, exact: true }).click();
}

test.describe("workspace surfaces @visual", () => {
  for (const tab of TABS) {
    test(`${tab} tab`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/");
      await settle(page);
      await openWorkspaceTab(page, tab);
      await settle(page);

      await expect(page).toHaveScreenshot(`tab-${tab}.png`, {
        mask: unstable(page),
        animations: "disabled",
        // Absolute, not a ratio. maxDiffPixelRatio: 0.01 allows ~10,000
        // differing pixels at 1440x900 — a clipped tab is about 1,400, so the
        // whole regression fitted inside the tolerance and the test passed.
        maxDiffPixels: MAX_DIFF_PIXELS,
        fullPage: false,
      });
    });
  }
});

test.describe("responsive layout @visual", () => {
  const SIZES = [
    { name: "desktop-1440", width: 1440, height: 900 },
    { name: "laptop-1280", width: 1280, height: 800 },
    { name: "tablet-768", width: 768, height: 1024 },
  ];

  for (const size of SIZES) {
    test(size.name, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto("/");
      await settle(page);

      await expect(page).toHaveScreenshot(`layout-${size.name}.png`, {
        mask: unstable(page),
        animations: "disabled",
        maxDiffPixels: MAX_DIFF_PIXELS,
      });
    });
  }
});

test.describe("console drawer @visual", () => {
  test("expanded", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await settle(page);
    const dockToggle = page.getByRole("button", { name: "Toggle terminal panel" });
    if ((await dockToggle.getAttribute("aria-pressed")) !== "true") await dockToggle.click();
    await page.getByRole("tab", { name: "Console" }).click();
    await settle(page);

    await expect(page).toHaveScreenshot("console-expanded.png", {
      mask: unstable(page),
      animations: "disabled",
      maxDiffPixels: MAX_DIFF_PIXELS,
    });
  });
});
