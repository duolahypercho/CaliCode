import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentPanel,
  fallbackLoopChangedFiles,
  graphQualityReference,
  hasRecordedLoopIteration,
  isTransientRpcError,
  loopIterationPrompt,
  reportLoopBestEffort,
  settleRunningToolRows,
  validateLoopGraphCompletion,
  validateLoopReportCompletion,
} from "./AgentPanel";
import type { AgentEvent } from "../../lib/rpc";
import type { TaskGraph } from "../../lib/graph";
import type { OpenLoopReport } from "../../lib/loopReports";
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
  defaultEffort: vi.fn((levels: string[]) => levels[0] ?? null),
  effortLevelsFor: vi.fn(() => []),
  loadModelDev: mocks.loadModelDev,
}));

vi.mock("../../lib/coreConfig", () => ({
  contextWindowOf: vi.fn(() => 100_000),
  formatTokens: vi.fn((value: number) => String(value)),
  readCoreConfig: mocks.readCoreConfig,
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
  mocks.loadModelDev.mockResolvedValue({ index: null, catalog: {} });
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

describe("loop reporting", () => {
  it("takes the durable quality reference only from a Judge node", () => {
    expect(graphQualityReference(passingGraph())).toBe("Geometry Wars 3");
    expect(
      graphQualityReference({
        ...passingGraph(),
        nodes: passingGraph().nodes.map((node) => ({ ...node, reference: node.kind === "build" ? "untrusted" : null })),
      }),
    ).toBeNull();
  });

  it("keeps the full completion topology in repair-iteration prompts", () => {
    const prompt = loopIterationPrompt("polish the game", "loop-proof", 2);

    expect(prompt).toContain("three dependency-free specialist Build roots with distinct roles");
    expect(prompt).toContain("Integration Build depending on every root");
    expect(prompt).toContain("terminal Judge depending on Integration");
    expect(prompt).toContain("Every repair iteration must keep this full topology");
    expect(prompt).toContain("editor_camera_frame");
    expect(prompt).toContain("gameplay foreground");
    expect(prompt).toContain("at least three individual screenshots");
    expect(prompt).toContain("structured iteration with build/play/test checks");
  });

  it("binds loop identity and the bounded final-response drain on loop agent calls", async () => {
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") throw new Error("stop after observing request");
      return {};
    });

    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop polish the game" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    await screen.findByText(/Loop blocked at iteration 1/);

    const agentCall = mocks.rpc.mock.calls.find(([method]) => method === "agent_chat");
    expect(agentCall?.[1]).toMatchObject({
      projectSlug: "demo",
      loopId: expect.stringMatching(/^loop-/),
      finalResponseDrain: true,
      maxTurns: 20,
    });
  });

  it("fills a missing report reference from the first fresh bound graph", async () => {
    mocks.listGraphs.mockResolvedValueOnce([]).mockResolvedValue([{ graphId: "graph-loop" }]);
    mocks.graphStatus.mockResolvedValue(passingGraph());
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") {
        emitEvent?.({
          type: "graph.updated",
          graphId: "graph-loop",
          phase: "created",
          graph: passingGraph(),
        } as unknown as AgentEvent);
        return { sessionId: "session-1", reply: "DONE", toolCalls: [] };
      }
      return {};
    });

    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop polish the game" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("✔ loop complete in 1 iterations")).toBeTruthy();
    const reportStarts = mocks.rpc.mock.calls.filter(([method]) => method === "loop_report_start");
    expect(reportStarts).toHaveLength(2);
    expect(reportStarts[1]?.[1]).toMatchObject({
      slug: "demo",
      objective: "polish the game",
      reference: "Geometry Wars 3",
    });
  });

  it("requires a structured two-pass durable report before loop completion", () => {
    const opened = readyLoopReport();
    expect(validateLoopReportCompletion(opened.report, "demo", "loop-proof")).toEqual({
      accepted: true,
      reason: "durable loop report passed",
    });

    const genericFallback = readyLoopReport();
    genericFallback.report.iterations[1] = {
      ...genericFallback.report.iterations[1],
      outcome: "needs-work",
      agents: [],
      checks: [],
      evidence: [],
      scores: [],
    };
    expect(validateLoopReportCompletion(genericFallback.report, "demo", "loop-proof")).toMatchObject({
      accepted: false,
      reason: "progress report has no passed iteration",
    });
  });

  it("recognizes only a successful iteration write for the current loop", () => {
    expect(
      hasRecordedLoopIteration(
        [
          {
            name: "loop_report_iteration",
            status: "done",
            arguments: { slug: "demo", loopId: "loop-current", iteration: {} },
          },
        ],
        "demo",
        "loop-current",
      ),
    ).toBe(true);
    expect(
      hasRecordedLoopIteration(
        [
          {
            name: "loop_report_iteration",
            status: "done",
            arguments: { iteration: { outcome: "passed" } },
          },
        ],
        "demo",
        "loop-current",
      ),
    ).toBe(true);
    expect(
      hasRecordedLoopIteration(
        [
          {
            name: "loop_report_iteration",
            status: "error",
            arguments: { slug: "demo", loopId: "loop-current" },
          },
        ],
        "demo",
        "loop-current",
      ),
    ).toBe(false);
    expect(
      hasRecordedLoopIteration(
        [
          {
            name: "loop_report_iteration",
            status: "done",
            arguments: { slug: "demo", loopId: "loop-other" },
          },
        ],
        "demo",
        "loop-current",
      ),
    ).toBe(false);
    expect(
      hasRecordedLoopIteration(
        [{ name: "loop_report_iteration", arguments: { slug: "demo", loopId: "loop-current" } }],
        "demo",
        "loop-current",
      ),
    ).toBe(false);
  });

  it("falls back exactly once when the agent's iteration write failed", async () => {
    mocks.listGraphs.mockResolvedValueOnce([]).mockResolvedValue([{ graphId: "graph-loop" }]);
    mocks.graphStatus.mockResolvedValue(passingGraph());
    mocks.rpc.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") {
        const loopPrompt = (params?.messages as Array<{ content?: string }> | undefined)?.at(-1)?.content ?? "";
        const loopId = /This is \/loop (loop-[a-z0-9]+)/.exec(loopPrompt)?.[1];
        return {
          sessionId: "session-1",
          reply: "DONE",
          toolCalls: [
            {
              name: "loop_report_iteration",
              status: "error",
              arguments: { slug: "demo", loopId },
            },
          ],
        };
      }
      return {};
    });

    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop polish the game" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("✔ loop complete in 1 iterations")).toBeTruthy();
    expect(mocks.rpc.mock.calls.filter(([method]) => method === "loop_report_iteration")).toHaveLength(1);
  });

  it("does not duplicate a successful agent-recorded iteration", async () => {
    mocks.listGraphs.mockResolvedValueOnce([]).mockResolvedValue([{ graphId: "graph-loop" }]);
    mocks.graphStatus.mockResolvedValue(passingGraph());
    mocks.rpc.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") {
        const loopPrompt = (params?.messages as Array<{ content?: string }> | undefined)?.at(-1)?.content ?? "";
        const loopId = /This is \/loop (loop-[a-z0-9]+)/.exec(loopPrompt)?.[1];
        return {
          sessionId: "session-1",
          reply: "DONE",
          toolCalls: [
            {
              name: "loop_report_iteration",
              status: "done",
              arguments: { slug: "demo", loopId, iteration: { outcome: "passed" } },
            },
          ],
        };
      }
      return {};
    });

    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop polish the game" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("✔ loop complete in 1 iterations")).toBeTruthy();
    expect(mocks.rpc.mock.calls.filter(([method]) => method === "loop_report_iteration")).toHaveLength(0);
  });

  it("keeps the loop running when start, iteration, and terminal report writes fail", async () => {
    let replies = ["Keep working", "DONE"];
    mocks.listGraphs.mockResolvedValueOnce([]).mockResolvedValue([{ graphId: "graph-loop" }]);
    mocks.graphStatus.mockResolvedValue(passingGraph());
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "editor_attach") return {};
      if (method === "loop_report_start" || method === "loop_report_iteration" || method === "loop_report_update") {
        throw new Error(`${method} offline`);
      }
      if (method === "agent_chat") {
        const [started, finished] = activityEvents();
        emitEvent?.(started);
        emitEvent?.(finished);
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { sessionId: "session-1", reply: replies.shift() ?? "DONE", toolCalls: [] };
      }
      return {};
    });

    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop polish the game" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("✔ loop complete in 2 iterations")).toBeTruthy();
    expect(screen.queryByText(/Loop error:/)).toBeNull();
    expect(mocks.rpc.mock.calls.filter(([method]) => method === "agent_chat")).toHaveLength(2);
    expect(mocks.rpc.mock.calls.filter(([method]) => method === "loop_report_start")).toHaveLength(1);
    expect(mocks.rpc.mock.calls.filter(([method]) => method === "loop_report_iteration")).toHaveLength(2);
    expect(mocks.rpc.mock.calls.filter(([method]) => method === "loop_report_update")).toHaveLength(1);

    const iterationCall = mocks.rpc.mock.calls.find(([method]) => method === "loop_report_iteration");
    expect(iterationCall?.[1]).toMatchObject({
      iteration: {
        changedFiles: [{ path: "src/game.ts", additions: 2, deletions: 0 }],
      },
    });
  });

  it("ignores bare DONE and records the fallback iteration as needs-work", async () => {
    mocks.listGraphs.mockResolvedValueOnce([]).mockResolvedValue([{ graphId: "graph-loop" }]);
    mocks.graphStatus.mockResolvedValue({
      ...passingGraph(),
      nodes: passingGraph().nodes.map((node) => ({ ...node, status: "running" })),
      status: "running",
    });
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") return { sessionId: "session-1", reply: "DONE", toolCalls: [] };
      return {};
    });

    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop polish the game" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });

    expect(await screen.findByText(/DONE ignored:/)).toBeTruthy();
    expect(screen.queryByText(/✔ loop complete/)).toBeNull();
    const iterations = mocks.rpc.mock.calls.filter(([method]) => method === "loop_report_iteration");
    expect(iterations[0]?.[1]).toMatchObject({ iteration: { outcome: "needs-work" } });
  });

  it("accepts DONE only after a fresh passing graph is fetched authoritatively", async () => {
    mocks.listGraphs.mockResolvedValueOnce([]).mockResolvedValue([{ graphId: "graph-loop" }]);
    mocks.graphStatus.mockResolvedValue(passingGraph());
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") return { sessionId: "session-1", reply: "DONE", toolCalls: [] };
      return {};
    });

    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop polish the game" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("✔ loop complete in 1 iterations")).toBeTruthy();
    expect(mocks.graphStatus).toHaveBeenCalledWith("graph-loop");
    expect(mocks.openLoopReport).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls.filter(([method]) => method === "loop_report_update")).toHaveLength(1);
  });

  it("reports an iteration failure as blocked without claiming the loop hit its cap", async () => {
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") throw new Error("provider usage limit reached");
      return {};
    });

    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop polish the game" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("Loop blocked at iteration 1: provider usage limit reached")).toBeTruthy();
    expect(screen.queryByText(/loop hit the 25-iteration cap/)).toBeNull();
    expect(mocks.rpc.mock.calls.filter(([method]) => method === "agent_chat")).toHaveLength(1);
    const terminal = mocks.rpc.mock.calls.find(([method]) => method === "loop_report_update");
    expect(terminal?.[1]).toMatchObject({
      update: {
        status: "blocked",
        summary: "Loop blocked at iteration 1: provider usage limit reached",
      },
    });
  });

  it("rejects stale or wrong-session graph proof", () => {
    const startedAt = Date.parse("2026-01-01T00:00:10.000Z");
    const context = {
      loopStartedAtMs: startedAt,
      projectSlug: "demo",
      sessionId: "session-1",
      workspaceRoot: "/tmp/game",
      knownGraphIds: new Set(["graph-stale"]),
    };
    expect(validateLoopGraphCompletion(passingGraph({ graphId: "graph-stale" }), context).accepted).toBe(false);
    expect(
      validateLoopGraphCompletion(
        passingGraph({ graphId: "graph-fresh", ownerSession: "session-foreign" }),
        context,
      ).accepted,
    ).toBe(false);
  });

  it("rejects a shallow graph without three roots, integration, and a terminal judge edge", () => {
    const context = {
      loopStartedAtMs: Date.now() - 1_000,
      projectSlug: "demo",
      sessionId: "session-1",
      workspaceRoot: "/tmp/game",
      knownGraphIds: new Set<string>(),
      observedGraphIds: new Set(["graph-loop"]),
    };
    const shallow = passingGraph({
      nodes: passingGraph().nodes.filter((node) => node.id !== "tests" && node.id !== "integration").map((node) =>
        node.id === "judge" ? { ...node, deps: ["gameplay", "visuals"] } : node,
      ),
    });

    expect(validateLoopGraphCompletion(shallow, context)).toMatchObject({
      accepted: false,
      reason: "graph needs three independent specialist build roots",
    });

    const noIntegration = passingGraph({
      nodes: passingGraph().nodes.filter((node) => node.id !== "integration").map((node) =>
        node.id === "judge" ? { ...node, deps: ["gameplay", "visuals", "tests"] } : node,
      ),
    });
    expect(validateLoopGraphCompletion(noIntegration, context)).toMatchObject({
      accepted: false,
      reason: "graph needs a separate integration build depending on every root",
    });
  });

  it("persists each synthetic loop user message before agent_chat", async () => {
    mocks.listGraphs.mockResolvedValueOnce([]).mockResolvedValue([{ graphId: "graph-loop" }]);
    mocks.graphStatus.mockResolvedValue(passingGraph());
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") {
        const saved = mocks.saveSession.mock.calls.at(-1)?.[0] as { messages?: AgentMessage[] } | undefined;
        expect(saved?.messages?.some((message) => message.role === "user" && message.content.includes("This is /loop"))).toBe(
          true,
        );
        return { sessionId: "session-1", reply: "DONE", toolCalls: [] };
      }
      return {};
    });

    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop polish the game" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("✔ loop complete in 1 iterations")).toBeTruthy();
    const saved = mocks.saveSession.mock.calls.map(([input]) => input as { messages?: AgentMessage[] });
    expect(saved.some((input) => (input.messages ?? []).filter((message) => message.role === "user").length === 1)).toBe(
      true,
    );
  });

  it("extracts fallback files from the selected current activity turn", () => {
    const messages: AgentMessage[] = [
      {
        role: "tool",
        tool: "file_edit",
        turnId: "loop-turn",
        activity: { path: "src/one.ts", operation: "edit", additions: 2, deletions: 1, diff: [] },
        content: "Edited one",
      },
      {
        role: "tool",
        tool: "file_edit",
        turnId: "other-turn",
        activity: { path: "src/other.ts", operation: "edit", additions: 8, deletions: 0, diff: [] },
        content: "Edited other",
      },
    ];

    expect(fallbackLoopChangedFiles(messages, "loop-turn")).toEqual([
      { path: "src/one.ts", additions: 2, deletions: 1 },
    ]);
  });

  it("turns report RPC errors into an undefined result without throwing", async () => {
    const failure = new Error("report unavailable");
    mocks.rpc.mockRejectedValueOnce(failure);
    const onFailure = vi.fn();

    await expect(reportLoopBestEffort("loop_report_update", {}, onFailure)).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledWith(failure);
  });
});

describe("isTransientRpcError", () => {
  it("matches the browser fetch transport failure", () => {
    expect(isTransientRpcError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientRpcError(new Error("Load failed"))).toBe(true);
    expect(isTransientRpcError(new Error("NetworkError when attempting to fetch resource"))).toBe(true);
  });

  it("matches Vite proxy / HTTP 5xx envelopes", () => {
    // Explicit 5xx from the Vite proxy is the only RPC failure we treat as
    // transient. Generic `RPC <method> failed`/JSON-RPC app errors stay
    // terminal so we never retry out of a real provider/auth failure.
    expect(isTransientRpcError(new Error("502 Bad Gateway"))).toBe(true);
    expect(isTransientRpcError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isTransientRpcError(new Error("504 Gateway Timeout"))).toBe(true);
    expect(isTransientRpcError(new Error("RPC loop_report_update failed"))).toBe(false);
  });

  it("fails closed on provider/auth/usage errors", () => {
    expect(isTransientRpcError(new Error("provider usage limit reached"))).toBe(false);
    expect(isTransientRpcError(new Error("401 Unauthorized"))).toBe(false);
    expect(isTransientRpcError(new Error("invalid api key"))).toBe(false);
    expect(isTransientRpcError(new Error(""))).toBe(false);
    expect(isTransientRpcError(undefined)).toBe(false);
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

describe("loop recovery from transient fetch loss", () => {
  it("retries transient agent_chat failures and continues the loop", async () => {
    let attempts = 0;
    let replies = ["DONE", "DONE"];
    mocks.listGraphs.mockResolvedValueOnce([]).mockResolvedValue([{ graphId: "graph-loop" }]);
    mocks.graphStatus.mockResolvedValue(passingGraph());
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") {
        attempts += 1;
        if (attempts <= 2) throw new TypeError("Failed to fetch");
        return { sessionId: "session-1", reply: replies.shift() ?? "DONE", toolCalls: [] };
      }
      return {};
    });

    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop polish the game" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    expect(await screen.findByText("✔ loop complete in 1 iterations", {}, { timeout: 3_000 })).toBeTruthy();
    expect(attempts).toBe(3);
    expect(screen.queryByText(/Loop blocked/)).toBeNull();
  });

  it("settles running tool rows and persists the transcript before the terminal report", async () => {
    let chatCalls = 0;
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") {
        chatCalls += 1;
        if (chatCalls === 1) {
          const [started] = activityEvents();
          emitEvent?.(started);
          await new Promise((resolve) => setTimeout(resolve, 0));
          throw new TypeError("Failed to fetch");
        }
        throw new Error("Failed to fetch");
      }
      return {};
    });

    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop polish the game" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });

    expect(
      await screen.findByText(/Loop blocked at iteration 1: editor disconnected/, {}, { timeout: 3_000 }),
    ).toBeTruthy();
    const lastSave = mocks.saveSession.mock.calls.at(-1)?.[0] as { messages: AgentMessage[] };
    expect(lastSave).toBeDefined();
    const settledEdit = lastSave.messages.find(
      (message) => message.role === "tool" && message.tool === "file_edit",
    );
    expect(settledEdit).toMatchObject({ status: "error" });
    const terminal = mocks.rpc.mock.calls.find(([method]) => method === "loop_report_update");
    expect(terminal?.[1]).toMatchObject({
      update: {
        status: "blocked",
        summary: expect.stringMatching(/Loop blocked at iteration 1: editor disconnected/),
      },
    });
  });

  it("fails closed on a provider usage error and does not retry", async () => {
    let attempts = 0;
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") {
        attempts += 1;
        throw new Error("provider usage limit reached");
      }
      return {};
    });

    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop polish the game" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    expect(await screen.findByText("Loop blocked at iteration 1: provider usage limit reached")).toBeTruthy();
    expect(attempts).toBe(1);
    const terminal = mocks.rpc.mock.calls.find(([method]) => method === "loop_report_update");
    expect(terminal?.[1]).toMatchObject({
      update: {
        status: "blocked",
        summary: "Loop blocked at iteration 1: provider usage limit reached",
      },
    });
  });

  it("continues after a graph-blocked iteration and recovers via a transient fetch blip", async () => {
    let attempts = 0;
    let replies = ["DONE", "DONE"];
    // Iteration 1: agent replies DONE but the graph is still blocked at the
    // attempt cap (validating graph proof fails). Iteration 2: a transient
    // fetch error is recovered from and the loop completes successfully.
    mocks.listGraphs.mockResolvedValueOnce([]).mockResolvedValue([{ graphId: "graph-loop" }]);
    mocks.graphStatus
      .mockResolvedValueOnce(
        passingGraph({
          status: "running",
          nodes: passingGraph().nodes.map((node) => ({ ...node, status: "running" })),
        }),
      )
      .mockResolvedValueOnce(passingGraph());
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") {
        attempts += 1;
        if (attempts === 2) throw new TypeError("Failed to fetch");
        return { sessionId: "session-1", reply: replies.shift() ?? "DONE", toolCalls: [] };
      }
      return {};
    });

    renderPanel();
    const prompt = screen.getByRole("textbox", { name: "Agent prompt" });
    fireEvent.change(prompt, { target: { value: "/loop polish the game" } });
    fireEvent.keyDown(prompt, { key: "Enter", code: "Enter" });
    expect(await screen.findByText("✔ loop complete in 2 iterations", {}, { timeout: 3_000 })).toBeTruthy();
    expect(attempts).toBe(3);
    expect(screen.queryByText(/Loop blocked/)).toBeNull();
  });
});
