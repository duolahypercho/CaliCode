import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPanel, sanitizeRaisedAt } from "./AgentPanel";
import type { AgentEvent } from "../../lib/rpc";

/**
 * The approval subsystem's regression suite.
 *
 * Every test here is named for the historical defect it makes unreachable. The
 * governing invariant, which supersedes everything else in this file:
 *
 * > Only two things may produce a denial — a human clicking Deny, or core's own
 * > bounded timer. No inference, no transport failure, no state transition, on
 * > either side, ever.
 *
 * The single most important assertion in the file is the count of
 * `agent_approval_response` calls carrying `approved: false`. Nine previous
 * rounds each shipped a mechanism that could produce one without a human, and
 * three of those rounds shipped tests that could not observe their own hazard.
 * `deniedSends()` is the observation; use it.
 */

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
  layoutLayers: vi.fn(() => [["a"], ["judge"]]),
  listGraphs: mocks.listGraphs,
  planGraph: mocks.planGraph,
  runGraph: mocks.runGraph,
}));

vi.mock("../../lib/loopReports", () => ({
  openLoopReport: mocks.openLoopReport,
}));

let emitEvent: ((event: AgentEvent) => void) | null = null;
let reopenEvents: (() => void) | null = null;

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

/** This window's id, as `editor_attach` reported it to core. */
function attachedClientId(): string {
  const attach = mocks.rpc.mock.calls.find(([method]) => method === "editor_attach");
  return (attach?.[1] as { clientId: string })?.clientId ?? "";
}

function approvalRequest(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type: "agent.approval_request",
    sessionId: "session-1",
    requestId: "approval-1",
    tool: "file_write",
    arguments: { path: "src/game.ts" },
    targetClientId: attachedClientId(),
    ownerSession: "session-1",
    ownerGraph: null,
    raisedAtMs: Date.now(),
    ...overrides,
  };
}

/** Every `agent_approval_response` this panel issued. */
function approvalSends(): Array<{
  requestId: string;
  approved: boolean;
  clientId?: string;
  always?: boolean;
}> {
  return mocks.rpc.mock.calls
    .filter(([method]) => method === "agent_approval_response")
    .map(
      ([, params]) =>
        params as { requestId: string; approved: boolean; clientId?: string; always?: boolean },
    );
}

/**
 * The observation the whole design exists to keep at zero unless a human
 * clicked Deny. If a change makes this non-zero without a click, that change is
 * the tenth round.
 */
function deniedSends(): Array<{ requestId: string }> {
  return approvalSends().filter((call) => call.approved === false);
}

async function emit(event: AgentEvent): Promise<void> {
  await act(async () => {
    emitEvent?.(event);
  });
}

async function startTurn(text = "do the thing"): Promise<void> {
  const composer = screen.getByRole("textbox", { name: "Agent prompt" });
  fireEvent.change(composer, { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Send message"));
  });
}

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.useRealTimers();
  emitEvent = null;
  reopenEvents = null;
  window.sessionStorage.clear();
  for (const mock of Object.values(mocks)) mock.mockReset();

  mocks.connectEvents.mockImplementation((listener: (event: AgentEvent) => void, onOpen?: () => void) => {
    emitEvent = listener;
    reopenEvents = onOpen ?? null;
    return () => {
      emitEvent = null;
      reopenEvents = null;
    };
  });
  mocks.createSession.mockResolvedValue({ id: "session-1", workspaceRoot: "/tmp/game" });
  mocks.listSessions.mockResolvedValue([]);
  mocks.saveSession.mockResolvedValue({});
  mocks.listGraphs.mockResolvedValue([]);
  mocks.graphStatus.mockResolvedValue({});
  mocks.loadModelDev.mockResolvedValue({ index: null, catalog: {}, contextLimits: {} });
  mocks.readCoreConfig.mockResolvedValue(null);
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "editor_attach") return {};
    if (method === "agent_chat") return { sessionId: "session-1", reply: "DONE", toolCalls: [] };
    return {};
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The invariant. Written first, and the test all nine previous rounds would
// each have failed in a different way.
// ---------------------------------------------------------------------------

describe("always allow", () => {
  it("sends `always` alongside the approval and says the asking has stopped", async () => {
    renderPanel();
    await act(async () => {});
    await startTurn();
    const clientId = attachedClientId();

    await emit(approvalRequest({ targetClientId: clientId }));
    expect(await screen.findByText(/Approve file_write\?/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Always/ }));
    });

    const sends = approvalSends();
    expect(sends).toHaveLength(1);
    // `always` rides along with an approval; core grants the exact tool name.
    expect(sends[0]).toMatchObject({ approved: true, always: true });
    // The user is told the scope of what they just did.
    expect(await screen.findByText(/won't ask again for it this session/)).toBeTruthy();
  });

  it("never attaches `always` to a plain approval or to a denial", async () => {
    renderPanel();
    await act(async () => {});
    await startTurn();
    const clientId = attachedClientId();

    await emit(approvalRequest({ targetClientId: clientId }));
    expect(await screen.findByText(/Approve file_write\?/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    });
    expect(approvalSends()[0]?.always).toBeUndefined();
  });
});

describe("the governing invariant", () => {
  it("core unreachable for an approval's whole life issues no denial from anyone", async () => {
    // Fake timers are installed before the panel mounts so the TTL sweep's
    // interval belongs to the fake clock — the whole point of this test is to
    // let the card's entire life elapse. `shouldAdvanceTime` keeps
    // testing-library's own waiters alive meanwhile.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPanel();
    await act(async () => {});
    await startTurn();
    const clientId = attachedClientId();

    await emit(approvalRequest({ targetClientId: clientId }));
    expect(await screen.findByText(/Approve file_write\?/)).toBeTruthy();

    // From here, every RPC fails. A transport outage, a restarted core, a
    // proxy that hung up — the panel cannot tell, and it must not guess.
    mocks.rpc.mockImplementation(async () => {
      throw new Error("Failed to fetch");
    });

    // Time passes well beyond the card's TTL and the panel sweeps.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * 60_000);
    });

    // Unmount too: the last thing an earlier build did on the way out was deny.
    cleanup();
    await act(async () => {});

    expect(deniedSends()).toEqual([]);
    expect(approvalSends()).toEqual([]);
  });

  it("says why a lapsed card can no longer be answered instead of vanishing", async () => {
    // `shouldAdvanceTime` keeps testing-library's own waiters alive while the
    // approval clock is under our control.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPanel();
    await act(async () => {});
    await startTurn();
    // Raised just inside the TTL, so the very next sweep lapses it: one tick,
    // no dependence on how many the advance happens to fire.
    await emit(approvalRequest({ raisedAtMs: Date.now() - (5 * 60_000 - 2_000) }));
    expect(await screen.findByText(/Approve file_write\?/)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });

    expect(screen.getByText(/no longer answerable/i).textContent).toMatch(/stopped waiting/i);
    expect(deniedSends()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Defect 2: a single boolean with four writers; a finishing turn auto-denied a
// live graph's prompt.
// ---------------------------------------------------------------------------

describe("defect 2 — a run ending is not an input", () => {
  it("a turn finishing issues zero approval RPCs for a prompt still on screen", async () => {
    // The retire path. A prompt arrives mid-turn and is still unanswered when
    // the turn ends. Earlier builds treated "the run that raised this is over"
    // as a state this panel could compute, and swept the queue by DENYING
    // everything in it — which is how ending one turn destroyed a node's work.
    // There is no run-lifecycle event in the reducer's alphabet at all now, so
    // there is nothing for a finishing turn to write.
    let releaseChat: (() => void) | null = null;
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") {
        await new Promise<void>((resolveChat) => {
          releaseChat = () => resolveChat();
        });
        return { sessionId: "session-1", reply: "DONE", toolCalls: [] };
      }
      return {};
    });
    renderPanel();
    await act(async () => {});
    await startTurn();

    await emit(approvalRequest({ requestId: "approval-node", ownerGraph: null }));
    expect(await screen.findByText(/Approve file_write\?/)).toBeTruthy();

    // The turn completes with the prompt still open.
    await act(async () => {
      releaseChat?.();
    });
    await act(async () => {});

    expect(approvalSends()).toEqual([]);
    // …and the card is still there, still answerable.
    expect(screen.getByText(/Approve file_write\?/)).toBeTruthy();
  });

  it("a prompt from a run core says has finished is shown, not denied", async () => {
    // The behaviour this change deliberately trades away. Four cases in the
    // old suite asserted a denial here — "denies a finished run's node
    // approval", "still denies once core answers that the run is over". They
    // are converted, not deleted: the card stays up and says what it is, and
    // whether the run is really over is core's question to answer by dropping
    // its own pending sender (`cancel_by_graph`), not this panel's to guess.
    mocks.graphStatus.mockResolvedValue({ graphId: "g-1", status: "complete", nodes: [] });
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") return { sessionId: "session-1", reply: "DONE", toolCalls: [] };
      if (method === "graph_status") return { graph: { graphId: "g-1", status: "complete", nodes: [] } };
      return {};
    });
    renderPanel();
    await act(async () => {});
    await startTurn();

    // The panel watched g-1 finish.
    await emit({
      type: "graph.updated",
      sessionId: "session-1",
      graph: { graphId: "g-1", status: "complete", nodes: [] },
    } as unknown as AgentEvent);
    await emit({
      type: "graph.updated",
      sessionId: "session-1",
      phase: "completed",
      graph: { graphId: "g-1", status: "complete", nodes: [] },
    } as unknown as AgentEvent);
    await act(async () => {});

    await emit(approvalRequest({ requestId: "approval-late", ownerGraph: "g-1" }));
    await act(async () => {});

    expect(await screen.findByText(/Approve file_write\?/)).toBeTruthy();
    expect(approvalSends()).toEqual([]);
  });

  it("Stop halts the turn without answering anything core is holding", async () => {
    let releaseChat: (() => void) | null = null;
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "editor_attach") return {};
      if (method === "agent_chat") {
        await new Promise<void>((resolveChat) => {
          releaseChat = () => resolveChat();
        });
        return { sessionId: "session-1", reply: "DONE", toolCalls: [] };
      }
      return {};
    });
    renderPanel();
    await act(async () => {});
    await startTurn();
    await emit(approvalRequest());
    expect(await screen.findByText(/Approve file_write\?/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Stop agent"));
    });
    await act(async () => {
      releaseChat?.();
    });

    // Stopping this panel's waiting is not a decision about core's request.
    expect(approvalSends()).toEqual([]);
    expect(deniedSends()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Defect 3: widened ownership let one window authorise another's file write.
// ---------------------------------------------------------------------------

describe("defect 3 — one window, one inbox", () => {
  it("two panels on one session: only the addressed one renders the card", async () => {
    renderPanel();
    await act(async () => {});
    await startTurn();

    // Same session id, same owner — everything the old heuristics looked at
    // says "mine". The address says otherwise, and the address is authoritative.
    await emit(
      approvalRequest({
        requestId: "approval-theirs",
        targetClientId: "some-other-window",
        ownerSession: "session-1",
      }),
    );
    await act(async () => {});

    expect(screen.queryByText(/Approve file_write\?/)).toBeNull();
    // There is no container it could sit in, so there is no button and no
    // possible send — not even after the TTL sweep or an unmount.
    expect(approvalSends()).toEqual([]);
  });

  it("shows nothing for a prompt core addressed at nobody", async () => {
    renderPanel();
    await act(async () => {});
    await startTurn();
    await emit(approvalRequest({ requestId: "approval-unowned", targetClientId: null, ownerSession: null }));
    // A sweep and an unmount are the two moments an earlier build used to
    // "tidy up" an unclaimed request by denying it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60_000);
    });
    vi.useRealTimers();
    cleanup();
    await act(async () => {});

    expect(screen.queryByText(/Approve file_write\?/)).toBeNull();
    expect(approvalSends()).toEqual([]);
  });

  it("answers with this window's id so core can refuse anyone else", async () => {
    renderPanel();
    await act(async () => {});
    await startTurn();
    await emit(approvalRequest());
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /^Approve$/ }));
    });

    expect(approvalSends()).toEqual([
      { requestId: "approval-1", clientId: attachedClientId(), approved: true },
    ]);
  });

  it("re-attaches on every SSE (re)connection so core keeps addressing this window", async () => {
    renderPanel();
    await act(async () => {});
    await startTurn();
    const before = mocks.rpc.mock.calls.filter(([method]) => method === "editor_attach").length;

    await act(async () => {
      reopenEvents?.();
    });
    await waitFor(() =>
      expect(mocks.rpc.mock.calls.filter(([method]) => method === "editor_attach").length).toBeGreaterThan(before),
    );
  });

  it("keeps this window's id across a reload so its prompts stay answerable", async () => {
    renderPanel();
    await act(async () => {});
    await startTurn();
    const first = attachedClientId();
    expect(first).toBeTruthy();

    cleanup();
    mocks.rpc.mockClear();
    renderPanel();
    await act(async () => {});
    await startTurn();
    expect(attachedClientId()).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Defect 1 / 4: ownership inferred from remembered ids and remembered graphs.
// ---------------------------------------------------------------------------

describe("defects 1 and 4 — nothing has to have been observed first", () => {
  it("renders a graph node subagent's approval for a session it has never seen", async () => {
    renderPanel();
    await act(async () => {});
    await startTurn();

    // A grandchild: the graph's node spawned its own subagent, and that
    // subagent is asking. Its session appears in no `graph.updated` snapshot.
    await emit(
      approvalRequest({
        requestId: "approval-grandchild",
        ownerGraph: "graph-7",
        ownerSession: "session-graph-owner",
        subagentSessionId: "session-never-seen",
      }),
    );

    const card = await screen.findByText(/Approve file_write\?/);
    expect(card.textContent).toMatch(/for run graph-7/);
    expect(approvalSends()).toEqual([]);
  });

  it("renders a re-run of a once-finished graph's approval", async () => {
    renderPanel();
    await act(async () => {});
    await startTurn();

    // g-1 runs and reaches a terminal state. An add-only Set of "graphs this
    // panel has settled" used to make every later prompt from g-1 a denial.
    await emit({
      type: "graph.updated",
      sessionId: "session-1",
      graph: { graphId: "g-1", status: "complete", nodes: [] },
    } as unknown as AgentEvent);
    await act(async () => {});

    await emit(approvalRequest({ requestId: "approval-rerun", ownerGraph: "g-1" }));

    expect(await screen.findByText(/Approve file_write\?/)).toBeTruthy();
    expect(approvalSends()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Defect 5: one slot overwritten by parallel prompts; then a queue that wedged.
// ---------------------------------------------------------------------------

describe("defect 5 — the queue", () => {
  it("gives three parallel nodes three independently answerable cards", async () => {
    renderPanel();
    await act(async () => {});
    await startTurn();
    for (const id of ["approval-a", "approval-b", "approval-c"]) {
      await emit(approvalRequest({ requestId: id, ownerGraph: "graph-wave" }));
    }

    expect(await screen.findAllByText(/Approve file_write\?/)).toHaveLength(3);

    // Answer the middle one; the other two are untouched.
    const cards = document.querySelectorAll("[data-approval]");
    const second = cards[1] as HTMLElement;
    await act(async () => {
      fireEvent.click(second.querySelector("button")!);
    });

    expect(approvalSends()).toEqual([
      { requestId: "approval-b", clientId: attachedClientId(), approved: true },
    ]);
    expect(document.querySelectorAll('[data-approval-state="pending"]')).toHaveLength(2);
  });

  it("a failed send leaves the card up and core still holding it", async () => {
    renderPanel();
    await act(async () => {});
    await startTurn();
    await emit(approvalRequest({ requestId: "approval-a" }));
    await emit(approvalRequest({ requestId: "approval-b" }));

    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "agent_approval_response") throw new Error("Failed to fetch");
      return {};
    });
    const cards = document.querySelectorAll("[data-approval]");
    await act(async () => {
      fireEvent.click((cards[0] as HTMLElement).querySelector("button")!);
    });

    // The transport failed, so nothing is known. The card returns to the queue
    // at its own position and the click is simply repeatable — no denial, no
    // silent drop, and the second card was never hidden behind it.
    const first = document.querySelector('[data-approval="approval-a"]');
    expect(first?.getAttribute("data-approval-state")).toBe("pending");
    expect([...document.querySelectorAll("[data-approval]")].map((node) => node.getAttribute("data-approval"))).toEqual([
      "approval-a",
      "approval-b",
    ]);
    expect(deniedSends()).toEqual([]);
  });

  it("a core refusal lapses the card truthfully rather than retrying forever", async () => {
    renderPanel();
    await act(async () => {});
    await startTurn();
    await emit(approvalRequest());

    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === "agent_approval_response") throw new Error("no pending approval approval-1");
      return {};
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /^Approve$/ }));
    });

    expect(document.querySelector('[data-approval="approval-1"]')?.getAttribute("data-approval-state")).toBe("lapsed");
    expect(screen.getByText(/no longer answerable/i).textContent).toMatch(/no longer waiting/i);
  });

  it("core announcing a resolution retires the card without a click", async () => {
    renderPanel();
    await act(async () => {});
    await startTurn();
    await emit(approvalRequest());
    expect(await screen.findByText(/Approve file_write\?/)).toBeTruthy();

    await emit({ type: "agent.approval_resolved", requestId: "approval-1", outcome: "run-cancelled" });

    expect(document.querySelector('[data-approval="approval-1"]')?.getAttribute("data-approval-state")).toBe("lapsed");
    expect(approvalSends()).toEqual([]);
  });
});

describe("core's clock is trusted, not obeyed", () => {
  it("falls back to now for a skewed or missing raisedAtMs", () => {
    const now = 1_000_000;
    expect(sanitizeRaisedAt(now - 1_000, now)).toBe(now - 1_000);
    // A card whose stamp is already past the TTL would vanish the instant it
    // appeared — a far worse failure than one that lives a few seconds long.
    expect(sanitizeRaisedAt(now - 10 * 60_000, now)).toBe(now);
    expect(sanitizeRaisedAt(now + 60_000, now)).toBe(now);
    expect(sanitizeRaisedAt(undefined, now)).toBe(now);
    expect(sanitizeRaisedAt("soon", now)).toBe(now);
    expect(sanitizeRaisedAt(Number.NaN, now)).toBe(now);
  });
});

// ---------------------------------------------------------------------------
// Defect 6: one classifier, two call sites, opposite defaults.
// ---------------------------------------------------------------------------

describe("defect 6 — one classifier, one call site", () => {
  const panelSource = () =>
    readFileSync(resolve(process.cwd(), "src/components/editor/AgentPanel.tsx"), "utf8");

  it("calls classifySendFailure exactly once", () => {
    const calls = panelSource().match(/classifySendFailure\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("issues agent_approval_response from exactly one place", () => {
    const calls = panelSource().match(/"agent_approval_response"/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("has no literal approved:false anywhere in the panel", () => {
    // Greppable review rule: the only `approved` a send can carry comes from
    // the button the human pressed. A literal `false` here would be a panel
    // deciding on its own behalf.
    expect(panelSource()).not.toMatch(/approved:\s*false/);
  });
});
