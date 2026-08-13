import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { classifySendFailure, route, type RouterIdentity } from "./approvalRouter";
import {
  APPROVAL_EVENT_KINDS,
  APPROVAL_TTL_MS,
  MAX_QUEUED_APPROVALS,
  SETTLED_LINGER_MS,
  emptyStore,
  headApproval,
  reduce,
  visibleApprovals,
  type ApprovalEvent,
  type ApprovalStore,
  type RequestState,
} from "./approvalStore";

const MINE: RouterIdentity = { clientId: "window-a", sessionId: "session-a" };

function arrived(requestId: string, overrides: Partial<{ graphLabel: string | null; raisedAtMs: number }> = {}): ApprovalEvent {
  return {
    kind: "Arrived",
    requestId,
    tool: "file_write",
    arguments: { path: "a.txt" },
    graphLabel: overrides.graphLabel ?? null,
    raisedAtMs: overrides.raisedAtMs ?? 1_000,
  };
}

function stateOf(store: ApprovalStore, requestId: string): RequestState | "absent" {
  return store.entries.get(requestId)?.state ?? "absent";
}

describe("route", () => {
  // Defect 1: ownership was inferred from previously-seen session ids, so a
  // graph node's own subagent — which appears in no snapshot — was
  // misattributed to whatever turn the panel had going.
  it("routes a grandchild's approval from the stamp alone", () => {
    // Nothing about this event is a session id this panel has ever seen.
    expect(
      route(
        { targetClientId: "window-a", ownerSession: "session-graph-owner" },
        { clientId: "window-a", sessionId: "session-something-else" },
      ),
    ).toBe("mine");
  });

  it("is a table over address, owner, and identity", () => {
    const cases: Array<[string, ReturnType<typeof route>]> = [
      // A present address is authoritative and never falls through.
      ["addressed here", route({ targetClientId: "window-a", ownerSession: "session-a" }, MINE)],
      ["addressed elsewhere", route({ targetClientId: "window-b", ownerSession: "session-a" }, MINE)],
      ["addressed at nobody", route({ targetClientId: null, ownerSession: "session-a" }, MINE)],
      ["addressed here, no client id", route({ targetClientId: "window-a" }, { clientId: null, sessionId: "session-a" })],
      ["empty address", route({ targetClientId: "" }, MINE)],
      // Field absent: legacy fallback on the owner stamp.
      ["legacy owner matches", route({ ownerSession: "session-a" }, MINE)],
      ["legacy owner differs", route({ ownerSession: "session-b" }, MINE)],
      ["legacy owner null", route({ ownerSession: null }, MINE)],
      ["legacy owner blank", route({ ownerSession: "   " }, MINE)],
      ["legacy owner non-string", route({ ownerSession: 7 }, MINE)],
      ["legacy, no session", route({ ownerSession: "session-a" }, { clientId: "window-a", sessionId: null })],
      ["legacy, nothing at all", route({}, MINE)],
    ];
    expect(Object.fromEntries(cases)).toEqual({
      "addressed here": "mine",
      "addressed elsewhere": "not-mine",
      "addressed at nobody": "not-mine",
      "addressed here, no client id": "not-mine",
      "empty address": "not-mine",
      "legacy owner matches": "mine",
      "legacy owner differs": "not-mine",
      "legacy owner null": "not-mine",
      "legacy owner blank": "not-mine",
      "legacy owner non-string": "not-mine",
      "legacy, no session": "not-mine",
      "legacy, nothing at all": "not-mine",
    });
  });

  // Defect 3: a window could answer another window's request. A
  // present-but-different address short-circuits, so the losing window never
  // even holds the request — and there is no container, so there is no button.
  it("never lets a matching owner override a foreign address", () => {
    expect(
      route({ targetClientId: "window-b", ownerSession: "session-a" }, MINE),
    ).toBe("not-mine");
  });
});

// Defect 1's structural half. Memory is what let ownership be inferred; a
// module with no imports has nowhere to keep any and no way to reach any. If
// this test ever needs relaxing, the fix under review belongs in another file.
describe("approvalRouter has no imports", () => {
  it("imports nothing at all", () => {
    // Read from disk rather than through the module graph: the assertion is
    // about the file's text, and a bundler would have already resolved away
    // exactly the thing under test.
    const source = readFileSync(resolve(process.cwd(), "src/lib/approvalRouter.ts"), "utf8");
    const imports = source.match(/^\s*import\s.+$/gm) ?? [];
    expect(imports).toEqual([]);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});

// Defect 6: one classifier, two call sites, and the unclassified case fell to
// the destructive side at one of them.
describe("classifySendFailure", () => {
  it("recognises exactly core's own refusals", () => {
    expect(classifySendFailure(new Error("no pending approval approval-1"))).toBe("gone");
    expect(classifySendFailure(new Error("session session-a not found"))).toBe("gone");
    expect(
      classifySendFailure(new Error("approval approval-1 belongs to another CaliCode window")),
    ).toBe("not-yours");
    expect(
      classifySendFailure(new Error("approval approval-1 has no attached window and cannot be answered")),
    ).toBe("not-yours");
  });

  it("defaults to retry for anything it does not recognise", () => {
    const unknown: unknown[] = [
      new Error("Failed to fetch"),
      new Error("RPC agent_approval_response failed: HTTP 502 Bad Gateway"),
      new Error(""),
      new Error("something nobody has seen before"),
      "",
      undefined,
      null,
      { message: "not an Error" },
      42,
    ];
    for (const error of unknown) {
      expect(classifySendFailure(error), `${String(error)} must be safe`).toBe("retry");
    }
  });
});

// Defect 2: a single boolean with four writers, one of which was "a turn
// finished". The alphabet is the fix — there is no lifecycle event to write.
describe("the reducer's alphabet is closed", () => {
  it("has no run-lifecycle event", () => {
    expect([...APPROVAL_EVENT_KINDS]).toEqual([
      "Arrived",
      "UserAnswered",
      "SendAccepted",
      "SendFailed",
      "Resolved",
      "Tick",
      "Discarded",
    ]);
    for (const forbidden of ["RunEnded", "TurnFinished", "GraphSettled", "StopClicked"]) {
      expect(APPROVAL_EVENT_KINDS).not.toContain(forbidden);
    }
  });
});

describe("reduce is total over state × event", () => {
  // Every cell of the transition table, asserted by construction. The table is
  // the deliverable; the reducer is its transcription.
  const seed = (state: RequestState["kind"]): ApprovalStore => {
    let store = reduce(emptyStore(), arrived("r-1"));
    if (state === "pending") return store;
    store = reduce(store, { kind: "UserAnswered", requestId: "r-1", approved: true, nowMs: 1_100 });
    if (state === "answering") return store;
    if (state === "settled") return reduce(store, { kind: "SendAccepted", requestId: "r-1" });
    return reduce(store, { kind: "SendFailed", requestId: "r-1", failure: "gone" });
  };

  // `Tick:late` is past both the TTL and the linger a finished card gets, so a
  // card that was already settled or lapsed is gone by then. That is the "evict
  // after a beat" row of the table.
  const events: Array<[string, ApprovalEvent]> = [
    ["Arrived", arrived("r-1", { raisedAtMs: 9_000 })],
    ["UserAnswered", { kind: "UserAnswered", requestId: "r-1", approved: false, nowMs: 2_000 }],
    ["SendAccepted", { kind: "SendAccepted", requestId: "r-1" }],
    ["SendFailed:retry", { kind: "SendFailed", requestId: "r-1", failure: "retry" }],
    ["SendFailed:gone", { kind: "SendFailed", requestId: "r-1", failure: "gone" }],
    ["SendFailed:not-yours", { kind: "SendFailed", requestId: "r-1", failure: "not-yours" }],
    ["Resolved:approved", { kind: "Resolved", requestId: "r-1", outcome: "answered-approved" }],
    ["Resolved:timed-out", { kind: "Resolved", requestId: "r-1", outcome: "timed-out" }],
    ["Tick:early", { kind: "Tick", nowMs: 1_500 }],
    ["Tick:late", { kind: "Tick", nowMs: 1_000 + APPROVAL_TTL_MS }],
    ["Discarded", { kind: "Discarded", reason: "session-changed" }],
  ];

  const expected: Record<string, Record<string, string>> = {
    pending: {
      Arrived: "pending",
      UserAnswered: "answering",
      SendAccepted: "pending",
      "SendFailed:retry": "pending",
      "SendFailed:gone": "pending",
      "SendFailed:not-yours": "pending",
      "Resolved:approved": "lapsed:resolved-elsewhere",
      "Resolved:timed-out": "lapsed:resolved-elsewhere",
      "Tick:early": "pending",
      "Tick:late": "lapsed:expired",
      Discarded: "lapsed:session-changed",
    },
    answering: {
      Arrived: "answering",
      UserAnswered: "answering",
      SendAccepted: "settled",
      "SendFailed:retry": "pending",
      "SendFailed:gone": "lapsed:core-refused",
      "SendFailed:not-yours": "lapsed:not-yours",
      "Resolved:approved": "settled",
      "Resolved:timed-out": "lapsed:resolved-elsewhere",
      "Tick:early": "answering",
      "Tick:late": "lapsed:expired",
      Discarded: "lapsed:session-changed",
    },
    settled: {
      Arrived: "settled",
      UserAnswered: "settled",
      SendAccepted: "settled",
      "SendFailed:retry": "settled",
      "SendFailed:gone": "settled",
      "SendFailed:not-yours": "settled",
      "Resolved:approved": "settled",
      "Resolved:timed-out": "settled",
      "Tick:early": "settled",
      "Tick:late": "absent",
      Discarded: "absent",
    },
    lapsed: {
      Arrived: "lapsed:core-refused",
      UserAnswered: "lapsed:core-refused",
      SendAccepted: "lapsed:core-refused",
      "SendFailed:retry": "lapsed:core-refused",
      "SendFailed:gone": "lapsed:core-refused",
      "SendFailed:not-yours": "lapsed:core-refused",
      "Resolved:approved": "lapsed:core-refused",
      "Resolved:timed-out": "lapsed:core-refused",
      "Tick:early": "lapsed:core-refused",
      "Tick:late": "absent",
      Discarded: "absent",
    },
  };

  const describeState = (state: RequestState | "absent"): string =>
    state === "absent" ? "absent" : state.kind === "lapsed" ? `lapsed:${state.reason}` : state.kind;

  for (const start of ["pending", "answering", "settled", "lapsed"] as const) {
    for (const [label, event] of events) {
      it(`${start} × ${label}`, () => {
        const next = reduce(seed(start), event);
        expect(describeState(stateOf(next, "r-1"))).toBe(expected[start][label]);
      });
    }
  }

  it("keeps a finished card readable for its linger, then evicts it", () => {
    let store = reduce(emptyStore(), arrived("r-1"));
    store = reduce(store, { kind: "UserAnswered", requestId: "r-1", approved: false, nowMs: 2_000 });
    store = reduce(store, { kind: "SendFailed", requestId: "r-1", failure: "gone" });
    // A card that lapsed two seconds in gets the same reading window as one
    // that expired five minutes in: the clock starts when it finished.
    store = reduce(store, { kind: "Tick", nowMs: 2_000 + SETTLED_LINGER_MS - 1 });
    expect(stateOf(store, "r-1")).toEqual({ kind: "lapsed", reason: "core-refused" });
    store = reduce(store, { kind: "Tick", nowMs: 2_000 + SETTLED_LINGER_MS });
    expect(stateOf(store, "r-1")).toBe("absent");
  });

  it("covers every cell of the table", () => {
    const cells = Object.values(expected).reduce((total, row) => total + Object.keys(row).length, 0);
    expect(cells).toBe(4 * events.length);
    expect(cells).toBeGreaterThanOrEqual(24);
  });
});

describe("the queue", () => {
  // Defect 5, first half: a single slot meant three parallel nodes overwrote
  // each other and two prompts were silently lost.
  it("gives three parallel nodes three independently answerable cards", () => {
    let store = emptyStore();
    for (const id of ["r-1", "r-2", "r-3"]) store = reduce(store, arrived(id));
    expect(visibleApprovals(store).map((entry) => entry.requestId)).toEqual(["r-1", "r-2", "r-3"]);

    // Answered out of order; each keeps its own state.
    store = reduce(store, { kind: "UserAnswered", requestId: "r-2", approved: true, nowMs: 2_000 });
    store = reduce(store, { kind: "SendAccepted", requestId: "r-2" });
    expect(stateOf(store, "r-1")).toEqual({ kind: "pending" });
    expect(stateOf(store, "r-3")).toEqual({ kind: "pending" });
    expect(stateOf(store, "r-2")).toEqual({ kind: "settled", approved: true });
  });

  // Defect 5, second half: the queue that replaced the single slot wedged
  // forever when a send failed, because the failed entry stayed at the head.
  it("keeps a hung send from hiding the queue behind it", () => {
    let store = emptyStore();
    for (const id of ["r-1", "r-2"]) store = reduce(store, arrived(id));
    store = reduce(store, { kind: "UserAnswered", requestId: "r-1", approved: true, nowMs: 2_000 });
    expect(headApproval(store)?.requestId).toBe("r-2");
  });

  it("returns a failed send to the queue at its own position", () => {
    let store = emptyStore();
    for (const id of ["r-1", "r-2"]) store = reduce(store, arrived(id));
    const orderBefore = store.entries.get("r-1")!.order;
    store = reduce(store, { kind: "UserAnswered", requestId: "r-1", approved: true, nowMs: 2_000 });
    store = reduce(store, { kind: "SendFailed", requestId: "r-1", failure: "retry" });
    expect(stateOf(store, "r-1")).toEqual({ kind: "pending" });
    expect(store.entries.get("r-1")!.order).toBe(orderBefore);
    expect(headApproval(store)?.requestId).toBe("r-1");
  });

  it("ignores a second click on a request already being answered", () => {
    let store = reduce(emptyStore(), arrived("r-1"));
    store = reduce(store, { kind: "UserAnswered", requestId: "r-1", approved: true, nowMs: 2_000 });
    const doubled = reduce(store, { kind: "UserAnswered", requestId: "r-1", approved: false, nowMs: 2_010 });
    expect(stateOf(doubled, "r-1")).toEqual({ kind: "answering", approved: true, startedAtMs: 2_000 });
  });

  it("refuses to grow past the cap instead of dropping what it already holds", () => {
    let store = emptyStore();
    for (let index = 0; index < MAX_QUEUED_APPROVALS + 5; index += 1) {
      store = reduce(store, arrived(`r-${index}`));
    }
    expect(store.entries.size).toBe(MAX_QUEUED_APPROVALS);
    expect(store.entries.has("r-0")).toBe(true);
  });

  it("keeps a redelivered payload without resetting the clock or the queue position", () => {
    let store = reduce(emptyStore(), arrived("r-1", { raisedAtMs: 1_000 }));
    store = reduce(store, arrived("r-2"));
    store = reduce(store, {
      ...arrived("r-1", { raisedAtMs: 90_000, graphLabel: "graph-7" }),
      tool: "file_write",
    } as ApprovalEvent);
    const entry = store.entries.get("r-1")!;
    expect(entry.arrivedAtMs).toBe(1_000);
    expect(entry.order).toBe(0);
    expect(entry.graphLabel).toBe("graph-7");
  });
});
