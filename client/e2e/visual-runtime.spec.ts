import { expect, test, type Page, type Request, type TestInfo } from "@playwright/test";

const VIEWPORT = { width: 1440, height: 900 };

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const slugify = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";

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

async function selectSession(
  page: Page,
  projectTitle: string,
  sessionTitle: string,
  sessionId: string,
  attachRequests: Array<Record<string, unknown>>,
) {
  await page.reload();
  const sidebar = page.locator("aside").first();
  const project = sidebar
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(projectTitle)}$`) })
    .first();
  await expect(project).toBeVisible({ timeout: 10_000 });
  await project.click();
  const session = sidebar
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(sessionTitle)}`) })
    .first();
  await expect(session).toBeVisible({ timeout: 10_000 });
  await session.click();
  await expect
    .poll(
      () => attachRequests.some((params) => params.sessionId === sessionId),
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function callEditorTool(
  page: Page,
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
) {
  const result = await callRpc(page, "editor_tool_call", {
    sessionId,
    tool,
    arguments: args,
  });
  if (result && typeof result === "object" && "error" in result) {
    throw new Error(String(result.error));
  }
  return result;
}

async function imageStats(page: Page, dataUrl: string) {
  return page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas context is unavailable");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let cyan = 0;
    let magenta = 0;
    let nonDark = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      if (green > red * 1.2 && blue > red * 1.2 && green > 55 && blue > 55) cyan += 1;
      if (red > green * 1.2 && blue > green * 1.2 && red > 55 && blue > 55) magenta += 1;
      if (red + green + blue > 120) nonDark += 1;
    }
    return { width: canvas.width, height: canvas.height, cyan, magenta, nonDark };
  }, dataUrl);
}

test.describe("agent visual runtime", () => {
  test.use({ viewport: VIEWPORT });

  test("synchronously rebuilds and frames rapid editor mutations before PIE evidence", async ({ page }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Math.random().toString(36).slice(2, 8)}`;
    const projectTitle = `Visual runtime ${suffix}`;
    const projectSlug = slugify(projectTitle);
    const sessionTitle = `Visual proof ${suffix}`;
    const attachRequests: Array<Record<string, unknown>> = [];
    let sessionId: string | null = null;

    page.on("request", (request: Request) => {
      if (!request.url().endsWith("/rpc") || request.method() !== "POST") return;
      try {
        const body = request.postDataJSON() as { method?: string; params?: Record<string, unknown> };
        if (body.method === "editor_attach" && body.params) attachRequests.push(body.params);
      } catch {
        // Unrelated requests need no routing assertion.
      }
    });

    try {
      await page.goto("/");
      await callRpc(page, "project_create", { title: projectTitle, slug: projectSlug, template: "starter" });
      const created = await callRpc(page, "session_create", { projectSlug });
      sessionId = String(created.id);
      await callRpc(page, "session_save", {
        id: sessionId,
        title: sessionTitle,
        projectSlug,
        messages: [],
      });
      await selectSession(page, projectTitle, sessionTitle, sessionId, attachRequests);
      const attached = await callEditorTool(page, sessionId, "editor_scene_inspect", {});
      expect(attached.project).toMatchObject({ slug: projectSlug });

      let baseline = "";
      await expect
        .poll(
          async () => {
            const result = await callEditorTool(page, sessionId!, "editor_capture_frame", {});
            baseline = typeof result?.dataUrl === "string" ? result.dataUrl : "";
            return baseline;
          },
          { timeout: 15_000 },
        )
        .toMatch(/^data:image\//);
      const before = await imageStats(page, baseline);
      expect(before.nonDark).toBeGreaterThan(Math.floor(before.width * before.height * 0.01));

      // These bridge calls mirror a provider tool batch: React need not render
      // between mutations and the following PIE/capture request.
      const cyan = await callEditorTool(page, sessionId, "editor_object_add", {
        name: "Cyan Arena Core",
        kind: "box",
        position: [-2.5, 2.5, 0],
        color: "#00ffff",
      });
      await callEditorTool(page, sessionId, "editor_object_update", {
        id: cyan.id,
        scale: [3.5, 5, 3.5],
        material: {
          color: "#00ffff",
          emissive: "#00ffff",
          emissiveIntensity: 2.5,
          metalness: 0,
          roughness: 0.25,
        },
      });
      const magenta = await callEditorTool(page, sessionId, "editor_object_add", {
        name: "Magenta Arena Core",
        kind: "sphere",
        position: [3, 2.25, 0],
        color: "#ff00ff",
      });
      await callEditorTool(page, sessionId, "editor_object_update", {
        id: magenta.id,
        scale: [3.25, 3.25, 3.25],
        material: {
          color: "#ff00ff",
          emissive: "#ff00ff",
          emissiveIntensity: 2.5,
          metalness: 0,
          roughness: 0.25,
        },
      });
      const backdrop = await callEditorTool(page, sessionId, "editor_object_add", {
        name: "Huge Decorative Backdrop",
        kind: "plane",
        position: [0, 12, 35],
        color: "#15103d",
      });
      await callEditorTool(page, sessionId, "editor_object_update", {
        id: backdrop.id,
        scale: [80, 45, 1],
        material: {
          color: "#15103d",
          emissive: "#312e81",
          emissiveIntensity: 1.5,
        },
      });
      const authoredCamera = await callEditorTool(page, sessionId, "editor_camera_frame", {
        entityIds: [cyan.id, magenta.id],
        viewDirection: [0.8, 0.45, -1],
        padding: 1.3,
      });
      expect(authoredCamera).toMatchObject({
        ok: true,
        persisted: true,
        framedEntityIds: [cyan.id, magenta.id],
      });
      expect(authoredCamera.camera.position).toHaveLength(3);

      const script = await callEditorTool(page, sessionId, "editor_script_write", {
        id: "visual-pulse",
        name: "Visual pulse",
        code: "function update(entity, state, delta) { entity.position = [entity.position.x, entity.position.y, entity.position.z]; entity.rotation.y += delta; return state; }",
      });
      expect(script).toMatchObject({ id: "visual-pulse", created: true });
      await callEditorTool(page, sessionId, "editor_object_update", {
        id: cyan.id,
        scriptIds: ["visual-pulse"],
      });
      const addedTest = await callEditorTool(page, sessionId, "editor_test_add", {
        id: "visual-runtime-test",
        name: "Visual entities exist",
        script:
          "assert(scene.entities.some((entity) => entity.name === 'Cyan Arena Core'), 'cyan entity missing'); assert(scene.entities.some((entity) => entity.name === 'Magenta Arena Core'), 'magenta entity missing');",
      });
      expect(addedTest).toMatchObject({ id: "visual-runtime-test" });
      await callEditorTool(page, sessionId, "editor_run_pie", { frames: 2 });
      const testResults = await callEditorTool(page, sessionId, "editor_run_tests", {});
      expect(testResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "visual-runtime-test", pass: true }),
        ]),
      );
      const evidence = await callEditorTool(page, sessionId, "editor_capture_frame", {});
      expect(evidence.dataUrl).toMatch(/^data:image\//);

      const after = await imageStats(page, evidence.dataUrl);
      expect(after.width).toBeGreaterThan(200);
      expect(after.height).toBeGreaterThan(150);
      expect(after.cyan).toBeGreaterThan(before.cyan + 500);
      expect(after.magenta).toBeGreaterThan(before.magenta + 500);
      expect(after.cyan + after.magenta).toBeGreaterThan(
        Math.floor(after.width * after.height * 0.02),
      );
      expect(after.nonDark).toBeGreaterThan(Math.floor(after.width * after.height * 0.04));

      // Rebuilding after an unrelated backdrop edit must reuse the exact
      // authored pose. The huge decorative plane stays drawable but never
      // regains control of the evidence composition.
      await callEditorTool(page, sessionId, "editor_object_update", {
        id: backdrop.id,
        scale: [100, 60, 1],
      });
      const afterRebuild = await callEditorTool(page, sessionId, "editor_capture_frame", {});
      const rebuiltStats = await imageStats(page, afterRebuild.dataUrl);
      expect(rebuiltStats.cyan).toBeGreaterThan(500);
      expect(rebuiltStats.magenta).toBeGreaterThan(500);

      // The production evidence path is one browser call: capture the live
      // runtime, atomically persist image bytes in core, and return bounded
      // metadata. The model never has to repeat the data URL through its
      // context (where it can be truncated or rejected by a provider).
      const persisted = await callEditorTool(page, sessionId, "editor_persist_capture", {
        path: `reports/e2e/${suffix}/frame-001.png`,
      });
      expect(persisted).toMatchObject({
        path: `reports/e2e/${suffix}/frame-001.png`,
        mime: "image/png",
      });
      expect(persisted.bytes).toBeGreaterThan(100);
      expect(persisted.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(persisted.frame).toBeGreaterThanOrEqual(2);

      const consoleMarker = `visual-runtime-${suffix}`;
      await callEditorTool(page, sessionId, "editor_console_log", { message: consoleMarker });
      const history = await callEditorTool(page, sessionId, "editor_console_history", {
        level: "info",
        limit: 200,
      });
      expect(history.available).toBe(true);
      expect(history.logs).toEqual(
        expect.arrayContaining([expect.objectContaining({ level: "info", message: consoleMarker })]),
      );

      const motion = await callEditorTool(page, sessionId, "editor_analyze_motion", {
        frames: 8,
        maxCaptures: 3,
        label: `visual-runtime-${suffix}`,
      });
      expect(motion).toMatchObject({ frames: 3 });
      expect(motion.pngPath).toMatch(/^reports\/video\/.*\.png$/);
      expect(motion.manifestPath).toMatch(/^reports\/video\/.*\.json$/);

      await callEditorTool(page, sessionId, "editor_project_save", {});
      const savedProject = await callRpc(page, "project_open", { slug: projectSlug });
      expect(savedProject.settings.pie.camera).toMatchObject({
        sourceEntityIds: [cyan.id, magenta.id],
      });

      await selectSession(page, projectTitle, sessionTitle, sessionId, attachRequests);
      const afterReload = await callEditorTool(page, sessionId, "editor_capture_frame", {});
      const reloadStats = await imageStats(page, afterReload.dataUrl);
      expect(reloadStats.cyan).toBeGreaterThan(500);
      expect(reloadStats.magenta).toBeGreaterThan(500);
    } finally {
      if (sessionId) await callRpc(page, "session_delete", { id: sessionId }).catch(() => undefined);
      await callRpc(page, "project_delete", { slug: projectSlug }).catch(() => undefined);
    }
  });
});
