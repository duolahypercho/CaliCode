import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPanel } from "./AgentPanel";
import { clearAutoCheckpoints } from "../../lib/checkpoints";
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

/** Index of the first call to `method`, or Infinity when it never happened. */
function firstCallIndex(method: string): number {
  const index = mocks.rpc.mock.calls.findIndex(([name]) => name === method);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

let checkpointSeq = 0;

/**
 * Loop replies that never satisfy the DONE gate. The queue running dry blocks
 * the loop, which is how these tests end a run in a bounded number of turns
 * rather than riding it to the 100-iteration cap.
 */
function stubLoopRpc(replies: string[]) {
  const queue = [...replies];
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "checkpoint_create") {
      checkpointSeq += 1;
      return { id: `cp-${1_700_000_000_000 + checkpointSeq}` };
    }
    if (method === "agent_chat") {
      const reply = queue.shift();
      if (reply === undefined) throw new Error("provider refused the request");
      return { sessionId: "session-1", reply, toolCalls: [] };
    }
    return {};
  });
}

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  checkpointSeq = 0;
  clearAutoCheckpoints();
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
  stubLoopRpc([]);
});

afterEach(cleanup);

describe("automatic restore points", () => {
  // Loop checkpointing moved to core with the driver (`loop_run.rs`); it is
  // covered there by `a_loop_takes_a_restore_point_before_it_edits_anything`
  // and `a_failing_restore_point_does_not_stop_the_loop`, which exercise the
  // real thing rather than a mocked RPC. `/goal` still drives client-side, so
  // the rounds below still test this panel's own checkpointing.
  it("checkpoints before the first goal round", async () => {
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "checkpoint_create") return { id: "cp-1700000000001" };
      if (method === "agent_chat") return { sessionId: "session-1", reply: "worked on it", toolCalls: [] };
      if (method === "goal_evaluate") return { met: true, reason: "verified" };
      return {};
    });
    renderPanel();
    await type("/goal make the starter tests pass");

    await waitFor(() => expect(screen.getByText(/goal met/)).toBeTruthy());
    expect(callsTo("checkpoint_create")).toHaveLength(1);
    expect(firstCallIndex("checkpoint_create")).toBeLessThan(firstCallIndex("agent_chat"));
  });

  it("does not say restore points exist when every checkpoint failed", async () => {
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "checkpoint_create") throw new Error("No space left on device");
      if (method === "agent_chat") return { sessionId: "session-1", reply: "did a thing", toolCalls: [] };
      if (method === "goal_evaluate") return { met: true, reason: "verified" };
      return {};
    });
    renderPanel();
    await type("/goal make the starter tests pass");

    await waitFor(() => expect(screen.getByText(/goal met/)).toBeTruthy());
    expect(screen.queryByText(/restore point/)).toBeNull();
  });

  it("throttles rapid iterations to far fewer checkpoints than turns", async () => {
    // Five back-to-back goal rounds inside one throttle window: only the forced
    // first-round checkpoint may copy the project.
    const verdicts = [
      { met: false, reason: "not yet 1" },
      { met: false, reason: "not yet 2" },
      { met: false, reason: "not yet 3" },
      { met: false, reason: "not yet 4" },
      { met: true, reason: "verified" },
    ];
    const queue = [...verdicts];
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "checkpoint_create") {
        checkpointSeq += 1;
        return { id: `cp-${1_700_000_000_000 + checkpointSeq}` };
      }
      if (method === "agent_chat") return { sessionId: "session-1", reply: "worked on it", toolCalls: [] };
      if (method === "goal_evaluate") return queue.shift() ?? { met: true, reason: "verified" };
      return {};
    });
    renderPanel();
    await type("/goal make the starter tests pass");

    await waitFor(() => expect(screen.getByText(/goal met after 5 checks/)).toBeTruthy());
    expect(callsTo("agent_chat")).toHaveLength(5);
    expect(callsTo("checkpoint_create")).toHaveLength(1);
  });

  it("closes a run by naming the restore points and how to use them", async () => {
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "checkpoint_create") return { id: "cp-1700000000001" };
      if (method === "agent_chat") return { sessionId: "session-1", reply: "worked on it", toolCalls: [] };
      if (method === "goal_evaluate") return { met: true, reason: "verified" };
      return {};
    });
    renderPanel();
    await type("/goal make the starter tests pass");

    const line = await screen.findByText(/1 restore point saved during this run/);
    expect(line.textContent).toContain("/checkpoints");
    expect(line.textContent).toContain("/restore <id> confirm");
  });
});

describe("/checkpoints and /restore", () => {
  it("lists what a blocked run checkpointed, and closes it with the restore line", async () => {
    // Driven through `/goal`, which still checkpoints client-side. `/loop`
    // moved its driver to core, so this panel no longer mints those rows.
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "checkpoint_create") return { id: "cp-1700000000001" };
      if (method === "agent_chat") return { sessionId: "session-1", reply: "worked on it", toolCalls: [] };
      if (method === "goal_evaluate") return { met: true, reason: "verified" };
      return {};
    });
    renderPanel();
    await type("/goal polish the game");

    expect(await screen.findByText(/goal met/)).toBeTruthy();
    expect(await screen.findByText(/1 restore point saved during this run/)).toBeTruthy();

    await type("/checkpoints");
    const listed = await screen.findByText(/Restore points, newest first/);
    expect(listed.textContent).toContain("cp-1700000000001");
    expect(listed.textContent).toContain("before a /goal turn");
    expect(listed.textContent).toContain("polish the game");
  });

  it("says so when nothing has been recorded yet", async () => {
    renderPanel();
    await type("/checkpoints");

    expect(await screen.findByText(/No restore points recorded yet/)).toBeTruthy();
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
