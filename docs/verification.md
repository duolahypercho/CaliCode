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

## Runbook

`docs/runbook.md` documents the local start command, RPC methods, live loop scripts, and provider configuration.
