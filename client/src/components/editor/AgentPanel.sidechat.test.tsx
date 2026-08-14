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

const onOpenSideChat = vi.fn();

function renderPanel() {
  return render(
    <AgentPanel
      projectSlug="demo"
      workspaceRoot="/tmp/game"
      modelList={modelList}
      browserTools={[]}
      onModelChange={() => {}}
      onLog={() => {}}
      onOpenSideChat={onOpenSideChat}
    />,
  );
}

async function run(command: string) {
  const prompt = screen.getByLabelText("Agent prompt");
  fireEvent.change(prompt, { target: { value: command } });
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
  onOpenSideChat.mockReset();
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "agent_chat") return { sessionId: "session-1", reply: "did it", toolCalls: [] };
    return {};
  });
});

afterEach(cleanup);

describe("/side", () => {
  it("opens another thread every time it is run", async () => {
    renderPanel();

    await run("/side why did that edit fail?");
    await run("/side and what is it doing now?");

    expect(onOpenSideChat).toHaveBeenCalledTimes(2);
    // `fresh` is the whole point: without it the second /side would land in
    // the first thread's composer and overwrite the question waiting there.
    for (const call of onOpenSideChat.mock.calls) {
      expect(call[2]).toEqual({ fresh: true });
    }
    expect(onOpenSideChat.mock.calls[0][0]).toBe("why did that edit fail?");
    expect(onOpenSideChat.mock.calls[1][0]).toBe("and what is it doing now?");
  });

  it("says a side chat was opened, not the side chat", async () => {
    renderPanel();
    await run("/side");
    await waitFor(() => expect(screen.getByText(/Opened a side chat/)).toBeTruthy());
  });
});

describe("picking a command from the menu", () => {
  it("runs a whole command on Enter rather than completing the word", async () => {
    renderPanel();
    const prompt = screen.getByLabelText("Agent prompt") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(prompt, { target: { value: "/sid", selectionStart: 4, selectionEnd: 4 } });
    });
    await act(async () => {
      fireEvent.keyDown(prompt, { key: "Enter" });
    });

    expect(onOpenSideChat).toHaveBeenCalledTimes(1);
    expect(onOpenSideChat.mock.calls[0][2]).toEqual({ fresh: true });
    expect(prompt.value).toBe("");
  });

  it("still completes a command that has nothing to run without", async () => {
    renderPanel();
    const prompt = screen.getByLabelText("Agent prompt") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(prompt, { target: { value: "/loo", selectionStart: 4, selectionEnd: 4 } });
    });
    await act(async () => {
      fireEvent.keyDown(prompt, { key: "Enter" });
    });

    // /loop without a goal would be a no-op with an error line; the word is
    // completed and the caret waits after it instead.
    expect(prompt.value).toBe("/loop ");
  });

  it("leaves Tab completing, so a question can follow /side", async () => {
    renderPanel();
    const prompt = screen.getByLabelText("Agent prompt") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(prompt, { target: { value: "/sid", selectionStart: 4, selectionEnd: 4 } });
    });
    await act(async () => {
      fireEvent.keyDown(prompt, { key: "Tab" });
    });

    expect(onOpenSideChat).not.toHaveBeenCalled();
    expect(prompt.value).toBe("/side ");
  });
});

describe("picking a command typed mid-message", () => {
  it("completes instead of running, so the message survives", async () => {
    renderPanel();
    const prompt = screen.getByLabelText("Agent prompt") as HTMLTextAreaElement;
    const typed = "fix the jump then /sid";
    await act(async () => {
      fireEvent.change(prompt, {
        target: { value: typed, selectionStart: typed.length, selectionEnd: typed.length },
      });
    });
    await act(async () => {
      fireEvent.keyDown(prompt, { key: "Enter" });
    });

    expect(onOpenSideChat).not.toHaveBeenCalled();
    expect(prompt.value).toBe("fix the jump then /side ");
  });
});
