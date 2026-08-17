import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPanel, settleRunningToolRows } from "./AgentPanel";
import type { AgentEvent } from "../../lib/rpc";
import type { TaskGraph } from "../../lib/graph";
import type { LoopReport, OpenLoopReport } from "../../lib/loopReports";
import type { AgentMessage } from "../../lib/types";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  connectEvents: vi.fn(),
  createSession: vi.fn(),
  forkSession: vi.fn(),
  listSessions: vi.fn(),
  loadSession: vi.fn(),
  saveSession: vi.fn(),
  loadModelDev: vi.fn(),
  readCoreConfig: vi.fn(),
  cancelGraph: vi.fn(),
  graphStatus: vi.fn(),
  listGraphs: vi.fn(),
  planGraph: vi.fn(),
  runGraph: vi.fn(),
  openLoopReport: vi.fn(),
  startLoopRun: vi.fn(),
  stopLoopRun: vi.fn(),
}));

vi.mock("../../lib/rpc", () => ({
  rpc: mocks.rpc,
  connectEvents: mocks.connectEvents,
}));

vi.mock("../../lib/sessions", () => ({
  createSession: mocks.createSession,
  forkSession: mocks.forkSession,
  listSessions: mocks.listSessions,
  loadSession: mocks.loadSession,
  relativeTime: vi.fn(() => "now"),
  saveSession: mocks.saveSession,
}));

vi.mock("../../lib/modelMeta", () => ({
  contextLimitFor: vi.fn(() => null),
  defaultEffort: vi.fn((levels: string[]) => levels[0] ?? null),
  effortLevelsFor: vi.fn(() => []),
  loadModelDev: mocks.loadModelDev,
}));

vi.mock("../../lib/coreConfig", () => ({
  contextWindowOf: vi.fn(() => 100_000),
  formatTokens: vi.fn((value: number) => String(value)),
  readCoreConfig: mocks.readCoreConfig,
  sandboxSummary: vi.fn(() => null),
}));

vi.mock("../../lib/graph", () => ({
  DEFAULT_JUDGE_THRESHOLD: 90,
  cancelGraph: mocks.cancelGraph,
  graphStatus: mocks.graphStatus,
  layoutLayers: vi.fn(() => [["gameplay", "visuals", "tests"], ["integration"], ["judge"]]),
  listGraphs: mocks.listGraphs,
  planGraph: mocks.planGraph,
  runGraph: mocks.runGraph,
}));

vi.mock("../../lib/loopReports", () => ({
  openLoopReport: mocks.openLoopReport,
  startLoopRun: mocks.startLoopRun,
  stopLoopRun: mocks.stopLoopRun,
}));

let emitEvent: ((event: AgentEvent) => void) | null = null;

const modelList = {
  active: { provider: "openai", model: "gpt-4.1-mini", baseUrl: "" },
  providers: [{ id: "openai", label: "OpenAI", base_url: "", api_key_env: "", models: ["gpt-4.1-mini"] }],
};

function renderPanel(initialSessionId?: string) {
  return render(
    <AgentPanel
      projectSlug="demo"
      workspaceRoot="/tmp/game"
      modelList={modelList}
      browserTools={[]}
      onModelChange={() => {}}
      onLog={() => {}}
      initialSessionId={initialSessionId}
    />,
  );
}

function activityEvents(): [AgentEvent, AgentEvent] {
  return [
    {
      type: "agent.tool_started",
      sessionId: "session-1",
      projectSlug: "demo",
      workspaceRoot: "/tmp/game",
      tool: "file_edit",
      toolCallId: "edit-1",
      startedAtMs: 100,
    },
    {
      type: "agent.tool_finished",
      sessionId: "session-1",
      projectSlug: "demo",
      workspaceRoot: "/tmp/game",
      tool: "file_edit",
      toolCallId: "edit-1",
      startedAtMs: 100,
      finishedAtMs: 200,
      activity: {
        operation: "edit",
        path: "src/game.ts",
        before: "",
        after: "const score = 1;\n",
      },
      result: { ok: true },
    },
  ];
}

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  emitEvent = null;
  mocks.rpc.mockReset();
  mocks.connectEvents.mockReset();
  mocks.createSession.mockReset();
  mocks.forkSession.mockReset();
  mocks.listSessions.mockReset();
  mocks.loadSession.mockReset();
  mocks.saveSession.mockReset();
  mocks.loadModelDev.mockReset();
  mocks.readCoreConfig.mockReset();
  mocks.cancelGraph.mockReset();
  mocks.graphStatus.mockReset();
  mocks.listGraphs.mockReset();
  mocks.planGraph.mockReset();
  mocks.runGraph.mockReset();
  mocks.openLoopReport.mockReset();

  mocks.connectEvents.mockImplementation((listener: (event: AgentEvent) => void) => {
    emitEvent = listener;
    return () => {
      emitEvent = null;
    };
  });
  mocks.createSession.mockResolvedValue({ id: "session-1", workspaceRoot: "/tmp/game" });
  mocks.listSessions.mockResolvedValue([]);
  mocks.saveSession.mockResolvedValue({});
  mocks.listGraphs.mockResolvedValue([]);
  mocks.graphStatus.mockResolvedValue({});
  mocks.openLoopReport.mockImplementation(async (_slug: string, loopId: string) => readyLoopReport(loopId));
  mocks.loadModelDev.mockResolvedValue({ index: null, catalog: {}, contextLimits: {} });
  mocks.readCoreConfig.mockResolvedValue(null);
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "editor_attach") return {};
    if (method === "agent_chat") return { sessionId: "session-1", reply: "DONE", toolCalls: [] };
    return {};
  });
});

function passingGraph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    schemaVersion: 1,
    graphId: "graph-loop",
    goal: "polish the game",
    projectSlug: "demo",
    ownerSession: "session-1",
    workspaceRoot: "/tmp/game",
    nodes: [
      {
        id: "gameplay",
        title: "Gameplay",
        kind: "build",
        role: "gameplay",
        instructions: "",
        acceptance: [],
        maxTurns: 8,
        deps: [],
        status: "passed",
        attempts: 1,
        punchList: [],
        evidencePaths: ["reports/graph-loop/gameplay/contact-sheet.png"],
        evidenceCount: 3,
      },
      {
        id: "visuals",
        title: "Visuals",
        kind: "build",
        role: "artist",
        instructions: "",
        acceptance: [],
        maxTurns: 8,
        deps: [],
        status: "passed",
        attempts: 1,
        punchList: [],
      },
      {
        id: "tests",
        title: "Scripts and tests",
        kind: "build",
        role: "tester",
        instructions: "",
        acceptance: [],
        maxTurns: 8,
        deps: [],
        status: "passed",
        attempts: 1,
        punchList: [],
      },
      {
        id: "integration",
        title: "Integration",
        kind: "build",
        role: "integrator",
        instructions: "",
        acceptance: [],
        maxTurns: 8,
        deps: ["gameplay", "visuals", "tests"],
        status: "passed",
        attempts: 1,
        punchList: [],
      },
      {
        id: "judge",
        title: "Judge",
        kind: "judge",
        role: "critic",
        instructions: "",
        acceptance: [],
        threshold: 90,
        maxTurns: 8,
        deps: ["integration"],
        status: "passed",
        attempts: 1,
        reference: "Geometry Wars 3",
        score: 95,
        punchList: [],
      },
    ],
    status: "complete",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function readyLoopReport(loopId = "loop-proof"): OpenLoopReport {
  const memory = {
    observations: ["The initial pass needs polish"],
    decisions: [],
    risks: [],
    nextActions: ["Repair and re-verify"],
  };
  const initial = {
    iteration: 1,
    startedAtMs: 1_000,
    completedAtMs: 2_000,
    durationMs: 1_000,
    outcome: "needs-work" as const,
    summary: "Initial pass",
    agents: [],
    checks: [],
    changedFiles: [{ path: "project.json", additions: 1, deletions: 0 }],
    evidence: [],
    scores: [],
    punchList: [],
    nextIterationMemory: memory,
  };
  return {
    report: {
      schemaVersion: 1,
      projectSlug: "demo",
      loopId,
      objective: "polish the game",
      reference: "Geometry Wars 3",
      status: "running",
      createdAtMs: 1_000,
      updatedAtMs: 4_000,
      startedAtMs: 1_000,
      completedAtMs: null,
      summary: "",
      punchList: [],
      nextIterationMemory: memory,
      iterations: [
        initial,
        {
          ...initial,
          iteration: 2,
          startedAtMs: 2_000,
          completedAtMs: 4_000,
          durationMs: 2_000,
          outcome: "passed",
          summary: "Repair passed",
          agents: [{ role: "integrator", task: "repair", outcome: "passed", summary: "done", durationMs: 500 }],
          checks: [
            { kind: "build", name: "build", status: "passed", durationMs: 1, details: "ok" },
            { kind: "play", name: "PIE", status: "passed", durationMs: 1, details: "ok" },
            { kind: "test", name: "tests", status: "passed", durationMs: 1, details: "ok" },
          ],
          evidence: [{ kind: "contact-sheet", path: "reports/video/final.png", caption: "motion" }],
          scores: [{ criterion: "overall", score: 95, maximum: 100, passThreshold: 90, rationale: "passed" }],
        },
      ],
      totals: {
        iterations: 2,
        workedDurationMs: 3_000,
        elapsedDurationMs: 3_000,
        agents: 1,
        checksPassed: 3,
        checksFailed: 0,
        checksSkipped: 0,
        filesChanged: 1,
        additions: 1,
        deletions: 0,
        latestScorePercent: 95,
      },
    },
    projectRoot: "/tmp/game",
    jsonPath: `reports/loops/${loopId}/report.json`,
    markdownPath: `reports/loops/${loopId}/report.md`,
    htmlPath: `reports/loops/${loopId}/report.html`,
  };
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("session resume", () => {
  it("repairs a generic legacy browser-tool label without rewriting a detailed file edit", async () => {
    mocks.loadSession.mockResolvedValue({
      id: "session-legacy-activity",
      title: "Legacy activity",
      projectSlug: "demo",
      provider: "openai",
      model: "gpt-4.1-mini",
      workspaceRoot: "/tmp/game",
      createdAt: 1_000,
      updatedAt: 2_000,
      messageCount: 2,
      messages: [
        {
          role: "tool",
          tool: "editor_scene_inspect",
          toolCallId: "inspect-legacy",
          content: "Edited file",
        },
        {
          role: "tool",
          tool: "file_edit",
          toolCallId: "edit-detailed",
          content: "Edited README.md +2 -1",
        },
      ],
    });

    renderPanel("session-legacy-activity");

    expect(await screen.findByText("Used editor_scene_inspect")).toBeTruthy();
    expect(screen.getByText("Edited README.md +2 -1")).toBeTruthy();
    expect(screen.queryByText("Edited file")).toBeNull();
    expect(mocks.loadSession).toHaveBeenCalledWith("session-legacy-activity");
  });
});


describe("/loop starts a core-side run", () => {
  const startedRun = (over: Record<string, unknown> = {}) => ({
    loopId: "loop-1",
    slug: "demo",
    goal: "fix the typo",
    profile: "standard",
    status: "running",
    iteration: 0,
    maxIterations: 100,
    startedAtMs: 1,
    ...over,
  });

  const fire = async (text: string) => {
    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: text } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await screen.findByText(/▶ loop started/);
  };

  it("hands the goal, profile and pacing to core rather than driving turns itself", async () => {
    mocks.startLoopRun.mockResolvedValue(startedRun());
    await fire("/loop fix the typo");
    expect(mocks.startLoopRun).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "fix the typo", profile: "standard", intervalMs: null }),
    );
    // The panel must not be running turns of its own any more.
    const chats = mocks.rpc.mock.calls.filter(([method]) => method === "agent_chat");
    expect(chats).toHaveLength(0);
  });

  it("passes the aaa profile through", async () => {
    mocks.startLoopRun.mockResolvedValue(startedRun({ profile: "aaa" }));
    await fire("/loop --aaa make the boss fight feel good");
    expect(mocks.startLoopRun).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "make the boss fight feel good", profile: "aaa" }),
    );
  });

  it("passes an interval through as pacing", async () => {
    mocks.startLoopRun.mockResolvedValue(startedRun());
    await fire("/loop 15m run the tests");
    expect(mocks.startLoopRun).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "run the tests", intervalMs: 900_000 }),
    );
  });

  it("reuses this panel's session, so the run's turns land in this transcript", async () => {
    mocks.startLoopRun.mockResolvedValue(startedRun());
    await fire("/loop fix the typo");
    expect(mocks.startLoopRun).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", workspaceRoot: "/tmp/game" }),
    );
  });

  it("surfaces a refused start instead of leaving the composer stuck", async () => {
    mocks.startLoopRun.mockRejectedValue(new Error("core said no"));
    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop fix the typo" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    expect(await screen.findByText(/Loop error: core said no/)).toBeTruthy();
    // Busy must clear, or the panel is wedged with no run behind it.
    expect(screen.queryByRole("button", { name: "Stop agent loop" })).toBeNull();
  });
});

describe("/loop renders the run core reports", () => {
  const startedRun = { loopId: "loop-1", slug: "demo", goal: "fix the typo", profile: "standard", status: "running", iteration: 0, maxIterations: 100, startedAtMs: 1 };

  const startLoop = async () => {
    mocks.startLoopRun.mockResolvedValue(startedRun);
    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop fix the typo" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await screen.findByText(/▶ loop started/);
  };

  it("shows each iteration's prompt and counter", async () => {
    await startLoop();
    await act(async () => {
      emitEvent?.({
        type: "loop.iteration",
        loopId: "loop-1",
        iteration: 1,
        maxIterations: 100,
        prompt: "fix the typo",
      } as AgentEvent);
    });
    expect(await screen.findByText("loop 1/100")).toBeTruthy();
    // The prompt lands as a user row, which is what makes a loop's transcript
    // readable back: you can see what was actually asked each iteration.
    const userRows = document.querySelectorAll('[data-role="user"]');
    expect(
      Array.from(userRows).some((row) => row.textContent?.includes("fix the typo")),
    ).toBe(true);
  });

  it("shows a refused DONE with core's reason", async () => {
    await startLoop();
    await act(async () => {
      emitEvent?.({
        type: "loop.done_refused",
        loopId: "loop-1",
        iteration: 2,
        reason: "the report has one iteration, two are required",
      } as AgentEvent);
    });
    expect(await screen.findByText(/DONE ignored: the report has one iteration/)).toBeTruthy();
  });

  it("clears the loop UI when core says the run finished", async () => {
    await startLoop();
    expect(screen.getByRole("button", { name: "Stop agent loop" })).toBeTruthy();
    await act(async () => {
      emitEvent?.({
        type: "loop.finished",
        loop: { loopId: "loop-1", status: "completed", iteration: 2 },
      } as AgentEvent);
    });
    expect(await screen.findByText(/loop 1\/100|▶ loop started/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop agent loop" })).toBeNull();
  });

  it("reports a failed run rather than silently going idle", async () => {
    await startLoop();
    await act(async () => {
      emitEvent?.({
        type: "loop.finished",
        loop: { loopId: "loop-1", status: "failed", iteration: 1, detail: "provider refused" },
      } as AgentEvent);
    });
    expect(await screen.findByText(/Loop failed: provider refused/)).toBeTruthy();
  });

  it("ignores events belonging to somebody else's run", async () => {
    await startLoop();
    await act(async () => {
      emitEvent?.({
        type: "loop.done_refused",
        loopId: "loop-other",
        reason: "not ours",
      } as AgentEvent);
    });
    expect(screen.queryByText(/not ours/)).toBeNull();
  });

  it("stops the run in core, not just in this tab", async () => {
    await startLoop();
    mocks.stopLoopRun.mockResolvedValue({ ...startedRun, status: "stopped" });
    fireEvent.click(screen.getByRole("button", { name: "Stop agent loop" }));
    expect(mocks.stopLoopRun).toHaveBeenCalledWith("loop-1");
  });
});

describe("settleRunningToolRows", () => {
  it("marks running tool rows in the current turn as errored with a finish timestamp", () => {
    const messages: AgentMessage[] = [
      { role: "tool", tool: "turn", content: "", turnId: "loop-turn", status: "running", startedAtMs: 1 },
      {
        role: "tool",
        tool: "file_edit",
        toolCallId: "edit-1",
        turnId: "loop-turn",
        status: "running",
        startedAtMs: 100,
        content: "Edited src/game.ts",
      },
      {
        role: "tool",
        tool: "file_edit",
        toolCallId: "edit-2",
        turnId: "loop-turn",
        status: "done",
        startedAtMs: 200,
        completedAtMs: 300,
        content: "Edited src/other.ts",
      },
      {
        role: "tool",
        tool: "file_edit",
        toolCallId: "edit-3",
        turnId: "other-turn",
        status: "running",
        startedAtMs: 400,
        content: "Edited foreign turn",
      },
    ];

    const settled = settleRunningToolRows(messages, "loop-turn", 999);
    expect(settled.find((message) => message.toolCallId === "edit-1")).toMatchObject({
      status: "error",
      completedAtMs: 999,
    });
    expect(settled.find((message) => message.toolCallId === "edit-2")).toMatchObject({ status: "done" });
    expect(settled.find((message) => message.toolCallId === "edit-3")).toMatchObject({ status: "running" });
    expect(settled).not.toBe(messages);
  });

  it("returns the same array when there is nothing to settle", () => {
    const messages: AgentMessage[] = [
      { role: "tool", tool: "turn", content: "", turnId: "loop-turn", status: "done", startedAtMs: 1, completedAtMs: 2 },
    ];
    expect(settleRunningToolRows(messages, "loop-turn", 999)).toBe(messages);
  });
});
