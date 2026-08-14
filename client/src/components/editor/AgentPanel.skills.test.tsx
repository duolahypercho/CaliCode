import type React from "react";
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

const SKILLS = [
  {
    name: "playtest",
    description: "Drive the game and report what broke",
    scope: "global",
    path: "/skills/playtest.md",
    enabled: true,
  },
  {
    name: "shipcheck",
    description: "Disabled, so never offered",
    scope: "global",
    path: "/skills/shipcheck.md",
    enabled: false,
  },
];

function renderPanel(overrides: Partial<React.ComponentProps<typeof AgentPanel>> = {}) {
  return render(
    <AgentPanel
      projectSlug="demo"
      workspaceRoot="/tmp/game"
      modelList={modelList}
      browserTools={[]}
      onModelChange={() => {}}
      onLog={() => {}}
      {...overrides}
    />,
  );
}

/** Type into the composer, caret at the end, the way a keystroke leaves it. */
async function typeInput(text: string) {
  const prompt = screen.getByLabelText("Agent prompt") as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(prompt, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
  });
  return prompt;
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
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "skill_list") return { skills: SKILLS };
    if (method === "agent_chat") return { sessionId: "session-1", reply: "did it", toolCalls: [] };
    return {};
  });
});

afterEach(cleanup);

describe("skills in the slash menu", () => {
  it("offers installed skills beside the built-in commands", async () => {
    renderPanel();
    await typeInput("/");

    await waitFor(() => expect(screen.getByText("/playtest")).toBeTruthy());
    expect(screen.getByText("Drive the game and report what broke")).toBeTruthy();
    expect(screen.getByText("/loop")).toBeTruthy();
    // A disabled skill is not in core's prompt index either — the agent could
    // not load it, so the menu must not offer it.
    expect(screen.queryByText("/shipcheck")).toBeNull();
  });

  it("runs the picked skill as a turn that names it", async () => {
    renderPanel();
    await typeInput("/playtest check the boss arena");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });

    await waitFor(() => {
      const chats = mocks.rpc.mock.calls.filter(([method]) => method === "agent_chat");
      expect(chats).toHaveLength(1);
      expect(JSON.stringify(chats[0]?.[1])).toContain("Use the playtest skill: check the boss arena");
    });
  });
});

describe("Enter on a bare command", () => {
  const pressEnter = async (prompt: HTMLTextAreaElement) => {
    await act(async () => {
      fireEvent.keyDown(prompt, { key: "Enter" });
    });
  };
  const chatCalls = () => mocks.rpc.mock.calls.filter(([method]) => method === "agent_chat");

  it("completes a skill instead of spending a turn on an empty task", async () => {
    renderPanel();
    const prompt = await typeInput("/playtest");
    await waitFor(() => expect(screen.getAllByText("/playtest").length).toBeGreaterThan(0));

    await pressEnter(prompt);

    expect(prompt.value).toBe("/playtest ");
    expect(chatCalls()).toHaveLength(0);
  });

  it("still sends once the task is typed after it", async () => {
    renderPanel();
    const prompt = await typeInput("/playtest check the boss arena");
    await pressEnter(prompt);

    await waitFor(() => {
      const chats = chatCalls();
      expect(chats).toHaveLength(1);
      expect(JSON.stringify(chats[0]?.[1])).toContain("Use the playtest skill: check the boss arena");
    });
  });

  it("completes a command that is missing a required argument", async () => {
    renderPanel();
    const prompt = await typeInput("/loop");
    await waitFor(() => expect(screen.getAllByText("/loop").length).toBeGreaterThan(0));

    await pressEnter(prompt);

    expect(prompt.value).toBe("/loop ");
    expect(chatCalls()).toHaveLength(0);
  });

  it("completes a command whose argument is optional, so instructions can follow", async () => {
    // /compact acted the instant the word was spelled, leaving no room for the
    // instructions it takes. Every command but /side now waits.
    renderPanel();
    const prompt = await typeInput("/compact");
    await waitFor(() => expect(screen.getAllByText("/compact").length).toBeGreaterThan(0));

    await pressEnter(prompt);

    expect(prompt.value).toBe("/compact ");
    expect(mocks.rpc.mock.calls.filter(([method]) => method === "session_compact")).toHaveLength(0);
  });

  it("runs on the second Enter, once the command is already completed", async () => {
    // Completing is a pause, not a wall: Enter again on the completed `/name `
    // runs it, so nothing became unreachable from the keyboard.
    renderPanel();
    const prompt = await typeInput("/playtest");
    await pressEnter(prompt);
    expect(prompt.value).toBe("/playtest ");
    expect(chatCalls()).toHaveLength(0);

    await pressEnter(prompt);

    await waitFor(() => expect(chatCalls()).toHaveLength(1));
  });

  it("opens the side chat on one keystroke, the documented exception", async () => {
    // The side chat is a workspace tab owned above this panel, so the prop is
    // the observable: it firing is what "Enter ran the command" means here.
    const onOpenSideChat = vi.fn();
    renderPanel({ onOpenSideChat });
    const prompt = await typeInput("/side");
    await waitFor(() => expect(screen.getAllByText("/side").length).toBeGreaterThan(0));

    await pressEnter(prompt);

    expect(onOpenSideChat).toHaveBeenCalledTimes(1);
    // Opened empty, not completed into the composer and not sent as a turn.
    expect(prompt.value).toBe("");
    expect(chatCalls()).toHaveLength(0);
  });
});

describe("the slash menu follows the caret", () => {
  it("opens for a command typed mid-message", async () => {
    renderPanel();
    await typeInput("add a double jump then /play");

    await waitFor(() => expect(screen.getByText("/playtest")).toBeTruthy());
  });

  it("completes in place instead of replacing the message", async () => {
    renderPanel();
    const prompt = await typeInput("add a double jump then /play");
    await waitFor(() => expect(screen.getByText("/playtest")).toBeTruthy());

    await act(async () => {
      fireEvent.mouseDown(screen.getByText("/playtest"));
    });
    expect(prompt.value).toBe("add a double jump then /playtest ");
  });

  it("stays closed for a slash inside a word", async () => {
    renderPanel();
    await typeInput("look at src/li");

    await waitFor(() => expect(screen.queryByText("/loop")).toBeNull());
  });
});
