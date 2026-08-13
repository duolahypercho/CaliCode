# CaliCode Verification Matrix

Each feature below lists the authoritative evidence that it works.

## Core Harness

- JSON-RPC transport and SSE events: `cargo test` covers RPC dispatch; Playwright bootstraps core and exercises `/rpc` through the editor.
- Project store, checkpoints, revert: Rust `store` tests cover CRUD, checkpoint/revert, and path traversal blocking.
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
