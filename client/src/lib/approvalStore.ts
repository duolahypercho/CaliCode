/**
 * The approval queue as one map, one reducer, and a closed event alphabet.
 *
 * Like `approvalRouter`, this module imports nothing. Its whole value is that
 * the alphabet is closed: there is no `RunEnded`, no `TurnFinished`, no
 * `GraphSettled`. A run finishing has no reachable path to a request's state
 * because the input does not exist. Adding one is a design change, not a bug
 * fix — a machine with a `RunEnded → denied` transition reproduces the worst
 * historical defect exactly, and more legibly.
 *
 * Note what a request can *become*: nothing here produces a decision. Only
 * `UserAnswered` — dispatched by a click handler and nothing else — moves an
 * entry toward an RPC.
 */

export type LapsedReason =
  | "expired"
  | "core-refused"
  | "not-yours"
  | "resolved-elsewhere"
  | "session-changed"
  | "panel-gone";

/**
 * Who produced the answer. Not decoration: a decision this window made is
 * already written to the transcript as a permanent row, so its card is a
 * duplicate the moment it settles and must stop rendering. An
 * `always-allowed` settle has no row of its own — nobody clicked that card —
 * so it is the one that has to stay up and say so.
 */
export type SettledVia = "this-window" | "always-allowed";

export type RequestState =
  | { kind: "pending" }
  | { kind: "answering"; approved: boolean; startedAtMs: number }
  | { kind: "settled"; approved: boolean; via: SettledVia }
  | { kind: "lapsed"; reason: LapsedReason };

export type ApprovalEntry = {
  requestId: string;
  tool: string;
  arguments: unknown;
  /** `ownerGraph`, for the card's label. Read by nothing that gates an action. */
  graphLabel: string | null;
  /** Core's clock when it raised this, falling back to arrival. */
  arrivedAtMs: number;
  /**
   * Queue position, assigned once on first arrival and never reassigned. A
   * failed send returns an entry to `pending` at the same `order`, so a retry
   * cannot jump the queue or lose its place — the bug that wedged the queue
   * the last time it was touched.
   */
  order: number;
  state: RequestState;
  /**
   * When this entry reached `settled` or `lapsed`. Eviction is measured from
   * here, not from arrival: a card that lapses two seconds in and one that
   * expires five minutes in should both stay readable for the same beat.
   */
  finishedAtMs: number | null;
};

/** How an approval ended somewhere other than this panel. */
export type ResolvedOutcome =
  | "answered-approved"
  | "answered-denied"
  /**
   * An "always allow" the user gave on a sibling card already covered this
   * one, so core answered it rather than asking the same permission twice.
   * Deliberately not spelled `answered-approved`: nobody clicked this card,
   * and a transcript that says they did is a lie about consent.
   */
  | "always-allowed"
  | "timed-out"
  | "run-cancelled"
  | "session-gone"
  | "core-shutdown";

export type ApprovalEventKind =
  | "Arrived"
  | "UserAnswered"
  | "SendAccepted"
  | "SendFailed"
  | "Resolved"
  | "Tick"
  | "Discarded";

export type ApprovalEvent =
  | {
      kind: "Arrived";
      requestId: string;
      tool: string;
      arguments: unknown;
      graphLabel: string | null;
      raisedAtMs: number;
    }
  | { kind: "UserAnswered"; requestId: string; approved: boolean; nowMs: number }
  | { kind: "SendAccepted"; requestId: string }
  | { kind: "SendFailed"; requestId: string; failure: "retry" | "gone" | "not-yours" }
  | { kind: "Resolved"; requestId: string; outcome: ResolvedOutcome }
  | { kind: "Tick"; nowMs: number }
  | { kind: "Discarded"; reason: LapsedReason };

/**
 * Every event kind the reducer accepts. Exported so a test can assert the
 * alphabet is exactly this and nothing has grown a lifecycle input.
 */
export const APPROVAL_EVENT_KINDS: readonly ApprovalEventKind[] = [
  "Arrived",
  "UserAnswered",
  "SendAccepted",
  "SendFailed",
  "Resolved",
  "Tick",
  "Discarded",
];

/**
 * How long a card stays up with no word from core. A backstop, not the primary
 * bound: core announces every resolution, and this only catches the case where
 * that announcement was lost. It removes cards. It never sends anything.
 */
export const APPROVAL_TTL_MS = 5 * 60_000;

/**
 * How long a finished card lingers before it is evicted.
 *
 * Long enough to read: a lapsed card's explanation is the only record that the
 * request existed and why it can no longer be answered. An approved or denied
 * one is also written to the transcript, so it is the lapsed case that sets
 * this number.
 */
export const SETTLED_LINGER_MS = 30_000;

/**
 * A queue this long means something is badly wrong upstream. Overflow refuses
 * the new request rather than denying it — the card simply never appears, and
 * core's timer handles it.
 */
export const MAX_QUEUED_APPROVALS = 20;

export type ApprovalStore = {
  entries: ReadonlyMap<string, ApprovalEntry>;
  nextOrder: number;
};

export function emptyStore(): ApprovalStore {
  return { entries: new Map(), nextOrder: 0 };
}

function withEntries(
  store: ApprovalStore,
  entries: Map<string, ApprovalEntry>,
  nextOrder = store.nextOrder,
): ApprovalStore {
  return { entries, nextOrder };
}

/**
 * Apply one event. Total over `RequestState.kind × ApprovalEventKind`; the
 * transition table in the design document is the deliverable and this is its
 * transcription.
 */
export function reduce(store: ApprovalStore, event: ApprovalEvent): ApprovalStore {
  switch (event.kind) {
    case "Arrived": {
      const existing = store.entries.get(event.requestId);
      // A re-delivery of something already finished is not news.
      if (existing && (existing.state.kind === "settled" || existing.state.kind === "lapsed")) {
        return store;
      }
      if (!existing && store.entries.size >= MAX_QUEUED_APPROVALS) return store;
      const entries = new Map(store.entries);
      entries.set(event.requestId, {
        requestId: event.requestId,
        tool: event.tool,
        arguments: event.arguments,
        graphLabel: event.graphLabel,
        arrivedAtMs: existing?.arrivedAtMs ?? event.raisedAtMs,
        order: existing?.order ?? store.nextOrder,
        state: existing?.state ?? { kind: "pending" },
        finishedAtMs: existing?.finishedAtMs ?? null,
      });
      return withEntries(store, entries, existing ? store.nextOrder : store.nextOrder + 1);
    }
    case "UserAnswered": {
      const existing = store.entries.get(event.requestId);
      // The reducer IS the double-send guard: a second click finds the entry
      // already `answering` and is ignored, with no in-flight `Set` beside it
      // that could disagree.
      if (!existing || existing.state.kind !== "pending") return store;
      const entries = new Map(store.entries);
      entries.set(event.requestId, {
        ...existing,
        state: { kind: "answering", approved: event.approved, startedAtMs: event.nowMs },
        finishedAtMs: null,
      });
      return withEntries(store, entries);
    }
    case "SendAccepted": {
      const existing = store.entries.get(event.requestId);
      if (!existing || existing.state.kind !== "answering") return store;
      const entries = new Map(store.entries);
      entries.set(event.requestId, {
        ...existing,
        state: { kind: "settled", approved: existing.state.approved, via: "this-window" },
        finishedAtMs: existing.state.startedAtMs,
      });
      return withEntries(store, entries);
    }
    case "SendFailed": {
      const existing = store.entries.get(event.requestId);
      if (!existing || existing.state.kind !== "answering") return store;
      const entries = new Map(store.entries);
      // `retry` returns the card to the queue at its OWN order. Core is still
      // holding the request, so the click is simply repeatable.
      const state: RequestState =
        event.failure === "retry"
          ? { kind: "pending" }
          : { kind: "lapsed", reason: event.failure === "gone" ? "core-refused" : "not-yours" };
      entries.set(event.requestId, {
        ...existing,
        state,
        finishedAtMs: state.kind === "pending" ? null : existing.state.startedAtMs,
      });
      return withEntries(store, entries);
    }
    case "Resolved": {
      const existing = store.entries.get(event.requestId);
      if (!existing) return store;
      if (existing.state.kind === "settled" || existing.state.kind === "lapsed") return store;
      const entries = new Map(store.entries);
      // A grant the user just gave covers this card. It is settled and
      // approved whichever state it was in — including a send of our own that
      // is still in flight, which core will resolve the same way.
      if (event.outcome === "always-allowed") {
        entries.set(event.requestId, {
          ...existing,
          state: { kind: "settled", approved: true, via: "always-allowed" },
          finishedAtMs:
            existing.state.kind === "answering" ? existing.state.startedAtMs : null,
        });
        return withEntries(store, entries);
      }
      if (existing.state.kind === "answering") {
        // Our own send is what core is announcing: settle it truthfully.
        const ours =
          (event.outcome === "answered-approved" && existing.state.approved) ||
          (event.outcome === "answered-denied" && !existing.state.approved);
        entries.set(event.requestId, {
          ...existing,
          state: ours
            ? { kind: "settled", approved: existing.state.approved, via: "this-window" }
            : { kind: "lapsed", reason: "resolved-elsewhere" },
          finishedAtMs: existing.state.startedAtMs,
        });
      } else {
        entries.set(event.requestId, {
          ...existing,
          state: { kind: "lapsed", reason: "resolved-elsewhere" },
          finishedAtMs: null,
        });
      }
      return withEntries(store, entries);
    }
    case "Tick": {
      let changed = false;
      const entries = new Map<string, ApprovalEntry>();
      for (const [id, entry] of store.entries) {
        if (entry.state.kind === "pending" || entry.state.kind === "answering") {
          if (event.nowMs - entry.arrivedAtMs >= APPROVAL_TTL_MS) {
            changed = true;
            entries.set(id, {
              ...entry,
              state: { kind: "lapsed", reason: "expired" },
              finishedAtMs: event.nowMs,
            });
            continue;
          }
          entries.set(id, entry);
          continue;
        }
        // A card can finish without a timestamp: nothing was in flight when
        // core announced it, so there was no `startedAtMs` to inherit. Stamp
        // it on the first tick that sees it rather than leaving it null —
        // `null ?? nowMs` makes the age permanently zero, and a card that can
        // never age out never leaves the transcript.
        if (entry.finishedAtMs === null) {
          changed = true;
          entries.set(id, { ...entry, finishedAtMs: event.nowMs });
          continue;
        }
        // Finished cards linger so the user can read the outcome, then go.
        // Measured from when they finished, so an early lapse and a late
        // expiry get the same reading window.
        if (event.nowMs - entry.finishedAtMs >= SETTLED_LINGER_MS) {
          changed = true;
          continue;
        }
        entries.set(id, entry);
      }
      return changed ? withEntries(store, entries) : store;
    }
    case "Discarded": {
      // The panel is going away or re-keying. Cards lapse; nothing is sent.
      let changed = false;
      const entries = new Map<string, ApprovalEntry>();
      for (const [id, entry] of store.entries) {
        if (entry.state.kind === "settled" || entry.state.kind === "lapsed") {
          changed = true;
          continue;
        }
        changed = true;
        entries.set(id, { ...entry, state: { kind: "lapsed", reason: event.reason }, finishedAtMs: null });
      }
      return changed ? withEntries(store, entries) : store;
    }
  }
}

/**
 * What the panel renders, oldest first.
 *
 * `answering` entries are never head: a send that hangs must not hide the rest
 * of the queue behind it. Three parallel nodes prompt together and stay
 * independently answerable in any order.
 *
 * A decision this window made drops out here rather than out of the map: the
 * transcript row written on the same click is the durable record, so keeping
 * the card up renders one act twice, in two shapes, saying two different
 * things. The entry survives so a re-delivered `Arrived` still finds it
 * finished and does not resurrect an answered prompt.
 */
export function visibleApprovals(store: ApprovalStore): ApprovalEntry[] {
  return [...store.entries.values()]
    .filter((entry) => !(entry.state.kind === "settled" && entry.state.via === "this-window"))
    .sort((left, right) => {
      const leftBusy = left.state.kind === "answering" ? 1 : 0;
      const rightBusy = right.state.kind === "answering" ? 1 : 0;
      if (leftBusy !== rightBusy) return leftBusy - rightBusy;
      return left.order - right.order;
    });
}

/** The card the promotion guard and keyboard focus apply to. */
export function headApproval(store: ApprovalStore): ApprovalEntry | null {
  return visibleApprovals(store)[0] ?? null;
}

/**
 * The one thing about a request a user has to see before answering it: which
 * file, command or address it would touch. Without it two `file_write` prompts
 * are the same four words twice, and the transcript rows they leave behind are
 * indistinguishable from each other.
 *
 * Keys are tried in order and the first string wins; an unrecognised tool
 * simply has no target, which is why the full arguments stay available below.
 */
export function approvalTarget(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "file", "filename", "command", "url", "query", "pattern", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Whether the full arguments say anything the target line did not.
 *
 * Two cases print nothing. A tool that takes no arguments arrives as `null` or
 * `{}`, and `JSON.stringify` renders both as text the user then has to decide
 * is not an error. A single-key `{ path }` is already the target line, and
 * repeating it as JSON directly underneath is the same duplication in
 * miniature.
 */
export function argumentsWorthShowing(args: unknown, target: string | null): boolean {
  if (args === null || args === undefined) return false;
  if (Array.isArray(args)) return args.length > 0;
  if (typeof args === "object") {
    const keys = Object.keys(args as object).length;
    return target ? keys > 1 : keys > 0;
  }
  return true;
}

/** Plain-language reason a card is no longer answerable. */
export function lapsedExplanation(reason: LapsedReason): string {
  switch (reason) {
    case "expired":
      return "no answer reached CaliCode in time — the agent stopped waiting";
    case "core-refused":
      return "CaliCode is no longer waiting on this request";
    case "not-yours":
      return "another CaliCode window owns this request";
    case "resolved-elsewhere":
      return "this request was already resolved";
    case "session-changed":
      return "this chat moved on before the request was answered";
    case "panel-gone":
      return "the panel that raised this closed";
  }
}
