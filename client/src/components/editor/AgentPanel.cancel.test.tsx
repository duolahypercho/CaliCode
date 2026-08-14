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

/**
 * A turn that never answers on its own, so Stop is the only thing that can end
 * it — the same shape as the real failure: core still working, client waiting.
 */
function stubHangingTurn() {
  mocks.rpc.mockImplementation(
    async (method: string, _params?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      if (method === "agent_chat") {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      return {};
    },
  );
}

async function send(text: string) {
  const prompt = screen.getByLabelText("Agent prompt");
  fireEvent.change(prompt, { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
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
  stubHangingTurn();
});

afterEach(cleanup);

describe("Stop", () => {
  it("tells core to cancel the run, not just this end of the socket", async () => {
    renderPanel();
    await send("build me a level");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Stop agent"));
    });

    await waitFor(() => {
      const cancels = mocks.rpc.mock.calls.filter(([method]) => method === "agent_cancel");
      expect(cancels).toHaveLength(1);
      expect(cancels[0]?.[1]).toMatchObject({ sessionId: "session-1" });
    });
  });

  it("labels the stopped turn Stopped, not Completed", async () => {
    renderPanel();
    await send("build me a level");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Stop agent"));
    });

    // Driving this headlessly is what caught it: the turn summary read
    // "✔ Completed" directly above its own "Turn cancelled" line.
    await waitFor(() => expect(screen.getByText("Stopped")).toBeTruthy());
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("says Stopping once — the tool row draws its own glyph", async () => {
    renderPanel();
    await send("build me a level");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Stop agent"));
    });

    const line = await screen.findByText(/Stopping — finishing the current step/);
    expect(line.textContent?.startsWith("■")).toBe(false);
  });

  it("does not answer a pending approval on the way out", async () => {
    renderPanel();
    await send("build me a level");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Stop agent"));
    });

    await waitFor(() => {
      expect(mocks.rpc.mock.calls.some(([method]) => method === "agent_cancel")).toBe(true);
    });
    // Stopping this panel's turn is not a decision about a request core is
    // holding — denying "on the way out" is how a stop once destroyed a
    // running graph's work.
    expect(mocks.rpc.mock.calls.some(([method]) => method === "agent_approval_response")).toBe(false);
  });

  it("survives a stop that lands after the turn already finished", async () => {
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "agent_chat") return { sessionId: "session-1", reply: "done", toolCalls: [] };
      // Core answers `found: false` rather than raising: the press racing the
      // loop is ordinary, and must not surface as an error to the user.
      if (method === "agent_cancel") return { sessionId: "session-1", found: false, cancelled: false };
      return {};
    });
    renderPanel();
    await send("build me a level");

    await waitFor(() => expect(screen.getByText("done")).toBeTruthy());
    // The run is over, so Stop has retired itself.
    expect(screen.queryByLabelText("Stop agent")).toBeNull();
  });
});
