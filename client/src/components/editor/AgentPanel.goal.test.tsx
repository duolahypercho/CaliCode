import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPanel } from "./AgentPanel";
import type { AgentEvent } from "../../lib/rpc";

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

vi.mock("../../lib/rpc", () => ({ rpc: mocks.rpc, connectEvents: mocks.connectEvents }));

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
  layoutLayers: vi.fn(() => []),
  listGraphs: mocks.listGraphs,
  planGraph: mocks.planGraph,
  runGraph: mocks.runGraph,
}));

vi.mock("../../lib/loopReports", () => ({ openLoopReport: mocks.openLoopReport }));

const modelList = {
  active: { provider: "openai", model: "gpt-4.1-mini", baseUrl: "" },
  providers: [{ id: "openai", label: "OpenAI", base_url: "", api_key_env: "", models: ["gpt-4.1-mini"] }],
};

function renderPanel() {
  return render(
    <AgentPanel
      projectSlug="demo"
      workspaceRoot="/tmp/game"
      modelList={modelList}
      browserTools={[]}
      onModelChange={() => {}}
      onLog={() => {}}
    />,
  );
}

async function type(command: string) {
  const prompt = screen.getByLabelText("Agent prompt");
  fireEvent.change(prompt, { target: { value: command } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  });
}

/** agent_chat replies, and goal_evaluate answers from this queue in order. */
function stubRpc(verdicts: Array<{ met: boolean; reason: string }>) {
  const queue = [...verdicts];
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "agent_chat") return { sessionId: "session-1", reply: "worked on it", toolCalls: [] };
    if (method === "goal_evaluate") return queue.shift() ?? { met: true, reason: "done" };
    return {};
  });
}

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.connectEvents.mockImplementation((_handler: (event: AgentEvent) => void) => () => {});
  mocks.createSession.mockResolvedValue({ id: "session-1", workspaceRoot: "/tmp/game" });
  mocks.listSessions.mockResolvedValue([]);
  mocks.saveSession.mockResolvedValue({});
  mocks.listGraphs.mockResolvedValue([]);
  mocks.graphStatus.mockResolvedValue({});
  mocks.openLoopReport.mockResolvedValue({ report: null });
  mocks.loadModelDev.mockResolvedValue({ index: null, catalog: {}, contextLimits: {} });
  mocks.readCoreConfig.mockResolvedValue(null);
  stubRpc([]);
});

afterEach(cleanup);

describe("/goal", () => {
  it("keeps working until the verifier accepts, then clears itself", async () => {
    stubRpc([
      { met: false, reason: "the tests were never run" },
      { met: true, reason: "test output shows 12 passing" },
    ]);
    renderPanel();
    await type("/goal make the starter tests pass");

    await waitFor(() => expect(screen.getByText(/goal met after 2 checks/)).toBeTruthy());
    // The unmet reason is surfaced on the way — once as the status line, once
    // inside the directive it becomes.
    expect(screen.getAllByText(/the tests were never run/).length).toBeGreaterThanOrEqual(1);
    // Two working turns: one to start, one driven by the unmet reason.
    const chats = mocks.rpc.mock.calls.filter(([method]) => method === "agent_chat");
    expect(chats).toHaveLength(2);
  });

  it("feeds the verifier's reason back as the next instruction", async () => {
    stubRpc([{ met: false, reason: "no screenshot was captured" }, { met: true, reason: "screenshot present" }]);
    renderPanel();
    await type("/goal capture a screenshot of the scene");

    await waitFor(() => expect(screen.getByText(/goal met/)).toBeTruthy());
    const chats = mocks.rpc.mock.calls.filter(([method]) => method === "agent_chat");
    const second = JSON.stringify(chats[1]?.[1]);
    expect(second).toContain("no screenshot was captured");
  });

  it("never reports success when the verifier cannot be reached", async () => {
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "agent_chat") return { sessionId: "session-1", reply: "did a thing", toolCalls: [] };
      if (method === "goal_evaluate") throw new Error("core offline");
      return {};
    });
    renderPanel();
    await type("/goal make the tests pass");

    await waitFor(() => expect(screen.getByText(/verifier unavailable/)).toBeTruthy());
    expect(screen.queryByText(/goal met/)).toBeNull();
    // It stops rather than spending the whole budget on a dead verifier.
    const chats = mocks.rpc.mock.calls.filter(([method]) => method === "agent_chat");
    expect(chats).toHaveLength(1);
  });

  it("reports and clears goal state on demand", async () => {
    renderPanel();
    await type("/goal");
    await waitFor(() => expect(screen.getByText(/goal: none/)).toBeTruthy());

    await type("/goal clear");
    await waitFor(() => expect(screen.getByText(/no goal was set/)).toBeTruthy());
  });

  it("keeps a live goal named above the composer until the pill clears it", async () => {
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "agent_chat") return { sessionId: "session-1", reply: "did a thing", toolCalls: [] };
      if (method === "goal_evaluate") throw new Error("core offline");
      return {};
    });
    renderPanel();
    expect(document.querySelector("[data-run-status-pill]")).toBeNull();

    await type("/goal make the starter tests pass");
    await waitFor(() => expect(screen.getByText(/verifier unavailable/)).toBeTruthy());
    const pill = document.querySelector("[data-run-status-pill]");
    expect(pill?.textContent).toContain("Goal");
    expect(pill?.textContent).toContain("make the starter tests pass");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
    });
    await waitFor(() => expect(document.querySelector("[data-run-status-pill]")).toBeNull());
    expect(screen.getByText(/goal cleared/)).toBeTruthy();
  });
});
