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

function renderPanel(workspaceRoot: string | null = "/tmp/game") {
  return render(
    <AgentPanel
      projectSlug="demo"
      workspaceRoot={workspaceRoot}
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

function callsTo(method: string) {
  return mocks.rpc.mock.calls.filter(([name]) => name === method);
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
  mocks.rpc.mockResolvedValue({});
});

afterEach(cleanup);

describe("/checkpoints and /restore", () => {
  it("lists the core-owned restore points that survive reloads", async () => {
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "checkpoint_list") {
        return {
          checkpoints: [{ id: "git-1700000000001", kind: "git", createdAtMs: 1_700_000_000_001 }],
        };
      }
      return {};
    });
    renderPanel();
    await type("/checkpoints");
    const listed = await screen.findByText(/Restore points, newest first/);
    expect(listed.textContent).toContain("git-1700000000001");
    expect(listed.textContent).toContain("git snapshot");
    expect(callsTo("checkpoint_list")).toHaveLength(1);
  });

  it("says so when nothing has been recorded yet", async () => {
    renderPanel();
    await type("/checkpoints");

    expect(await screen.findByText(/No restore points exist yet/)).toBeTruthy();
    expect(callsTo("checkpoint_restore")).toHaveLength(0);
  });

  it("never reverts without confirmation, and names what would be overwritten", async () => {
    renderPanel();
    await type("/restore cp-1700000000001");

    const warning = await screen.findByText(/will overwrite this game's project.json/);
    expect(warning.textContent).toContain("cannot be undone");
    expect(warning.textContent).toContain("/restore cp-1700000000001 confirm");
    expect(callsTo("checkpoint_restore")).toHaveLength(0);
  });

  it("warns that an attached workspace folder is not covered", async () => {
    renderPanel("/tmp/game");
    await type("/restore cp-1700000000001");

    const warning = await screen.findByText(/will overwrite this game's project.json/);
    expect(warning.textContent).toContain("does NOT restore the attached workspace folder");
  });

  it("reverts only on the confirmed second send", async () => {
    renderPanel();
    await type("/restore cp-1700000000001");
    expect(callsTo("checkpoint_restore")).toHaveLength(0);

    await type("/restore cp-1700000000001 confirm");
    await waitFor(() => expect(callsTo("checkpoint_restore")).toHaveLength(1));
    expect(callsTo("checkpoint_restore")[0]?.[1]).toEqual({ slug: "demo", id: "cp-1700000000001" });
    expect(await screen.findByText(/restored cp-1700000000001/)).toBeTruthy();
  });

  it("reports a failed revert instead of claiming the project came back", async () => {
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "checkpoint_restore") throw new Error("checkpoint cp-nope not found");
      return {};
    });
    renderPanel();
    await type("/restore cp-nope confirm");

    expect(await screen.findByText(/restore failed: checkpoint cp-nope not found/)).toBeTruthy();
    expect(screen.queryByText(/^restored /)).toBeNull();
  });

  it("rejects a malformed /restore rather than guessing an id", async () => {
    renderPanel();
    await type("/restore cp-1700000000001 yes please");

    expect(await screen.findByText(/Usage: \/restore <checkpoint-id>/)).toBeTruthy();
    expect(callsTo("checkpoint_restore")).toHaveLength(0);
  });
});
