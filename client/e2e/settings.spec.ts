import { expect, test, type Page } from "@playwright/test";

const SETTINGS_PAGE = "[data-settings-page]";

async function callRpc(page: Page, method: string, params: Record<string, unknown>): Promise<unknown> {
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

async function openSettings(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Studio menu" })).toBeVisible();
  await page.getByRole("button", { name: "Studio menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.locator(SETTINGS_PAGE)).toBeVisible();
}

test.describe("settings page", () => {
  test("opens as a page, exposes all sections, and restores the workspace", async ({ page }) => {
    await openSettings(page);

    await expect(page.locator(SETTINGS_PAGE)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("main", { name: "General" })).toBeVisible();
    // Not a fixed count: sections get added, and the loop below already
    // proves each one this test cares about exists and selects.
    await expect(page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab")).not.toHaveCount(0);
    await expect(page.getByText("Current game").locator("..")).toContainText("starter");
    await expect(page.getByText("No in-app updater is available")).toBeVisible();
    await expect(page.getByText(/delivered with the desktop release/)).toBeVisible();

    for (const section of ["Providers", "Skills", "MCP", "Archive", "Theme", "General"]) {
      await page.getByRole("tab", { name: section }).click();
      await expect(page.getByRole("tabpanel")).toHaveAttribute("id", `settings-panel-${section.toLowerCase()}`);
      await expect(page.getByRole("tab", { name: section })).toHaveAttribute("aria-selected", "true");
    }

    await page.getByRole("tab", { name: "Providers" }).click();
    const apiKey = page.getByLabel("API key (optional)");
    await expect(apiKey).toHaveAttribute("type", "password");
    await expect(apiKey).toHaveAttribute("autocomplete", "off");
    await expect(page.getByText(/OAuth and account-login flows are not wired|managed by Codex Router outside CaliCode/)).toBeVisible();

    await page.getByRole("button", { name: "Back to workspace" }).click();
    await expect(page.locator(SETTINGS_PAGE)).toHaveCount(0);
    await expect(page.getByLabel("Agent prompt")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Workspace" })).toBeVisible();
  });

  test("does not retain provider secrets in the page or local storage", async ({ page }) => {
    let submittedParams: Record<string, unknown> | null = null;
    await page.route("**/rpc", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.postData()) {
        await route.continue();
        return;
      }
      const body = request.postDataJSON() as {
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };
      if (body.method !== "model_provider_upsert") {
        await route.continue();
        return;
      }
      submittedParams = body.params ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            active: { provider: "anthropic", model: "claude-fable-5", baseUrl: "https://api.anthropic.com" },
            providers: [],
            apiKeyEnv: "CALI_MY_ROUTER_API_KEY",
            keyApplied: true,
          },
        }),
      });
    });

    await openSettings(page);
    await page.getByRole("tab", { name: "Providers" }).click();
    const secret = "e2e-provider-secret";
    await page.getByLabel("Provider id").fill("my-router");
    await page.getByLabel("Label (optional)").fill("My Router");
    await page.getByLabel(/Model id/).fill("router-model");
    await page.getByLabel("Base URL").fill("https://api.example.com/v1");
    await page.getByLabel("API key (optional)").fill(secret);
    await page.getByRole("button", { name: "Save provider" }).click();

    await expect(page.getByRole("status")).toContainText("Saved for this session");
    await expect(page.getByLabel("API key (optional)")).toHaveValue("");
    await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
    await expect(page.locator(SETTINGS_PAGE)).not.toContainText(secret);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(secret);
    expect(submittedParams).toMatchObject({
      id: "my-router",
      label: "My Router",
      baseUrl: "https://api.example.com/v1",
      apiKey: secret,
      models: ["router-model"],
    });
  });

  test("switches themes, renders distinct light/dark captures, and closes with Escape", async ({ page }) => {
    await openSettings(page);
    await page.getByRole("tab", { name: "Theme" }).click();

    const themeGroup = page.getByRole("group", { name: "Theme" });
    const light = themeGroup.getByRole("button", { name: /Light/ });
    const dark = themeGroup.getByRole("button", { name: /Dark/ });
    if ((await dark.getAttribute("aria-pressed")) !== "true") {
      await dark.click();
    }
    await expect(dark).toHaveAttribute("aria-pressed", "true");
    await light.click();
    await expect(light).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("calicode-theme"))).toBe("light");
    const lightCapture = await page.locator(SETTINGS_PAGE).screenshot();
    await test.info().attach("settings-light.png", { body: lightCapture, contentType: "image/png" });

    await dark.click();
    await expect(dark).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("calicode-theme"))).toBe("dark");
    const darkCapture = await page.locator(SETTINGS_PAGE).screenshot();
    await test.info().attach("settings-dark.png", { body: darkCapture, contentType: "image/png" });
    expect(lightCapture.byteLength).toBeGreaterThan(1_000);
    expect(darkCapture.byteLength).toBeGreaterThan(1_000);
    expect(Buffer.compare(lightCapture, darkCapture)).not.toBe(0);

    await page.keyboard.press("Escape");
    await expect(page.locator(SETTINGS_PAGE)).toHaveCount(0);
    await expect(page.getByLabel("Agent prompt")).toBeVisible();
  });

  /**
   * The sidebar can only archive; Settings is the only way back — and the only
   * way to really delete. If either half breaks, an archived chat is stranded.
   */
  test("archives a chat from the sidebar and restores it from the archive", async ({ page }) => {
    const sessionId = `e2e-archive-${Date.now()}`;
    const sessionTitle = `Archive round trip ${Date.now()}`;
    await page.goto("/");
    await callRpc(page, "session_save", {
      id: sessionId,
      title: sessionTitle,
      projectSlug: "starter",
      messages: [{ role: "user", content: "Archive me." }],
    });

    try {
      await page.reload();
      const row = page.getByRole("button", { name: new RegExp(`^${sessionTitle}`) });
      await expect(row).toBeVisible();

      // The hover action on the row, not the menu: this is the gesture that
      // replaced deleting.
      await row.hover();
      const archive = page.getByRole("button", { name: `Archive ${sessionTitle}` });
      await expect(archive).toHaveCSS("opacity", "1");
      await archive.click();
      await expect(row).toHaveCount(0);

      await page.getByRole("button", { name: "Studio menu" }).click();
      await page.getByRole("menuitem", { name: "Settings" }).click();
      await page.getByRole("tab", { name: "Archive" }).click();
      const entry = page.locator("[data-archive-list]").getByText(sessionTitle);
      await expect(entry).toBeVisible();

      await page.getByRole("button", { name: `Restore ${sessionTitle}` }).click();
      await expect(entry).toHaveCount(0);

      await page.getByRole("button", { name: "Back to workspace" }).click();
      await expect(row).toBeVisible();
    } finally {
      await callRpc(page, "session_delete", { id: sessionId }).catch(() => undefined);
    }
  });

  test.describe("mobile", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("keeps all settings navigation reachable without horizontal overflow", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Toggle games sidebar" }).click();
      await page.getByRole("button", { name: "Studio menu" }).click();
      await page.getByRole("menuitem", { name: "Settings" }).click();

      const settings = page.locator(SETTINGS_PAGE);
      await expect(settings).toBeVisible();
      await expect(settings.getByRole("tab", { name: "General" })).toBeVisible();
      await expect(settings.getByRole("tab", { name: "Providers" })).toBeVisible();
      await expect(settings.getByRole("tab", { name: "Skills" })).toBeVisible();
      await expect(settings.getByRole("tab", { name: "MCP" })).toBeVisible();
      await expect(settings.getByRole("tab", { name: "Archive" })).toBeVisible();
      await expect(settings.getByRole("tab", { name: "Theme" })).toBeVisible();

      const metrics = await settings.evaluate((element) => ({
        width: element.scrollWidth,
        viewport: window.innerWidth,
        sidebarWidth: (element.querySelector("aside") as HTMLElement | null)?.getBoundingClientRect().width ?? 0,
      }));
      expect(metrics.width).toBeLessThanOrEqual(metrics.viewport);
      expect(metrics.sidebarWidth).toBeLessThanOrEqual(168);
    });
  });
});
