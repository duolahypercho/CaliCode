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
- Supervised approvals: Rust `supervised_approval_flow_completes` regression plus Playwright `supervised agent tool approval completes live`.
- Native subagents: Rust `subagent_spawn_runs_focused_agent` regression, `subagent_spawn` RPC, the agent-panel spawn row, plus `scripts/agent-subagent-client.mjs` live coordinator/subagent/browser-tool roundtrip.
- Live agent panel: Playwright `agent panel runs a live model reply`.
- Vision baseline loop: `scripts/agent-vision-client.mjs` runs PIE, captures a frame, saves a baseline, compares it, and reports pass/distance through the live model.

## Editor And Assets

- Scene graph, inspector, scripts, theme: covered by Playwright `features.spec.ts`.
- Asset workbench and library: covered by Playwright generate/promote/usage flow.
- `.cali` rendering and promotion: client `procedural.test.ts` plus Playwright `generated cali asset promotes into the scene`.
- Image import through image-to-3D: Playwright `image import triggers image-to-3D and lands in the library`.

## PIE And Tests

- Frame capture cadence: client `pie.test.ts` covers every 3rd/4th frame.
- Fixed-step runtime and filmstrip: Playwright `PIE captures frames`.
- Scripted tests and baseline assertions: client `testRunner.test.ts` covers pass/fail and baseline calls.

## Layout

- `client/scripts/cali-shot.mjs` audits 320/390/768/1024/1440/1920 viewport widths for page overflow, offscreen controls, and multiline labels; the matrix currently reports zero issues across every size.

## Runbook

`docs/runbook.md` documents the local start command, RPC methods, live loop scripts, and provider configuration.
