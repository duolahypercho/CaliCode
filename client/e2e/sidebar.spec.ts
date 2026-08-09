import { expect, test } from "@playwright/test";

/**
 * Games sidebar: desktop toggle, drag/keyboard resize, min/max 180/420,
 * reset 240, width persistence, and mobile drawer + backdrop.
 *
 * These tests are aria/role-driven and avoid layout-dependent selectors so
 * they survive style and markup changes that do not alter the interactive
 * contract of the component.
 *
 * Widths are verified through the ResizeHandle's `aria-valuenow` because the
 * sidebar stores its width in a CSS custom property on the `<aside>`, which
 * Playwright can still read via `evaluate()`, but the handle's ARIA value is
 * the single source of truth that stays in sync during drags.
 */

const SIDEBAR_TOGGLE = { name: "Toggle games sidebar" };
const RESIZE_HANDLE = { name: "Resize games sidebar" };
const CLOSE_OVERLAY = { name: "Close panel" };

/** Wait for the sidebar handle to settle at a given width (± tolerance for sub-pixel). */
async function expectWidth(
  page: import("@playwright/test").Page,
  expected: number,
  tolerance = 1,
) {
  const handle = page.getByRole("separator", RESIZE_HANDLE);
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute("aria-valuenow", String(expected), {
    timeout: 2_000,
  });
  // Sanity: ARIA matches actual style width. Normalize because getProperty
  // returns a string.
  const actual = await page.evaluate(() => {
    const el = document.querySelector("aside");
    if (!el) return null;
    return parseFloat(getComputedStyle(el).width);
  });
  if (actual !== null) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
  }
}

test.describe("games sidebar", () => {
  // --- Desktop (>= md) ---

  test.describe("desktop", () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test("toggle hides and shows the sidebar", async ({ page }) => {
      await page.goto("/");

      const handle = page.getByRole("separator", RESIZE_HANDLE);
      await expect(handle).toBeVisible();

      // Hide
      await page.getByRole("button", SIDEBAR_TOGGLE).click();
      await expect(handle).toBeHidden();

      // Show
      await page.getByRole("button", SIDEBAR_TOGGLE).click();
      await expect(handle).toBeVisible();
    });

    test("sidebar starts at the default width of 240", async ({ page }) => {
      await page.goto("/");
      await expectWidth(page, 240);
    });

    test("project actions appear on hover and open from left or right click", async ({ page }) => {
      await page.goto("/");

      const sidebar = page.getByRole("complementary", { name: "Games sidebar" });
      const project = sidebar.getByRole("button", { name: /Starter/ }).first();
      const actions = sidebar.getByRole("button", { name: /Open actions for Starter/ });

      await expect(actions).toHaveCSS("opacity", "0");
      await project.hover();
      await expect(actions).toHaveCSS("opacity", "1");
      await actions.click();

      const menu = page.getByRole("menu");
      await expect(menu.getByRole("menuitem", { name: "Pin project" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Reveal in Finder" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Create permanent worktree" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Edit project" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Archive chats" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Remove" })).toBeVisible();

      await page.keyboard.press("Escape");
      await project.click({ button: "right" });
      await expect(menu.getByRole("menuitem", { name: "Pin project" })).toBeVisible();
    });

    test("dragging the handle changes the sidebar width", async ({ page }) => {
      await page.goto("/");
      const handle = page.getByRole("separator", RESIZE_HANDLE);
      const box = await handle.boundingBox();
      if (!box) throw new Error("handle not found");

      // Drag right by 60px
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();

      await expectWidth(page, 300);
    });

    test("drag clamps to min width 180", async ({ page }) => {
      await page.goto("/");
      const handle = page.getByRole("separator", RESIZE_HANDLE);
      const box = await handle.boundingBox();
      if (!box) throw new Error("handle not found");

      // Drag left far past the min
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();

      await expectWidth(page, 180);
    });

    test("drag clamps to max width 420", async ({ page }) => {
      await page.goto("/");
      const handle = page.getByRole("separator", RESIZE_HANDLE);
      const box = await handle.boundingBox();
      if (!box) throw new Error("handle not found");

      // Drag right far past the max
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 500, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();

      await expectWidth(page, 420);
    });

    test("keyboard ArrowRight increases width by step", async ({ page }) => {
      await page.goto("/");
      const handle = page.getByRole("separator", RESIZE_HANDLE);
      await handle.focus();
      await expectWidth(page, 240);

      await handle.press("ArrowRight");
      // Default step is 16px
      await expectWidth(page, 256);
    });

    test("keyboard ArrowLeft decreases width by step", async ({ page }) => {
      await page.goto("/");
      const handle = page.getByRole("separator", RESIZE_HANDLE);

      // Drag to 300 first so we have room to go left
      const box = await handle.boundingBox();
      if (!box) throw new Error("handle not found");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      await expectWidth(page, 300);

      await handle.focus();
      await handle.press("ArrowLeft");
      await expectWidth(page, 284);
    });

    test("keyboard left arrow clamps to min 180", async ({ page }) => {
      await page.goto("/");
      const handle = page.getByRole("separator", RESIZE_HANDLE);
      await handle.focus();

      // Press left many times — should clamp, not crash
      for (let i = 0; i < 20; i++) {
        await handle.press("ArrowLeft");
      }
      await expectWidth(page, 180);
    });

    test("keyboard right arrow clamps to max 420", async ({ page }) => {
      await page.goto("/");
      const handle = page.getByRole("separator", RESIZE_HANDLE);
      await handle.focus();

      for (let i = 0; i < 40; i++) {
        await handle.press("ArrowRight");
      }
      await expectWidth(page, 420);
    });

    test("double-click resets width to 240", async ({ page }) => {
      await page.goto("/");
      const handle = page.getByRole("separator", RESIZE_HANDLE);

      // First move away from 240
      const box = await handle.boundingBox();
      if (!box) throw new Error("handle not found");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      await expectWidth(page, 320);

      // Double-click handle
      await handle.dblclick();
      await expectWidth(page, 240);
    });

    test("width persists across reloads", async ({ page }) => {
      await page.goto("/");
      const handle = page.getByRole("separator", RESIZE_HANDLE);

      // Drag to 320
      const box = await handle.boundingBox();
      if (!box) throw new Error("handle not found");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      await expectWidth(page, 320);

      // Reload
      await page.reload();
      await expectWidth(page, 320);
    });

    test("handle is focusable and shows focus ring", async ({ page }) => {
      await page.goto("/");
      const handle = page.getByRole("separator", RESIZE_HANDLE);
      await handle.focus();
      await expect(handle).toBeFocused();
      // The handle has focus-visible:ring-1 in its class list
      await expect(handle).toHaveClass(/focus-visible/);
    });

    test("sidebar is hidden when toggle hides and resize handle is absent", async ({ page }) => {
      await page.goto("/");
      // Hide
      await page.getByRole("button", SIDEBAR_TOGGLE).click();
      // The sidebar should be hidden at md+
      const sidebar = page.locator("aside").first();
      await expect(sidebar).toBeHidden();

      // The ResizeHandle should also be hidden
      await expect(page.getByRole("separator", RESIZE_HANDLE)).toBeHidden();
    });
  });

  // --- Mobile (< md) ---

  test.describe("mobile drawer", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("toggle opens and closes the sidebar drawer", async ({ page }) => {
      await page.goto("/");

      // Sidebar starts hidden on mobile
      const sidebar = page.locator("aside").first();
      await expect(sidebar).toBeHidden();

      // Open drawer
      await page.getByRole("button", SIDEBAR_TOGGLE).click();
      await expect(sidebar).toBeVisible();

      // The sidebar in overlay mode uses "fixed" positioning
      const position = await sidebar.evaluate((el) => getComputedStyle(el).position);
      expect(position).toBe("fixed");

      // Close via the backdrop
      await page.getByRole("button", CLOSE_OVERLAY).click({ position: { x: 360, y: 400 } });
      await expect(sidebar).toBeHidden();
    });

    test("drawer backdrop closes the sidebar", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", SIDEBAR_TOGGLE).click();

      const sidebar = page.locator("aside").first();
      await expect(sidebar).toBeVisible();

      // Click outside the drawer so its pointer area is reachable.
      await page.getByRole("button", CLOSE_OVERLAY).click({ position: { x: 360, y: 400 } });
      await expect(sidebar).toBeHidden();
    });

    test("drawer sidebar is interactive: search and NEW GAME are reachable", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", SIDEBAR_TOGGLE).click();

      // Two "NEW GAME" buttons exist (sidebar + main toolbar). Scope to the sidebar.
      await expect(page.locator("aside").first().getByRole("button", { name: "NEW GAME" })).toBeVisible();
      await expect(page.getByLabel("Search games")).toBeVisible();

      // Type in the search box
      await page.getByLabel("Search games").fill("starter");
      await expect(page.getByLabel("Search games")).toHaveValue("starter");
    });

    test("no resize handle on mobile", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", SIDEBAR_TOGGLE).click();

      // The ResizeHandle has className "hidden md:block" — it is not visible
      // below the md breakpoint.
      await expect(page.getByRole("separator", RESIZE_HANDLE)).toBeHidden();
    });

    test("toggle button in title bar is reachable on mobile", async ({ page }) => {
      await page.goto("/");
      const toggle = page.getByRole("button", SIDEBAR_TOGGLE);
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-label", "Toggle games sidebar");
    });
  });
});
