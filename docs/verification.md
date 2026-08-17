# CaliCode Verification Matrix

Each feature below lists the authoritative evidence that it works.

## Core Harness

- JSON-RPC transport and SSE events: `cargo test` covers RPC dispatch; Playwright bootstraps core and exercises `/rpc` through the editor.
- Project store, checkpoints, revert: Rust `store` tests cover CRUD, checkpoint/revert, and path traversal blocking.
- Restore points (`checkpoint_create` / `_list` / `_restore` / `_prune`): Rust `rpc` tests run against a real git fixture and prove that taking one leaves `git status --porcelain`, the index and HEAD byte-identical, that a restore returns a modified-then-deleted tracked file without moving HEAD or the branch, that a clean tree still yields a usable point, that listing merges git refs with project copies newest first, that pruning keeps exactly `keep`, that a game with no workspace round-trips through the project copy, and that untracked files are reported as not covered.
- Chat archive (`session_archive` / `session_restore`, `session_list { archived }`): the sidebar can only archive, so Rust `archiving_hides_a_chat_from_the_live_list_and_restoring_brings_it_back` and `save_keeps_an_archived_chat_archived` prove the stamp survives autosave and the two lists stay disjoint, and `archiving_a_session_hides_it_but_keeps_its_worktree` proves nothing is cleaned up until an explicit delete. `deleting_project_sessions_also_clears_the_archive` keeps a removed game from stranding entries. Client `SettingsPage.test.tsx` covers listing, restore, the two-step permanent delete, and the empty state; `GamesSidebar.test.tsx` proves the row menu offers Archive and no longer offers Delete; Playwright `archives a chat from the sidebar and restores it from the archive` runs the whole round trip.
- Model config and switching: `model_list` / `model_switch` verified live through the Codex Router gateway; the agent panel exposes provider presets, suggested models, and a direct switch control.
- Asset import, hash dedupe, usage, glTF export: Rust `assets` tests plus live RPC calls.
- Screenshot baselines: Rust `baselines` tests cover identical and different images.
- Image-to-3D `.cali` pipeline: Rust tests cover ingest, validate, generate, source lookup, pass order; live `image3d_review` combines deterministic hash with a model verdict.

## Agents

- Browser tool loop: Rust `browser_tool_loop_completes` regression plus `scripts/agent-tool-client.mjs` live run.
- Per-turn activity: client `AgentPanel.activity.test.tsx` verifies one collapsed latest action per Enter, paired tool-call expansion, elapsed/total worked time, foreign-session isolation, and safe file actions. Playwright `activity.spec.ts` resumes a saved turn, expands it, opens the real workspace file, and checks DIFF/FILE views with line counts.
- Supervised approvals: Rust `supervised_approval_flow_completes` regression plus Playwright `supervised agent tool approval completes live`.
- Native subagents: Rust `subagent_spawn_runs_focused_agent` regression, `subagent_spawn` RPC, the agent-panel spawn row, plus `scripts/agent-subagent-client.mjs` live coordinator/subagent/browser-tool roundtrip.
- Live agent panel: Playwright `agent panel runs a live model reply`.
- Vision baseline loop: `scripts/agent-vision-client.mjs` runs PIE, captures a frame, saves a baseline, compares it, and reports pass/distance through the live model.
- Bound task graphs: Rust graph/agent/tools regressions prove node sessions are reserved before events, inherit the owner's workspace and approval route, reject spoofed bindings, and fail closed for legacy unbound runs.
- Loop reports: Rust `loop_report` and RPC tests prove atomic JSON/Markdown/HTML persistence and discovery; client `ReportsTab` tests cover render, safe file opening, offline state, and running-only polling.
- Side chat (`/side`): Rust `advisor` tests prove the endpoint is offered only the four readers in `READ_ONLY_TOOLS` (`only_the_four_readers_are_ever_offered` also names the writers that must never appear), that a call outside the whitelist is refused rather than dispatched and leaves the file byte-identical, that every read is pinned to the observed game so another project's files stay unreachable, that the tool loop is bounded and ends in prose, that it never writes under `sessions_root`, and that a side-chat model pick overrides one call without moving the saved active model (an unknown provider is refused, not ignored). Streaming is addressed by a client-minted `streamId` and never a session id: `a_stream_id_puts_the_answer_on_the_bus_as_it_arrives` and `without_a_stream_id_nothing_is_published` prove both directions. Client `SideChat.test.tsx` covers the read-only RPC surface, its own command set, the unsent `/side` draft, stopping an in-flight answer, the per-call model override, live deltas settling into the returned reply, and deltas from another question being ignored; Playwright `/side opens the side chat with the question waiting, unsent` covers the whole path from the agent composer. Anchoring (`Ask about <tool> in side chat`) is covered by Rust `an_anchored_question_names_the_step_it_was_opened_from`, `an_absent_or_blank_anchor_adds_no_framing`, and `an_over_long_anchor_keeps_its_head_and_is_marked_truncated`, plus client `ToolRow` and `SideChat` tests for the offer, the pinned step, and dropping it. The thread itself is owned by `App` and keyed by game, so closing the tab does not discard it (`SideChat thread ownership`); it is still memory-only — nothing about a side chat reaches disk or the run's session.

## Editor And Assets

- Scene graph, inspector, scripts, theme: covered by Playwright `features.spec.ts`.
- Asset workbench and library: covered by Playwright generate/promote/usage flow.
- `.cali` rendering and promotion: client `procedural.test.ts` plus Playwright `generated cali asset promotes into the scene`.
- Image import through image-to-3D: Playwright `image import triggers image-to-3D and lands in the library`.

## PIE And Tests

- Frame capture cadence: client `pie.test.ts` covers every 3rd/4th frame.
- Capture persistence: `useBrowserTools.test.ts` and Playwright `visual-runtime.spec.ts` prove one-call live capture/persist plus console readback; Rust `capture_persist` tests enforce real PNG/JPEG decoding, traversal/secret/size bounds, atomic writes, and durable project-store routing even when a game has an attached workspace.
- Motion analysis: `useBrowserTools.test.ts` verifies deterministic fixed-step sampling, while Rust `video_analysis` tests cover bounded contact sheets, frame labels, motion metrics, atomic evidence persistence, and malformed/oversize inputs.
- Fixed-step runtime and filmstrip: Playwright `PIE captures frames`.
- Scripted tests and baseline assertions: client `testRunner.test.ts` covers pass/fail and baseline calls.
- Frame budget (`game_perf`): Rust `tools` tests pin the budget verdict on `fps.low1` rather than the mean, the restore list, the idle-frame count, the WebGPU wiring, and the sampling clamp. The measurements themselves were taken live against a headless Chromium page drawing a known 7 `drawArrays` per frame: reported `drawCalls.mean` 7 and `triangles.perFrame` 7 exactly, `api` `webgl2`, `idleFrames` 0. The same page rendering nothing reported 180 of 180 frames idle at a nominal 120fps, which is the case a frame rate alone would have called perfect. A page hitching every tenth frame reported `p50` 120.5 against `low1` 17.1 — the gap the tool exists to expose. A page with no canvas reports the reason; the patched `drawArrays` returned to native with no own property left behind. **The WebGPU counter is unverified live**: headless Chromium here exposes no `GPURenderPassEncoder`, so only the guard that skips it is proven. The `aaa` completion gate now requires a passing `Performance` check alongside build/play/test, so a run that never timed a frame cannot declare itself done: `completion_requires_a_performance_check` and `completion_rejects_a_measured_frame_budget_that_missed` pin both halves.

## Layout

- `client/scripts/cali-shot.mjs` audits 320/390/768/1024/1440/1920 viewport widths for page overflow, offscreen controls, and multiline labels; the matrix currently reports zero issues across every size.
- Playwright visual specs cover every workspace tab plus 1440, 1280, and 768 layouts. macOS baselines are generated locally; Linux baselines remain CI-workflow-owned.

## Loop completion gate

`loop_report_update` is fail-closed: a loop cannot be marked `completed` on the
agent's say-so. Driven live against an isolated core, the gate refuses in this
order, each with a distinct message, and only opens when every condition holds:

1. at least 2 iterations
2. the last iteration's outcome is `passed`
3. that iteration has an agent run with a non-empty `agentId` — proof the work
   actually fanned out rather than being narrated by one agent
4. a passing `build` check
5. a passing `test` check
6. visual evidence (screenshot, video, or contact sheet) on that iteration
7. average objective score at or above the threshold (default 90)

This is the mechanism that stops "declaring victory on grey boxes": every
condition demands an artifact a critic can revisit, not a claim. Rust coverage
lives in `loop_report` (`validate_completion_readiness`).

## Subagent fan-out

`scripts/mock-model.py` is a scripted OpenAI-compatible provider that lets the
agent loop be exercised with no live model — core skips its key check for
`127.0.0.1` base URLs. It answers the parent's first turn with three
`subagent_spawn` calls in one assistant message and holds each subagent
response open, so overlap in the logged windows is the measurement.

Driven against a real `agent_chat` (`full-access`, no editor attached, 40 core
tools offered), one prompt produced five model requests — parent, three
subagents, parent — and the turn completed in 2 turns:

```
parent    window  1.512s ->  1.512s
subagent  window  1.515s ->  3.025s
subagent  window  1.517s ->  3.027s
subagent  window  1.517s ->  3.028s
parent    window  3.032s ->  3.032s
start skew 0.002s · wall span 1.513s (sequential would be ~4.5s)
```

The three subagents start within 2 ms of each other and their windows fully
overlap, so `agent.rs`'s `join_all` fan-out is genuinely concurrent rather than
sequential-with-a-parallel-shaped-API.

## The full graph loop, from one prompt

`scripts/mock-model.py <port> graph` plans a five-node graph and runs it, with
a judge that scores 70 on its first verdict and 95 on its second — so the graph
can only finish if a rejection actually re-queues its builders. One
`agent_chat` produced 15 model calls (3 parent, 5 build-node, 5 monitor,
2 judge) and `graph_status` reported 5/5 passed, `status: complete`:

```
26.403  parent      -> graph_plan
26.407  parent      -> graph_run
26.412  graph-node  ┐
26.416  graph-node  ├ three roots concurrent, 5 ms start skew
26.417  graph-node  ┘
27.925  monitor x3    one per root
27.935  graph-node    integration — waited for all three deps
29.452  judge #1      score 70, below the threshold of 90
29.459  graph-node    re-ran carrying the punch list
30.974  judge #2      score 95, pass
30.981  parent      -> DONE
```

That covers the whole claimed architecture in one run: dependency-ordered
parallel waves, a monitor per node, a blind judge, and per-item re-queue on
rejection. Monitors are called with **0 tools** (a pure verdict) while the
judge is offered the full tool surface so it can inspect rather than trust.

What this does **not** cover is model quality — whether a real model decomposes
a goal well, or whether its scores mean anything. That still needs a provider.

## Blender assets

- Headless export: Rust `blender` tests cover non-Blender-backed assets, a
  missing binary, and bounded stderr diagnostics. Verified end to end against
  Blender 5.1.2 — a 105 KB `.blend` exported to a 69,684-byte GLB whose glTF
  JSON chunk parses to mesh `Suzanne` at 1,966 vertices. `export` fails when
  Blender exits 0 without writing a GLB, which is how a script error surfaces.

## Prompt caching

- Anthropic models on OpenRouter carry caller-placed `cache_control`
  breakpoints (system prompt + newest user turn). Rust `model` tests assert the
  captured wire body carries them for `anthropic/claude-sonnet-4-5` and does not
  for `openai/gpt-4o`, and that `role: "tool"` and empty content are never
  marked. Live provider confirmation is still outstanding.

## Runbook

`docs/runbook.md` documents the local start command, RPC methods, live loop scripts, and provider configuration.
