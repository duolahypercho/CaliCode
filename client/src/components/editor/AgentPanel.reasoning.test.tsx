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

let emitEvent: ((event: AgentEvent) => void) | null = null;

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

/** Send a prompt so the panel opens an activity turn for reasoning to attach to. */
async function startTurn() {
  fireEvent.change(screen.getByLabelText("Agent prompt"), { target: { value: "build a thing" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  for (const mock of Object.values(mocks)) mock.mockReset();
  emitEvent = null;
  mocks.connectEvents.mockImplementation((handler: (event: AgentEvent) => void) => {
    emitEvent = handler;
    return () => {
      emitEvent = null;
    };
  });
  mocks.createSession.mockResolvedValue({ id: "session-1", workspaceRoot: "/tmp/game" });
  mocks.listSessions.mockResolvedValue([]);
  mocks.saveSession.mockResolvedValue({});
  mocks.listGraphs.mockResolvedValue([]);
  mocks.graphStatus.mockResolvedValue({});
  mocks.openLoopReport.mockResolvedValue({ report: null });
  mocks.loadModelDev.mockResolvedValue({ index: null, catalog: {}, contextLimits: {} });
  mocks.readCoreConfig.mockResolvedValue(null);
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "agent_chat") return { sessionId: "session-1", reply: "Done.", toolCalls: [] };
    return {};
  });
});

afterEach(cleanup);

describe("streamed reasoning", () => {
  it("shows the model's thinking in the transcript as it streams", async () => {
    renderPanel();
    await startTurn();

    await act(async () => {
      emitEvent?.({ type: "agent.reasoning", sessionId: "session-1", delta: "First I check " });
      emitEvent?.({ type: "agent.reasoning", sessionId: "session-1", delta: "the scene graph." });
    });

    await waitFor(() => expect(screen.getByText(/First I check the scene graph\./)).toBeTruthy());
  });

  it("keeps reasoning out of the saved transcript", async () => {
    renderPanel();
    await startTurn();
    await act(async () => {
      emitEvent?.({ type: "agent.reasoning", sessionId: "session-1", delta: "secret deliberation" });
    });

    await waitFor(() => expect(mocks.saveSession).toHaveBeenCalled());
    for (const [payload] of mocks.saveSession.mock.calls) {
      const messages = (payload as { messages?: Array<{ content?: string }> }).messages ?? [];
      expect(messages.some((message) => (message.content ?? "").includes("secret deliberation"))).toBe(false);
    }
  });

  it("ignores a worker's reasoning so a fan-out cannot flood the parent", async () => {
    renderPanel();
    await startTurn();
    await act(async () => {
      emitEvent?.({
        type: "agent.reasoning",
        sessionId: "session-1",
        subagentSessionId: "worker-9",
        delta: "worker private thoughts",
      });
    });

    expect(screen.queryByText(/worker private thoughts/)).toBeNull();
  });

  it("drops reasoning addressed to another session", async () => {
    renderPanel();
    await startTurn();
    await act(async () => {
      emitEvent?.({ type: "agent.reasoning", sessionId: "someone-else", delta: "not ours" });
    });

    expect(screen.queryByText(/not ours/)).toBeNull();
  });
});
