# Approvals ownership: the decided design

Status: decided, ready to implement. Branch `feat/ux-tier-a`.
Decision: **synthesise — Design B is the spine, three pieces of Design A are grafted on.**

---

## 0. The decision in one paragraph

Design B is right about the *cause* and Design A is right about the *one thing B cannot
reach*. Every one of the five destructive defects was an auto-denial — a `{approved:false}`
the panel sent on its own initiative — and the client's ability to send one is the capability
to delete. That is B's move, it is cheap, it is incremental, and it is provable in JSDOM.
But the panel's remaining decision (`ownerSession === mine`) still cannot separate two
windows resumed on the same session, and no client-side rule ever can, because
`agent.approval_request` carries no address. A's stamp-and-enforce (`targetClientId` on the
event, rejected in core when it does not match) is the only construction that closes that,
it already ships and is already tested for editor tools, and it is roughly twenty lines.
So: delete the capability (B), then address the request (A), then let core cancel a finished
run's approvals so removing auto-denial does not cost 300 seconds (A §2.3 / B §5.3, which are
the same proposal). Everything else A proposes — a client registry on `/events`, presenter
re-addressing, `approval_claim`, an unaddressed badge — is rejected, and §3 says why.

---

## 1. What I verified before deciding

Both documents describe the repo accurately in the places that matter. The findings that
actually moved the decision:

**A denial and a timeout are the same outcome to the model.** `execute_tool_call_outcome`
(`core/src/agent.rs:1336-1339`) maps every `Err` to `json!({"error": ...})`. Both
`anyhow::bail!("approval denied for {}")` (`agent.rs:1487`) and
`anyhow::bail!("approval timed out for {}")` (`agent.rs:1479`) land there. **Client
auto-denial buys latency and nothing else.** This is the single strongest fact in either
document and it is B's. It means removing auto-denial cannot cost correctness — only
wall-clock — which converts a scary-sounding change into a bounded one.

**`submit_approval` has no authorization of any kind.** `agent.rs:1070-1084` is a session
lookup, a `pending.remove`, and a send. Any window that sees the broadcast can answer any
request. A is right that round 3's client-side politeness was not a fix.

**The enforced pattern already ships next door.** `editor_bridge::call` stamps
`targetClientId` (`core/src/editor_bridge.rs:54`) and `editor_bridge::submit` rejects a
mismatched client (`:75-77`), with a test named
`foreign_client_cannot_steal_a_pending_request`. `agent.tool_request` does the same via an
`editor_attachment` lookup (`agent.rs:1536-1568`). `agent.approval_request` is the only one
of the three that does not. The client already mirrors this asymmetry —
`ownsBrowserToolEvent` treats a present `targetClientId` as authoritative and short-circuits
(`AgentPanel.tsx:613-617`) while `ownsApprovalRequest` (`:1409`) infers.

**Round 5's stamping is complete and correct.** `ApprovalOwner` (`agent.rs:346-401`),
`SpawnParent` inheritance (`agent.rs:1497-1509`, `tools.rs:1963-1978`), and graph node
options (`graph.rs:3280-3288`) mean a graph node's own subagent carries both `ownerSession`
and `ownerGraph`. B's claim that pure equality suffices for the single-window case is
correct, and it is correct *today*, with no core change. That is what makes B cheap.

**Core is silent about the end of an approval.** No `approval_resolved`/`cancelled`/`timeout`
event exists anywhere in `core/src/`. A is right that the client's `APPROVAL_TTL_MS`
(`AgentPanel.tsx:234`) is a parallel model of core's clock. A over-weights it: the TTL sweep
only *drops* cards, it never denies, so it is the least harmful mechanism in the file.

**`/events` has no identity and no replay.** `core/src/main.rs:371-406` takes no parameters;
`RecvError::Lagged(_) => continue` (`:396`) silently drops events for a slow receiver. A's
`approval_list` is the right answer to this and it is the one place A is uniquely strong.
It is also not needed to kill any of the six defects — see §3 and §7.

**One latent bug neither document found.** `submit_tool_result` (`agent.rs:1054-1067`) and
`submit_approval` (`:1070-1084`) index the *same* `session.pending` map (`agent.rs:291`),
which also holds browser-tool waiters (`agent.rs:1538`). An `agent_tool_result` carrying an
`approval-` request id delivers a tool-result JSON to the approval waiter, where
`response.get("approved").unwrap_or(false)` reads it as **denied**. A seventh path to a
denial nobody asked for. Phase 0 deletes it for free.

---

## 2. Judged on the four criteria

| | Design A | Design B | Chosen |
|---|---|---|---|
| **(1) Structurally impossible** | 1,2,3,4 yes; 5 moved to core; 6 moved to core but the client still classifies its own send failures (A §4 concedes this) | 1,2,4,5 yes; 3 **reduced only**; 6 one-polarity but misclassification survives | B's kills + A's §2.3 clause for 3 |
| **(2) Migration cost** | ~500 new core lines, `/events` signature change, ~40 tests deleted, big-bang | one new pure module + deletions in one file, no wire change | B by a wide margin |
| **(3) The failure modes that bit us** | wins multi-window and SSE-reconnect; invents 5 new modes it must design out (its own §5) | wins core-restart and parallel fan-out; silent on SSE gap; loses multi-window | split — take A's win on multi-window, defer its win on SSE gap |
| **(4) Incremental** | no — registry, addressing and client rewrite must land together | yes | B |

The deciding asymmetry on (1): A's extra structural kills all come from *relocating*
computation into Rust. B's come from *deleting* the capability the computation gated. In a
subsystem where nine rounds of relocating produced "the defects fixed and the defects
introduced roughly cancel", deletion is the move with the better track record. A's own §5
lists five new failure modes its design must pre-empt — presenter-gone parks, nobody-there
claiming, last-attach-wins theft, version skew, unattended work. That list *is* the argument
against A: it is the same mechanism-beside-a-mechanism shape that generated rounds 3 through 8.

---

## 3. What is taken, and what is rejected

### Taken from B (the spine)
- **No client-originated denial, ever.** Four denial sites deleted:
  `denyUnclaimedRequest` arrival paths (`AgentPanel.tsx:1878`, `:1892`), the retire effect
  (`:2035-2060`), `stopAgent`'s loop (`:3105-3112`).
- **`route()` as a pure four-line function** in a zero-import module.
- **A closed event alphabet with no `RunEnded`.** A run finishing has no reachable path to a
  request's state because the input does not exist.
- **`classifySendFailure` with one call site, one default, and the default on the safe side.**
- **`answering` entries are never head**, so a hung send cannot hide the queue behind it.

### Taken from A (three grafts, each independently landable)
1. **`targetClientId` on `agent.approval_request` + rejection in core when it does not match**
   (A §2.3's "without it the rest is decoration" clause). This is the only construction that
   makes defect 3 impossible rather than merely non-destructive. B reaches the same
   conclusion in its §7.3 recommendation (b) but stops at the stamp; the stamp without the
   core-side rejection is round 3 again.
2. **Core cancels a run's approvals when the run ends** (A §2.3 `cancel_by_graph` /
   `cancel_by_session`; B §5.3, which B calls roadmap). This is not a new ownership
   mechanism — it is core dropping oneshot senders it already owns, in paths that already
   exist. It is what pays for removing auto-denial, and without it the latency regression is
   what generates round ten.
3. **`agent.approval_resolved` as a broadcast.** One event at each exit from the pending map.
   Converts the client's TTL sweep from a parallel clock into a corrective signal, and gives
   the losing window in any race an immediate truthful card instead of a stale one.

### Rejected from A, with reasons
- **`/events?clientId=` + a `ClientRegistry` keyed to connection lifetime.** `editor_attachment`
  (`rpc.rs:831-839`) already holds `clientId` per session, is already last-writer-wins, is
  already the routing source for `agent.tool_request`, and is already validated against the
  session's project/workspace binding (`rpc.rs:817-830`). A second registry is A's own §7
  rule — "would not add a second clock" — broken by A's own §2.1. **Instead: re-attach on SSE
  open**, six lines in the client, which makes the existing registry as live as a connection
  registry would be.
- **Presenter re-addressing, `approval_claim`, the unaddressed-claimable badge.** This is
  adoption with a permission slip. Adoption is the concept that produced defects 3 and 4; a
  round trip does not change its shape. A request whose owner window is gone parks and times
  out, and after graft 2 a request whose *run* is gone dies immediately. That is enough.
- **`approval_list` snapshot RPC.** Genuinely the best answer to the SSE-gap class and the one
  thing B has no answer for. Deferred to phase 5 with an explicit trigger (§7), because it
  kills none of the six defects and every mechanism added beside an existing one in this
  subsystem has cost a round.
- **Deleting `APPROVAL_PROMOTION_GUARD_MS`.** Both documents agree it stays. It is a
  pointer-input concern, orthogonal to ownership, with three tests behind it
  (`AgentPanel.approvals.test.tsx:1671`, `:1717`, `:1758`).

### Rejected from B
- **§7.3 option (a) "accept two windows on one session".** B is right that it is
  categorically smaller than the historical defect (a human clicked), but "the wrong human
  approved a file write" is still a cross-intent violation, and closing it costs twenty lines.
- **Treating §5.3 (core drops the pending sender when the run ends) as roadmap.** It ships
  in phase 4 of this change. Removing auto-denial without it is a user-visible hang.

---

## 4. The design

### 4.1 Core: `core/src/approvals.rs` (new)

Approvals move out of `AgentSession.pending` into their own registry keyed by `requestId`.

```rust
pub struct PendingApproval {
    pub request_id: String,
    pub answer_session: String,          // today's `approval_sid`; kept for cancel-by-session
    pub target_client_id: Option<String>,// the one window that may answer; None = nobody
    pub owner_session: Option<String>,   // display + cancel-by-session
    pub owner_graph: Option<String>,     // display + cancel-by-graph
    pub tool: String,
    pub raised_at_ms: u64,
    sender: oneshot::Sender<Value>,
}

/// Every way an approval can leave the map. No `_ =>` arm anywhere it is matched;
/// adding a variant must fail the build. (This is A §2.2's one genuinely
/// structural core-side idea, kept.)
pub enum Resolution {
    Answered { approved: bool, by_client: Option<String> },
    TimedOut,
    RunCancelled,
    SessionGone,
    CoreShutdown,
}

pub struct Approvals {
    events: broadcast::Sender<Value>,
    pending: Arc<Mutex<HashMap<String, PendingApproval>>>,
}
```

API: `request(...) -> Result<Value>` (register, emit, await with the existing 300s bound),
`respond(request_id, client_id: Option<&str>, approved) -> Result<Value>`,
`cancel_by_graph(graph_id) -> usize`, `cancel_by_session(session_id) -> usize` (matches
`answer_session` **or** `owner_session`), `waits_on_session(session_id) -> bool`,
and a private `resolve(request_id, Resolution)` that removes and broadcasts.

`respond` is the enforcement point:

```rust
match (&entry.target_client_id, client_id) {
    (Some(target), Some(actual)) if target == actual => { /* answer */ }
    (Some(_), _) => anyhow::bail!(
        "approval {request_id} belongs to another CaliCode window"),
    (None, _) => anyhow::bail!(
        "approval {request_id} has no attached window and cannot be answered"),
}
```

Note the second arm covers a missing `clientId` as well as a wrong one. There is no soft
window: core and the client ship in one Tauri binary, so the strict rule lands with the
client change in the same commit (phase 3). A stale dev client gets a loud, readable refusal
rather than a silent fallback — which is how the last blackout reached a release.

### 4.2 Core: the addressing lookup

Computed once, at request time, in `execute_tool_call`'s approval block
(`agent.rs:1426-1489`):

```rust
let target_client_id = match owner_sid {
    Some(owner) => state.editor_attachment.read().await
        .get(owner).map(|a| a.client_id.clone()),
    None => None,
};
```

**Keyed on `owner_sid`, not `root_sid`**, and deliberately *without* the project/workspace
re-check the browser-tool path performs (`agent.rs:1541-1552`). The reason: `editor_attach`
already refuses to record an attachment whose session is bound to a different
project/workspace (`rpc.rs:817-830`), so the attachment for session S is always in S's
project. Re-checking here would add a way for a graph node whose options happened to carry a
different workspace spelling to produce `targetClientId: null` and park every node. One
lookup, one condition.

The field is **always emitted**, `null` when there is no attachment. Absent means a stale
core. The client distinguishes the two (§4.4).

### 4.3 Core: the wire

```
agent.approval_request {
  requestId, tool, arguments,
  sessionId,                    // answer address — unchanged, still correct
  targetClientId,               // NEW, always present, null when nobody is attached
  ownerSession, ownerGraph,     // unchanged; DISPLAY ONLY on the client from here on
  subagentSessionId,            // unchanged
  raisedAtMs                    // NEW; core's clock, so the client stops guessing it
}
agent.approval_resolved { requestId, outcome, byClientId? }
  // outcome ∈ answered-approved | answered-denied | timed-out | run-cancelled
  //           | session-gone | core-shutdown   (mirrors Resolution, exhaustively)
```

RPC `agent_approval_response { requestId, clientId, approved }`. `sessionId` becomes optional
and ignored (accepted for one release so nothing 400s during a dev rebuild, never read).
Keying on `requestId` deletes the client's `pending.sessionId ?? sessionIdRef.current`
fallback (`AgentPanel.tsx:3465`) — one more guess gone.

### 4.4 Client: `client/src/lib/approvalRouter.ts` (new, zero imports)

```
route(event, identity) -> "mine" | "not-mine"

  // A routed token is authoritative and never falls through — the exact rule
  // ownsBrowserToolEvent already uses (AgentPanel.tsx:613-617).
  if ("targetClientId" in event)                       // present, incl. null
    return event.targetClientId !== null
        && event.targetClientId === identity.clientId ? "mine" : "not-mine"

  // Field absent: a core older than phase 3. Dev only — core ships in the
  // Tauri binary. Log loudly, then fall back to the equality on the stamp
  // core has carried since round 5.
  owner = nonEmptyString(event.ownerSession)
  if (owner === null || identity.sessionId === null) return "not-mine"
  return owner === identity.sessionId ? "mine" : "not-mine"
```

Not in it: `ownerGraph`, `event.sessionId`, `subagentSessionId`, any run map, any snapshot,
any clock, any `await`. `ownerGraph` reaches the entry as `graphLabel` and is read by nothing
that gates an action.

**One permitted observation, which must never become an input:** in dev builds, log when an
approval arrives with `targetClientId: null` while this panel has a live run. It logs. It
must never route. This comment goes in the function, because the last three rounds each
turned an observation into an input.

### 4.5 Client: the state machine (`approvalRouter.ts` + `approvalStore.ts`)

One `Map<requestId, Entry>`, one reducer, one writer, six events, twenty-four defined cells.
Entry carries `requestId, tool, arguments, graphLabel, arrivedAtMs, order, state`.
`answerTo` exists only until phase 3 lands and is deleted with it.

```
type RequestState =
  | { kind: "pending" }
  | { kind: "answering"; approved: boolean; startedAtMs: number }
  | { kind: "settled";  approved: boolean }
  | { kind: "lapsed";   reason: "expired" | "core-refused" | "not-yours"
                              | "resolved-elsewhere" | "session-changed" | "panel-gone" }
```

| | `pending` | `answering` | `settled` | `lapsed` |
|---|---|---|---|---|
| `Arrived(id,payload)` | replace payload, stay | replace payload, stay | ignore | ignore |
| `UserAnswered(id,approved)` | → `answering` | ignore | ignore | ignore |
| `SendAccepted(id)` | ignore | → `settled` | ignore | ignore |
| `SendFailed(id,"retry")` | ignore | → `pending` (same `order`) | ignore | ignore |
| `SendFailed(id,"gone")` | ignore | → `lapsed{core-refused}` | ignore | ignore |
| `SendFailed(id,"not-yours")` | ignore | → `lapsed{not-yours}` | ignore | ignore |
| `Resolved(id,outcome)` | → `lapsed{resolved-elsewhere}` | → `settled` if ours, else `lapsed` | ignore | ignore |
| `Tick(now)` | `now - arrivedAtMs >= TTL` → `lapsed{expired}` | same | evict after a beat | evict after a beat |
| `Discarded(reason)` | → `lapsed{reason}` | → `lapsed{reason}` | evict | evict |

`Resolved` is the graft-3 event; it is what makes the table's `Tick` row a backstop rather
than the primary bound. **There is no `RunEnded`.** A request that routes `not-mine` is
dropped at the door and never enters the map — there must be no container a foreign request
can sit in, because a container is a button.

`classifySendFailure` returns `"retry" | "gone" | "not-yours"`, total, whitelisting only
core-authored refusal strings:

```
/no pending approval/i                          -> "gone"
/session .* not found/i                         -> "gone"
/belongs to another CaliCode window/i           -> "not-yours"
/has no attached window/i                       -> "not-yours"
everything else — transport, empty, unknown     -> "retry"    // SAFE side
```

One call site (`respondToApproval`). The `/loop` completion gate keeps its own predicate
under its own name (`shouldRetryRead`) in its own module — two narrow predicates that cannot
be confused, which is defect 6's real lesson.

### 4.6 Client: what happens to each existing mechanism

| Today (`AgentPanel.tsx`) | Fate |
|---|---|
| `denyUnclaimedRequest` (`:1331`) + both call sites (`:1878`, `:1892`) | **deleted** |
| retire effect's denial loop (`:2035-2060`) | **deleted** |
| `stopAgent`'s deny loop (`:3105-3112`) | **deleted** — Stop stops waiting, never answers |
| `approvalOwners` (`:1419-1467`), `ownsApprovalRequest` (`:1409`) | **deleted** → `route()` |
| `approvalOwnerRunning` (`:1471`), `approvalOwnersLive` (`:1476`), `liveApprovals` (`:1482`) | **deleted** — visibility is `state.kind` |
| `ApprovalProducer`/`Kind` (`:125-144`), `approvalProducersRef` (`:1166`), `liveApprovalProducers` (`:1172`), `openApprovals`/`closeApprovals` (`:1180-1189`, 11 call sites) | **deleted from the approval path**; a much smaller `runsRef` survives for card labels and Stop's own bookkeeping, read by nothing that gates an action |
| `stoppableProducerRef` (`:1176`) | survives for Stop's abort only |
| `GraphRunOrigin` (`:155`), `graphRunClaimKey` (`:1206`), `adoptGraphRun` (`:1228`), `releaseAdoptedGraphRun` (`:1249`) | **deleted** — no adoption in any form |
| `adoptedRunWatchdogsRef`/`armAdoptedRunWatchdog`/`clearAdoptedRunWatchdog` (`:1259-1323`), `ADOPTED_RUN_CHECK_MS` (`:184`), `ADOPTED_RUN_UNREADABLE_LIMIT` (`:194`) | **deleted** — ~70 lines bounding a claim that no longer exists |
| `settledGraphsRef` (`:1350`), `rememberSettledGraph` (`:1358`), `SETTLED_GRAPH_MEMORY` (`:214`) | **deleted** — no graph's past decides a present request |
| `readGraphLiveness` (`:285`), `GraphLiveness` (`:265`), `LIVE_GRAPH_STATUSES` (`:274`), `GRAPH_STATUS_RETRIES`/`_BACKOFF_MS` (`:204-205`) | **deleted from the approval path**; the `/loop` gate keeps its own read |
| `graphRunWaitsRef`/`armGraphRunWatchdog` (`:1372-1378`), `GRAPH_RUN_SETTLE_GRACE_MS` (`:172`) | **survives, demoted** — it now only hangs up a socket |
| TTL sweep (`:2098-2116`), `APPROVAL_TTL_MS` (`:234`), `APPROVAL_SWEEP_MS` (`:241`) | **survives as `Tick`** — removes cards, never sends; backstopped by `Resolved` from phase 4 |
| `MAX_QUEUED_APPROVALS` (`:253`) overflow (`:1074-1079`) | **survives** and is now consistent: refused, not denied |
| `insertApprovalAt` (`:387`) + `approvalIndex` (`:1089`) + `restoreApproval` (`:1096`) | **deleted** — `order` lives on the entry, so restore is not a code path |
| `approvals`/`approvalsRef` mirror pair (`:1058`/`:1061`) | **deleted** — the store is readable from the mount-once SSE handler |
| promotion guard (`:224`, `:2073-2088`, `:3440-3447`) | **survives verbatim**, layout-effect placement and all |
| `editorClientIdRef` (`:1490`) | **promoted** from per-mount UUID to `sessionStorage`-backed, so a reload reclaims its inbox. `sessionStorage`, never `localStorage` — two windows sharing an id would break the one-window-one-inbox invariant, which is the trap worth naming |

Net: roughly 300 lines of interacting refs, timers and predicates in a 4064-line component
become ~120 lines of pure module plus a thin dispatch layer, and nine constants go away.

---

## 5. Build order

Six phases. Phases 0-2 are the change; 3-4 are the grafts; 5 is deferred. Each is independently
landable and independently revertable.

### Phase 0 — core: split approvals out of `session.pending` (no behaviour change)

Files: `core/src/approvals.rs` (new), `core/src/agent.rs`, `core/src/main.rs` (wire
`Approvals` into `AppState`), `core/src/rpc.rs`.

1. Add `Approvals` with the struct and `Resolution` from §4.1. Emit the same
   `agent.approval_request` shape as today — same fields, same order.
2. `agent.rs:1426-1489` collapses to `state.approvals.request(...)`. Delete the
   `approval_session` lookup dance (`:1429-1440`): the registry holds `answer_session` as
   data, so there is no need to find the parent `Arc<Mutex<AgentSession>>` at all. Keep
   `root_sid` for the event's `sessionId` and for `SpawnParent`.
3. `submit_approval` (`agent.rs:1070-1084`) delegates to `approvals.respond(request_id, None,
   approved)`. Still no enforcement — that is phase 3. The signature keeps `session_id` and
   ignores it.
4. **The two adjacent things this breaks, which must land in the same commit:**
   - `get_or_create`'s eviction guard (`agent.rs:1212-1230`) filters victims on
     `session.pending.is_empty()`. Approvals are no longer in that map, so an
     approval-parked session becomes evictable. The victim filter must additionally exclude
     any session for which `approvals.waits_on_session(id)` is true.
   - `remove_session` (`agent.rs:559-573`) drops `pending` to wake waiters. It must also
     call `approvals.cancel_by_session(id)`.
5. Free fix: `agent_tool_result` can no longer answer an approval, and vice versa. The
   cross-type denial path from §1 is gone.

Tests (`core/src/approvals.rs`, `core/src/agent.rs`):
- `approval_and_tool_request_ids_cannot_answer_each_other` — submit a tool result carrying an
  `approval-` id; the approval waiter is untouched and the call errors.
- `a_session_parked_on_an_approval_is_never_evicted` — port of the existing
  `agent.rs:4438-4469` case, now driven through the registry.
- `removing_a_session_wakes_its_parked_approval`.

### Phase 1 — client: the pure modules, wired to nothing

Files: `client/src/lib/approvalRouter.ts` (new), `client/src/lib/approvalStore.ts` (new),
`client/src/lib/approvalRouter.test.ts` (new).

No behaviour change; the panel does not import them yet.

Tests:
- **`reduce` is total**: iterate the product of `RequestState.kind × EventKind` and assert
  every one of the 24+ cells against the table in §4.5. This table is the deliverable; the
  reducer is its transcription.
- **`route` is pure**: table-driven over `{targetClientId present/null/absent} ×
  {ownerSession mine/foreign/null/blank/non-string} × {sessionId set/null}`.
- **`approvalRouter.ts` imports nothing**: read the module's own source, assert the import
  list is empty. This is what keeps memory from creeping back — there is nowhere in the
  module to put it and no way to reach any.
- `classifySendFailure` over the real core strings plus `""`, `undefined`, a transport
  failure, and an unknown message (must be `"retry"`).

### Phase 2 — client: switch the panel over, in ONE commit

File: `client/src/components/editor/AgentPanel.tsx`, plus
`client/src/components/editor/AgentPanel.approvals.test.tsx`.

Use §4.6's table as the commit checklist. **Every "deleted" row must be absent from the
diff.** A reviewer's first question is "is `settledGraphsRef` still in the file?" A partial
adoption is the exact shape that has failed eight times.

What the panel keeps: the SSE handler (`route`, then dispatch `Arrived`), the click handlers
(dispatch `UserAnswered`, which returns the post-transition state so the handler knows whether
to issue exactly one RPC — the reducer *is* the double-send guard, with no in-flight `Set`
beside it), a `Tick` interval, `Discarded` on unmount/`/new`/`resumeSession`/`fork`, and the
render.

**This is the commit where the historical class dies.** Defects 1, 2, 4, and 5 become
unreachable here, before any core change lands.

Test surface — this is the review artifact, and it is the one thing that would have caught
"the defects fixed and the defects introduced roughly cancel" earlier. Of the 53 cases in the
1957-line suite:

*Converted from "denies" to "the card stays up and says why"* (behaviour deliberately traded —
convert, never delete quietly):
`:352` "still denies once nothing is running" · `:1026` "denies a finished run's node approval
even while the other graph runs" · `:1435` "still denies once core answers that the run is
over" · `:1346` "keeps a queued request and answers it when the run behind it ends".

*Deleted with their mechanism* (they assert machinery that no longer exists):
`:579` `:611` `:637` `:1421` `:1463` `:1517` `:1566` (adoption + watchdogs) ·
`:543` `:1628` (settled-graph memory) · `:1406` (liveness retry in the approval path) ·
`:1941` `:1945` `:1949` `:1953` (`insertApprovalAt` unit tests — `order` replaces it).

*Must stay green, re-expressed through `route()` with no `graph_status` call in the path*:
the whole adoption group `:497-659` (`:505` "reaches the user, naming the run that is
waiting" is the important one), plus `:271` `:288` `:318` `:387` `:428` `:456` `:661` `:681`
`:716` `:739` `:755` `:769` `:899` `:921` `:943` `:961` `:1002` `:1292` `:1671` `:1717`
`:1758` `:1819` `:1847` `:1866` `:1896`.

**If any case in `:497-659` cannot be made green by routing alone, the design is wrong and
this phase stops.** That group is the load-bearing check that removing adoption did not
remove the capability adoption provided.

Test count drops. That is not a regression and it needs saying before the review, not after:
the suite is smaller because there is less that can be wrong, and the coverage moves to core
where it is exhaustive over an enum.

### Phase 3 — core + client together: address the request and enforce the address

Files: `core/src/agent.rs`, `core/src/approvals.rs`, `core/src/rpc.rs`,
`client/src/lib/rpc.ts`, `client/src/lib/approvalRouter.ts`,
`client/src/components/editor/AgentPanel.tsx`.

1. Core: compute `target_client_id` per §4.2, store it on `PendingApproval`, emit it (and
   `raisedAtMs`) on the event.
2. Core: `approvals.respond` enforces per §4.1. `rpc.rs:1033-1043` becomes
   `agent_approval_response { requestId, clientId, approved }`; `sessionId` accepted and
   ignored.
3. Client: `route()` gains the `targetClientId` branch (§4.4). Send `clientId`, drop
   `sessionId`, delete `Entry.answerTo` and the "no session to reply to" branch
   (`AgentPanel.tsx:3466-3469`).
4. Client: `editorClientIdRef` → `sessionStorage`.
5. Client: `connectEvents` (`client/src/lib/rpc.ts:192`) gains an optional `onOpen`; the
   panel re-attaches (`editor_attach`) on every (re)connection when it has a session and a
   workspace root. **This is the six-line replacement for A's entire ClientRegistry** — it
   makes `editor_attachment` as live as connection lifetime without a second registry.
6. Client: close B's §8.6 hole while we are here. `agentChat`'s "session not found" retry
   (`AgentPanel.tsx:2352-2362`) re-issues with `sessionId: null` and learns the id only from
   the result, so approvals raised during that turn are addressed to a window that has not
   attached. On that retry, call `createSession` explicitly, attach, and pass the id. This
   preserves the invariant that no RPC which can cause a tool call is issued before the panel
   knows and has attached its session — an invariant worth making a review rule, because it
   is greppable: `runTurn` (`:2401`), `spawnSubagent` (`:3248`), `runGraphGoal` (`:3358`),
   the re-run button (`:3583`) all already satisfy it.

**Defect 3 dies here.**

### Phase 4 — core: cancel a run's approvals, and announce every resolution

Files: `core/src/approvals.rs`, `core/src/graph.rs`, `core/src/agent.rs`,
`client/src/components/editor/AgentPanel.tsx`.

1. `resolve()` broadcasts `agent.approval_resolved` on every exit, matching `Resolution`
   exhaustively.
2. `graph.rs` cancel and terminal paths (`cancel_tool` `:4144-4156`, the run loop's cancelled
   broadcast `:3661`, and the terminal rollup) call `approvals.cancel_by_graph(graph_id)`.
3. `remove_session` and session eviction call `cancel_by_session` (already added in phase 0).
4. Shutdown drains with `Resolution::CoreShutdown`.
5. Client: dispatch `Resolved` from the SSE handler.

**This is what pays for phase 2.** Without it, a walked-away-from graph burns 300s per attempt
against `MAX_ATTEMPTS_PER_NODE = 5` (`graph.rs:36`) with waves of `MAX_PARALLEL_NODES = 3`
(`:51`) joined — up to 25 minutes of stalled wave per node. With it, a cancelled or finished
run's approvals fail immediately and correctly, from the party that knows, with no client
involvement. The residual case — a live run whose approval nobody answers — is core's 300s
timer doing exactly what it exists for.

### Phase 5 — deferred: `approval_list` snapshot

**Not now.** Trigger to build it: any report of a card that never appeared for a run that was
genuinely live, or `RecvError::Lagged` showing up in core logs under normal use. Until then
the gap self-heals — a node whose approval event was lost parks, times out, and its next
attempt raises a fresh request the reconnected panel does see — and adding a mechanism beside
an existing one is what has cost every previous round.

If it is built: `approval_list { clientId }` returning the caller's addressed, unresolved
requests, called on SSE open, reconciled as *additive only for arrivals* and *removals only
for ids the response is newer than* — a naive "anything not in the list is dead" drop would
race an approval raised between the call and the response. That subtlety is why it is not
free, and why it is not in the critical path.

---

## 6. The test that proves each historical defect cannot recur

Each one must be impossible to make pass by accident.

| # | Defect | Verdict | The test | Where |
|---|---|---|---|---|
| 1 | Ownership inferred from previously-seen session ids; descendants and pre-snapshot arrivals misattributed | **Impossible** | `a_graph_node_subagent_approval_routes_like_its_graph` — grandchild approval (graph → node → node's own subagent) with a session id the panel has never seen routes `mine` from the stamp alone; plus the zero-imports assertion, which proves the module *cannot* remember a session | `approvalRouter.test.ts`; core pin in `tools.rs` beside `:2641` |
| 2 | Single boolean, four writers; a finishing turn auto-denies a live graph | **Impossible** | `no_run_lifecycle_event_exists` — enumerate the reducer's accepted event kinds and assert `RunEnded` is not among them; plus `a_turn_finishing_beside_a_running_graph_issues_zero_rpcs` (spy on `rpc`, assert 0 calls) | `approvalRouter.test.ts`, `AgentPanel.approvals.test.tsx` |
| 3 | Widened ownership lets window A authorise window B's file write | **Impossible** (phase 3) | `foreign_client_cannot_answer_an_addressed_approval` — the direct port of `editor_bridge.rs`'s `foreign_client_cannot_steal_a_pending_request`; and client-side `two_panels_on_one_session_only_the_attached_one_renders_the_card` | `core/src/approvals.rs`, `AgentPanel.approvals.test.tsx` |
| 4 | Bare graph id in an add-only Set; a later agent-driven run of a once-started graph denied | **Impossible** | `a_re_run_of_a_finished_graph_renders_its_approval` — run g-1 to terminal, then deliver an approval stamped `ownerGraph: g-1`; assert a card and zero RPCs. There is no memory left to lie | `AgentPanel.approvals.test.tsx` |
| 5 | Single slot → parallel overwrite; then a queue whose failure path wedged forever | **Overwrite impossible; wedge bounded** | `three_parallel_nodes_get_three_independently_answerable_cards`; and `a_failed_send_leaves_the_card_up_and_core_still_holding_it` asserting the entry returns to `pending` at the **same `order`** and that `answering` entries are never head | `approvalRouter.test.ts`, `AgentPanel.approvals.test.tsx` |
| 6 | Classifier whose unclassified case fell to the destructive side at one site, the safe side at the other | **Two-polarity impossible; misclassification survives** | `classify_send_failure_defaults_to_retry` over unknown/empty/transport messages; plus a grep-style test asserting `classifySendFailure` has exactly one call site in `AgentPanel.tsx` | `approvalRouter.test.ts` |
| — | **The invariant itself** | | `core_unreachable_for_an_approvals_whole_life_issues_no_denial_from_anyone` — reject every `rpc` call for the duration, tick past TTL, assert zero `agent_approval_response` calls with `approved:false` and a truthful lapsed card | `AgentPanel.approvals.test.tsx` |

**Write the last one first.** It is the direct expression of the governing invariant, and it
is the test that all nine previous rounds would each have failed in a different way.

> **The invariant, which supersedes every other rule in this document:** only two things may
> produce a denial — a human clicking Deny, or core's own bounded timer. No inference, no
> transport failure, no state transition, on either side, ever. Core cancelling a finished
> run's approvals is not a denial; it is core declining to keep waiting for work that no
> longer exists.

---

## 7. The five failure modes that actually bit us, walked end to end

**Multiple editor windows.** Window A runs the turn; core stamps `targetClientId = A` from
`editor_attachment[ownerSession]`. B's `route()` returns `not-mine` and the request never
enters B's map — there is no container it can sit in, so there is no button. If B somehow
called `agent_approval_response`, `approvals.respond` rejects it. Two windows resumed on the
*same* session: whoever attached last owns new prompts, which is already the semantics for
editor tools (`editor_attach` is last-writer-wins, `rpc.rs:831`), so the two stop disagreeing
— that is a correctness gain in itself, since today a session's editor tools can be driven by
window B while window A answers its approvals. The de-addressed window shows nothing rather
than a card it cannot answer, because a present-but-different `targetClientId` short-circuits.
*Product decision to make explicitly, not by implementation default: last attach wins.*

**SSE reconnect.** `EventSource` reconnects on its own; phase 3's `onOpen` re-attaches, so
`editor_attachment` is fresh and subsequent prompts address correctly. Events missed during
the gap are lost (`main.rs:396`) — a request raised in the window is never rendered and parks
to core's timer. That is a real hole and it is B's, not A's; it is bounded, non-destructive,
self-heals through the node's next attempt, and phase 5 exists for it with a stated trigger.
No denial is issued by anyone during a gap, which is the property that matters.

**A graph node spawning its own subagent.** Already correct in shipped core and needs nothing:
`SpawnParent` inherits `owner_session` and `owner_graph` (`agent.rs:1497-1509`,
`tools.rs:1963-1978`), so the grandchild's prompt carries the graph's owner and the graph id,
and phase 3 addresses it to that owner's window. The panel matches on a stamp, never on a
session id it must have seen — which no snapshot ever carries for a node's own children. Pin
it with the grandchild test in §6 row 1, because this is the case where a core regression
would be invisible to every client test (B's §8.1, correctly identified).

**Parallel fan-out.** Three Build nodes (`MAX_PARALLEL_NODES = 3`) prompt together. Three
entries keyed by `requestId`, three `order` values, three cards, answered one at a time in
any order. `answering` entries are never head, so a hung send on one cannot hide the other
two. The promotion guard still covers the double-click as the queue advances.

**Core restarting mid-approval.** Sessions and pending oneshots are in-memory; a restart
destroys both, and the turn that was waiting is gone too, so there is nothing to reconcile
*to*. Cards lapse on `Tick` with a truthful line and **nothing is sent**. Any click during
the outage fails with a transport error → `"retry"` → the card returns to `pending` at its
own `order`, which is safe precisely because a retry against a restarted core gets
`"no pending approval"` → `"gone"` → lapsed. On reconnect the panel re-attaches, so the next
run addresses correctly. Note this is the case that makes `"retry"` the right default: the
safe branch self-heals in one extra click, the destructive branch destroys a node.

---

## 8. What this does not fix, stated plainly

The pattern in this subsystem has been to claim more than the structure delivers.

1. **Core regressing the stamps.** The client is a projection of `targetClientId` /
   `ownerSession`. If `tools.rs` stops inheriting `owner_session`, or `graph.rs:3284` stops
   passing `from_ancestor`, the panel silently shows nothing and everything parks. No client
   test can see it. Mitigated by the core pins in §6 (grandchild case, and an assertion that
   an unowned spawn emits `ownerSession: null` rather than a session id) — not eliminated.
2. **Refusal-string misclassification.** Over-matching the whitelist drops a live card and
   costs a node; under-matching keeps a dead card and costs a click. The whitelist discipline
   and its test are the only defence. This one is tests, not structure, and that is the honest
   limit of the approach.
3. **The double-click / promotion race.** Untouched. The 500ms guard survives verbatim,
   including the subtlety that it is armed by whatever *changed the head* rather than inside
   the Approve handler.
4. **Latency on a live run nobody answers.** Bounded only by core's 300s timer. Phase 4 fixes
   the finished/cancelled cases, which are the ones auto-denial was actually catching; the
   genuinely-live-and-unanswered case is supposed to wait.
5. **Stale labels.** `graphLabel` is a stamp; "which run is still live" comes from a local map
   an SSE gap can make stale. A stale label cannot cause a wrong action — labels gate nothing
   — but it can mislead a human into a wrong click. Cosmetic by construction, imperfect in fact.
6. **What is actually being approved.** Argument rendering is untouched. Approving a tool call
   whose arguments were truncated or mis-rendered remains as possible as it is today.
7. **Not a security boundary.** Core is unauthenticated on localhost. Phase 3 prevents
   *accidental* cross-window answers, not a hand-rolled HTTP call. Correctness boundary, not a
   security one — say so in the PR so nobody mistakes it for the latter.

---

## 9. Review rules that make a tenth round harder

1. **Adding an event to the reducer's alphabet is a design change, not a bug fix.** It reopens
   this document. The machine's value is entirely in the alphabet being closed — a machine
   with a `RunEnded → denied` transition reproduces defect 2 exactly, and more legibly.
2. **`approvalRouter.ts` imports nothing.** Enforced by test. If a fix needs an import, the fix
   is in the wrong file.
3. **No client code may call `agent_approval_response` with `approved: false` outside the Deny
   click handler.** Greppable; make it a lint if it recurs.
4. **`ownerSession` / `ownerGraph` may be read for display and never branched on** once
   `targetClientId` ships. Leave a branch there and the heuristics grow back — that is the
   actual mechanism by which nine rounds cancelled out.
5. **No RPC that can cause a tool call is issued before the panel knows *and has attached*
   its session.** Greppable (§5 phase 3.6).
6. **`Resolution` and `RequestState` are matched exhaustively with no default arm** in Rust and
   with a `never`-checked switch in TypeScript.
7. **One release, one model.** Do not run both paths behind a flag. Two live ownership models
   is precisely the condition that produced this backlog.

---

## 10. What ships when

| Phase | Lands | Kills | Reversible alone |
|---|---|---|---|
| 0 | core registry split | the latent cross-type denial | yes |
| 1 | pure client modules | nothing (no wiring) | yes |
| 2 | panel switchover | **defects 1, 2, 4, 5, 6** | yes |
| 3 | address + enforce | **defect 3** | yes |
| 4 | cancel-on-run-end + resolved events | the latency cost of phase 2 | yes |
| 5 | deferred snapshot | the SSE-gap class | n/a |

Phases 2 and 4 are the pair a user feels: 2 removes the destructive behaviour, 4 removes the
wait that replaces it. Ship them in the same release even though they land in separate commits.
