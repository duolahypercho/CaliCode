import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "./rpc";
import type { BrowserTool, Project } from "./types";
import {
  captureFrameWhenReady,
  captureMotionSequence,
  describeEditorProject,
  orchestrateLiveImage3dMesh,
  patchEditorEntity,
  upsertEditorScript,
  upsertEditorTest,
  useBrowserTools,
} from "./useBrowserTools";

vi.mock("./rpc", () => ({ rpc: vi.fn() }));
const mockRpc = vi.mocked(rpc);

beforeEach(() => {
  mockRpc.mockReset();
});

function project(): Project {
  return {
    schemaVersion: 1,
    slug: "demo",
    title: "Demo",
    settings: { gravity: 9.8 },
    entities: [
      {
        id: "hero",
        name: "Hero",
        kind: "box",
        transform: { position: [-1.5, 0.5, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
        material: { color: "#22d3ee", metalness: 0.7 },
        light: {},
        scriptIds: ["move"],
        assetId: null,
      },
    ],
    scripts: [{ id: "move", name: "move", code: "function update(entity) { entity.position.x += 1; }" }],
    assets: [
      {
        id: "asset-cube",
        name: "Cube",
        type: "procedural",
        source: "procedural:box",
        tags: ["prop"],
        usage: ["hero"],
        thumbnail: "data:image/png;base64,thumb",
        metadata: { generator: "box" },
      },
    ],
    tests: [{ id: "moves", name: "Hero moves", script: "await step(1); assert(entityFor('Hero'));" }],
  };
}

describe("describeEditorProject", () => {
  it("includes the live code, tests, materials, and script assignments agents need to edit safely", () => {
    const snapshot = describeEditorProject(project()).project;

    expect(snapshot.entities[0]).toMatchObject({
      id: "hero",
      position: [-1.5, 0.5, 2],
      material: { color: "#22d3ee", metalness: 0.7 },
      scriptIds: ["move"],
    });
    expect(snapshot.scripts[0].code).toContain("entity.position.x");
    expect(snapshot.tests[0].script).toContain("await step(1)");
    expect(snapshot.assets[0]).toMatchObject({
      source: "procedural:box",
      tags: ["prop"],
      usage: ["hero"],
      thumbnail: "data:image/png;base64,thumb",
      metadata: { generator: "box" },
    });
    expect(snapshot.settings).toEqual({ gravity: 9.8 });
  });

  it("upserts scripts by inspected id or name without creating duplicates", () => {
    const byName = upsertEditorScript(project(), { name: "move", code: "updated by name" });
    expect(byName.result).toEqual({ saved: "move", id: "move", created: false });
    expect(byName.project.scripts).toHaveLength(1);
    expect(byName.project.scripts[0]).toMatchObject({ id: "move", code: "updated by name" });

    const byId = upsertEditorScript(byName.project, { id: "move", name: "move", code: "updated by id" });
    expect(byId.project.scripts).toHaveLength(1);
    expect(byId.project.scripts[0]).toMatchObject({ id: "move", code: "updated by id" });

    const createdWithId = upsertEditorScript(byId.project, {
      id: "laneSwap",
      name: "Lane swap",
      code: "function update() {}",
    });
    expect(createdWithId.result).toEqual({ saved: "Lane swap", id: "laneSwap", created: true });
    expect(createdWithId.project.scripts).toHaveLength(2);
    expect(createdWithId.project.scripts[1]).toMatchObject({ id: "laneSwap", name: "Lane swap" });

    const assigned = patchEditorEntity(createdWithId.project, { id: "hero", scriptIds: ["laneSwap"] });
    expect(assigned.result).toEqual({ updated: "hero" });
    expect(assigned.project.entities[0].scriptIds).toEqual(["laneSwap"]);
  });

  it("deduplicates object script assignment and rejects unknown scripts", () => {
    const assigned = patchEditorEntity(project(), { id: "hero", scriptIds: ["move", "move"] });
    expect(assigned.result).toEqual({ updated: "hero" });
    expect(assigned.project.entities[0].scriptIds).toEqual(["move"]);

    const invalidBase = project();
    const invalid = patchEditorEntity(invalidBase, { id: "hero", scriptIds: ["missing"] });
    expect(invalid.result).toEqual({ error: "script missing not found" });
    expect(invalid.project).toBe(invalidBase);
  });

  describe("upsertEditorTest", () => {
    it("upserts tests by inspected id or name without duplicating the suite", () => {
      const base = project();
      const updated = upsertEditorTest(base, {
        name: "Hero moves",
        script: "assert(entityFor('Hero'));",
      });
      expect(updated.project.tests).toHaveLength(1);
      expect(updated.result).toEqual({ saved: "Hero moves", id: "moves", created: false });

      const created = upsertEditorTest(updated.project, {
        name: "New invariant",
        script: "assert(true);",
      });
      expect(created.project.tests).toHaveLength(2);
      expect(created.result).toMatchObject({ saved: "New invariant", created: true });
      const newId = (created.result as { id: string }).id;
      const replaced = upsertEditorTest(created.project, {
        id: newId,
        name: "New invariant",
        script: "assert(false);",
      });
      expect(replaced.project.tests).toHaveLength(2);
      expect(replaced.result).toEqual({ saved: "New invariant", id: newId, created: false });
      expect(replaced.project.tests.find((test) => test.id === newId)?.script).toBe("assert(false);");
    });

    it("returns actionable errors for missing name, empty script, and name collisions", () => {
      const base = project();

      const noName = upsertEditorTest(base, { name: "   ", script: "assert(true);" });
      expect(noName.result).toEqual({ error: "test name is required" });
      expect(noName.project).toBe(base);

      const noScript = upsertEditorTest(base, { name: "Lane swap works", script: "" });
      expect(noScript.result).toEqual({ error: "test script is required" });
      expect(noScript.project).toBe(base);

      const noScriptWhitespace = upsertEditorTest(base, { name: "Lane swap works", script: "   " });
      expect(noScriptWhitespace.result).toEqual({ error: "test script is required" });
      expect(noScriptWhitespace.project).toBe(base);

      const baseWithDup = {
        ...project(),
        tests: [
          ...project().tests,
          { id: "fresh", name: "Fresh name", script: "assert(true);" },
        ],
      };
      const collide = upsertEditorTest(baseWithDup, {
        id: "moves",
        name: "Fresh name",
        script: "assert(false);",
      });
      expect(collide.result).toEqual({ error: 'test name "Fresh name" is already in use' });
      expect(collide.project).toBe(baseWithDup);
    });

    it("rejects array and object ids rather than stringifying them silently", () => {
      const base = project();
      const arrayId = upsertEditorTest(base, {
        id: ["moves"],
        name: "Lane swap works",
        script: "assert(true);",
      });
      expect(arrayId.result).toEqual({ error: "test id must be a string, number, or boolean (got object)" });
      expect(arrayId.project).toBe(base);

      const objectId = upsertEditorTest(base, {
        id: { kind: "lookup" },
        name: "Score increments",
        script: "assert(true);",
      });
      expect(objectId.result).toEqual({ error: "test id must be a string, number, or boolean (got object)" });
      expect(objectId.project).toBe(base);
    });

    it("coerces numeric and boolean ids and refuses to collide with a different id", () => {
      const base = project();
      const created = upsertEditorTest(base, {
        id: 42,
        name: "Lane swap works",
        script: "assert(true);",
      });
      expect(created.result).toEqual({ saved: "Lane swap works", id: "42", created: true });
      expect(created.project.tests.find((test) => test.id === "42")).toMatchObject({
        name: "Lane swap works",
      });

      const collide = upsertEditorTest(created.project, {
        id: "second-id",
        name: "Lane swap works",
        script: "assert(false);",
      });
      expect(collide.result).toEqual({ error: 'test name "Lane swap works" is already in use' });
      expect(collide.project).toBe(created.project);
      expect(collide.project.tests.find((test) => test.id === "42")?.script).toBe("assert(true);");
    });
  });
});

describe("captureMotionSequence", () => {
  it("awaits glTF readiness for an immediate capture", async () => {
    const events: string[] = [];
    const runtime = {
      capture() {
        events.push("sync");
        return "";
      },
      async captureWhenReady() {
        events.push("wait");
        await Promise.resolve();
        events.push("ready");
        return "data:image/png;base64,ready";
      },
    };

    await expect(captureFrameWhenReady(runtime)).resolves.toContain("data:image/");
    expect(events).toEqual(["wait", "ready"]);
  });

  it("passes the bounded readiness budget through to capture", async () => {
    let timeout = 0;
    const runtime = {
      capture() {
        return "data:image/png;base64,fallback";
      },
      async captureWhenReady(value?: number) {
        timeout = value ?? -1;
        return "data:image/png;base64,ready";
      },
    };

    await expect(captureFrameWhenReady(runtime, 17)).resolves.toContain("data:image/");
    expect(timeout).toBe(17);
  });

  it("samples chronological fixed-step frames including both ends", async () => {
    let frame = 40;
    let timeMs = 2_000;
    let paused = false;
    const runtime = {
      get frames() {
        return frame;
      },
      get timeMs() {
        return timeMs;
      },
      pause() {
        paused = true;
      },
      async stepOnce() {
        frame += 1;
        timeMs += 100;
      },
      async captureWhenReady() {
        return `data:image/png;base64,frame-${frame}`;
      },
      capture() {
        return `data:image/png;base64,frame-${frame}`;
      },
    };

    const captures = await captureMotionSequence(runtime, 10, 4);
    expect(paused).toBe(true);
    expect(captures.map((capture) => capture.frame)).toEqual([41, 44, 47, 50]);
    expect(captures.map((capture) => capture.timeMs)).toEqual([2_100, 2_400, 2_700, 3_000]);
  });

  it("clamps requests and refuses an empty renderer capture", async () => {
    let frame = 0;
    const runtime = {
      get frames() {
        return frame;
      },
      get timeMs() {
        return frame * 16;
      },
      pause() {},
      async stepOnce() {
        frame += 1;
      },
      capture() {
        return "";
      },
    };
    await expect(captureMotionSequence(runtime, 1, 1)).rejects.toThrow("could not be captured");
    expect(frame).toBe(1);
  });
});

describe("orchestrateLiveImage3dMesh", () => {
  it("flushes before generation and adopts the reopened asset before promotion can run", async () => {
    const initial = project();
    const generatedAsset = {
      ...initial.assets[0],
      id: "asset-mesh",
      name: "Mesh",
      type: "cali" as const,
      source: "asset-mesh.cali.json",
      metadata: {
        cali: {
          assetId: "asset-mesh",
          componentTree: [{ id: "mesh-root", primitive: "mesh", mesh: { positions: [0, 0, 0] } }],
        },
      },
    };
    const reopened = { ...initial, assets: [...initial.assets, generatedAsset] };
    const events: string[] = [];
    let live = initial;

    const result = await orchestrateLiveImage3dMesh(
      { name: "Mesh", image: "data:image/png;base64,AAAA" },
      {
        currentProject: () => live,
        saveProject: async (snapshot) => {
          events.push("save");
          expect(snapshot).toBe(initial);
        },
        generateMesh: async (params) => {
          events.push("generate");
          expect(params).toMatchObject({ slug: "demo", name: "Mesh" });
          return { assetId: "asset-mesh", mode: "extrude" };
        },
        openProject: async (slug) => {
          events.push(`open:${slug}`);
          return reopened;
        },
        adoptProject: (next) => {
          events.push(`adopt:${next.assets.length}`);
          live = next;
          return next;
        },
      },
    );

    expect(events).toEqual(["save", "adopt:1", "generate", "open:demo", "adopt:2"]);
    expect(result).toMatchObject({ assetId: "asset-mesh", live: true });
    // This is the state editor_promote_asset reads on the next tool call.
    expect(live.assets.find((asset) => asset.id === "asset-mesh")?.metadata?.cali).toMatchObject({
      componentTree: [{ primitive: "mesh" }],
    });
  });
});

function buildUseBrowserToolsHarness(overrides: Partial<Parameters<typeof useBrowserTools>[0]> = {}) {
  const runtimeRef = { current: null } as Parameters<typeof useBrowserTools>[0]["runtimeRef"];
  const setProject = vi.fn();
  const setTestResults = vi.fn();
  const setSelectedEntityId = vi.fn();
  const pushLog = vi.fn();
  const setBuilderAssetId = vi.fn();
  const focusBuilderTab = vi.fn();
  const applyBuilderOps = vi.fn() as unknown as Parameters<typeof useBrowserTools>[0]["applyBuilderOps"];
  const replaceBuilderSpec = vi.fn();
  const getLogs = vi.fn(() => [
    { id: "log-1", level: "info", message: "PIE step 1", time: "12:00:00" },
    { id: "log-2", level: "error", message: "boom", time: "12:00:01" },
    { id: "log-3", level: "info", message: "PIE step 2", time: "12:00:02" },
  ]) as unknown as Parameters<typeof useBrowserTools>[0]["getLogs"];
  let toolsRef: { current: BrowserTool[] } = { current: [] };
  // `result.current` is set inside a useEffect in React 18+, so reading it
  // synchronously returns undefined. Wrap the render in act() and store the
  // resolved tool list on a stable ref the test can read afterwards.
  act(() => {
    const { result } = renderHook(() =>
      useBrowserTools({
        project: project(),
        setProject,
        adoptSaved: undefined,
        runtimeRef,
        setTestResults,
        setSelectedEntityId,
        pushLog,
        getLogs,
        builderAssetId: null,
        setBuilderAssetId,
        focusBuilderTab,
        applyBuilderOps,
        replaceBuilderSpec,
        ...overrides,
      }),
    );
    toolsRef = result as { current: BrowserTool[] };
  });
  return {
    result: toolsRef,
    setProject,
    findTool(name: string): BrowserTool | undefined {
      return toolsRef.current.find((tool) => tool.name === name);
    },
  };
}

describe("editor_camera_frame", () => {
  function framedCamera() {
    return {
      ok: true as const,
      camera: {
        position: [4, 3, -6],
        target: [-1.5, 0.5, 2],
        fov: 50,
        near: 0.1,
        far: 140,
        viewDirection: [0.5, 0.3, -1],
        padding: 1.25,
        sourceEntityIds: ["hero"],
      },
      fitBounds: { min: [-2, 0, 1.5], max: [-1, 1, 2.5] },
      framedEntityIds: ["hero"],
    };
  }

  it("authors and persists the exact scoped camera without losing other PIE settings", async () => {
    const result = framedCamera();
    const runtime = {
      setProject: vi.fn(),
      frameProject: vi.fn().mockResolvedValue(result),
    } as unknown as NonNullable<Parameters<typeof useBrowserTools>[0]["runtimeRef"]["current"]>;
    const input = { ...project(), settings: { gravity: 9.8, pie: { fixedStepHz: 30, captureEvery: 5 } } };
    const { findTool, setProject } = buildUseBrowserToolsHarness({
      project: input,
      runtimeRef: { current: runtime },
    });

    const output = await act(async () =>
      findTool("editor_camera_frame")!.handler({
        entityIds: ["hero"],
        viewDirection: [0.5, 0.3, -1],
        padding: 1.25,
      }),
    );

    expect(runtime.frameProject).toHaveBeenNthCalledWith(1, {
      entityIds: ["hero"],
      viewDirection: [0.5, 0.3, -1],
      padding: 1.25,
    });
    expect(runtime.frameProject).toHaveBeenNthCalledWith(2);
    const persisted = setProject.mock.calls.at(-1)?.[0] as Project;
    expect(persisted.settings).toMatchObject({
      gravity: 9.8,
      pie: { fixedStepHz: 30, captureEvery: 5, camera: result.camera },
    });
    expect(output).toMatchObject({ ok: true, persisted: true, framedEntityIds: ["hero"] });
  });

  it("rejects invalid selections before moving or persisting the camera", async () => {
    const runtime = {
      setProject: vi.fn(),
      frameProject: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof useBrowserTools>[0]["runtimeRef"]["current"]>;
    const { findTool, setProject } = buildUseBrowserToolsHarness({ runtimeRef: { current: runtime } });
    const tool = findTool("editor_camera_frame")!;

    await expect(tool.handler({ entityIds: [], excludeEntityIds: ["hero"] })).resolves.toEqual({
      error: "entityIds must not be empty",
    });
    await expect(tool.handler({ entityIds: ["hero"], excludeEntityIds: ["hero"] })).resolves.toEqual({
      error: "pass either entityIds or excludeEntityIds, not both",
    });
    await expect(tool.handler({ entityIds: ["hero"], viewDirection: [0, 0, 0] })).resolves.toEqual({
      error: "viewDirection must be non-zero",
    });
    expect(runtime.frameProject).not.toHaveBeenCalled();
    expect(setProject).not.toHaveBeenCalled();
  });
});

describe("editor_persist_capture", () => {
  it("forwards path and dataUrl to the capture_persist RPC and returns the persisted metadata", async () => {
    mockRpc.mockResolvedValueOnce({
      path: "reports/walk/frame-001.png",
      bytes: 1234,
      mime: "image/png",
      sha256: "deadbeef",
    });
    const { findTool } = buildUseBrowserToolsHarness();
    const tool = findTool("editor_persist_capture");
    expect(tool).toBeDefined();
    if (!tool) return;

    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
    const result = await act(async () => {
      return tool.handler({ path: "reports/walk/frame-001.png", dataUrl });
    });

    expect(mockRpc).toHaveBeenCalledWith(
      "capture_persist",
      expect.objectContaining({
        slug: project().slug,
        path: "reports/walk/frame-001.png",
        dataUrl,
      }),
    );
    expect(result).toEqual({
      path: "reports/walk/frame-001.png",
      bytes: 1234,
      mime: "image/png",
      sha256: "deadbeef",
      frame: null,
      timeMs: null,
    });
  });

  it("rejects an empty path before touching the network", async () => {
    const { findTool } = buildUseBrowserToolsHarness();
    const tool = findTool("editor_persist_capture");
    expect(tool).toBeDefined();
    if (!tool) return;

    const result = await act(async () => {
      return tool.handler({ path: "  ", dataUrl: "data:image/png;base64,AAAA" });
    });

    expect(mockRpc).not.toHaveBeenCalled();
    expect(result).toEqual({ error: "path is required" });
  });

  it("rejects a missing live runtime before touching the network", async () => {
    const { findTool } = buildUseBrowserToolsHarness();
    const tool = findTool("editor_persist_capture");
    expect(tool).toBeDefined();
    if (!tool) return;

    const result = await act(async () => {
      return tool.handler({ path: "frame.png" });
    });

    expect(mockRpc).not.toHaveBeenCalled();
    expect(result).toEqual({ error: "runtime not ready" });
  });

  it("captures and persists in one call without replaying image bytes through the model", async () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
    mockRpc.mockResolvedValueOnce({
      path: "reports/walk/live.png",
      bytes: 67,
      mime: "image/png",
      sha256: "livehash",
    });
    const runtime = {
      frames: 42,
      timeMs: 700,
      setProject: vi.fn(),
      frameProject: vi.fn().mockResolvedValue(true),
      capture: vi.fn(() => dataUrl),
      captureWhenReady: vi.fn().mockResolvedValue(dataUrl),
    } as unknown as NonNullable<Parameters<typeof useBrowserTools>[0]["runtimeRef"]["current"]>;
    const { findTool } = buildUseBrowserToolsHarness({ runtimeRef: { current: runtime } });
    const tool = findTool("editor_persist_capture");
    expect(tool).toBeDefined();
    if (!tool) return;

    const result = await act(async () => tool.handler({ path: "reports/walk/live.png" }));

    expect(runtime.setProject).toHaveBeenCalled();
    expect(runtime.frameProject).toHaveBeenCalled();
    expect(runtime.captureWhenReady).toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith("capture_persist", {
      slug: project().slug,
      path: "reports/walk/live.png",
      dataUrl,
    });
    expect(result).toMatchObject({ path: "reports/walk/live.png", frame: 42, timeMs: 700 });
  });
});

describe("editor_console_history", () => {
  it("returns the most recent entries up to the requested limit", async () => {
    const { findTool } = buildUseBrowserToolsHarness();
    const tool = findTool("editor_console_history");
    expect(tool).toBeDefined();
    if (!tool) return;

    const result = await act(async () => {
      return tool.handler({ limit: 2 });
    });

    expect(result).toMatchObject({
      count: 2,
      available: true,
      logs: [
        { id: "log-2", level: "error", message: "boom", time: "12:00:01" },
        { id: "log-3", level: "info", message: "PIE step 2", time: "12:00:02" },
      ],
    });
  });

  it("filters by level when the caller asks for errors only", async () => {
    const { findTool } = buildUseBrowserToolsHarness();
    const tool = findTool("editor_console_history");
    expect(tool).toBeDefined();
    if (!tool) return;

    const result = (await act(async () => {
      return tool.handler({ level: "error" });
    })) as { logs: Array<{ level: string }>; count: number };

    expect(result.count).toBe(1);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].level).toBe("error");
  });

  it("returns an actionable notice when the host did not expose getLogs", async () => {
    const { findTool } = buildUseBrowserToolsHarness({ getLogs: undefined });
    const tool = findTool("editor_console_history");
    expect(tool).toBeDefined();
    if (!tool) return;

    const result = await act(async () => {
      return tool.handler({});
    });

    expect(result).toMatchObject({
      logs: [],
      count: 0,
      available: false,
    });
    expect((result as { notice: string }).notice).toMatch(/getLogs/);
  });
});
