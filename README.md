# CaliCode

CaliCode is a native AI game engine harness for the web. It pairs a Rust control
plane with a three.js editor, asset workbench, asset library, Play-In-Editor
(PIE) runtime, deterministic frame capture, scripted tests, and a native agent
panel. No MCP, no harness fork, and no generated Three.js code: image-to-3D
reconstruction is a Rust pipeline that emits a data-driven `.cali` asset.

The editor UI follows the CaliCode design language: a dark monochrome console
with Syne branding, Space Mono body type, a games sidebar, an agent chat
column, and a play/code/art/scene/test workspace.

The agent panel is the harness surface: switch provider/model directly or with
`/model`, choose a permission mode, watch tool calls as they drive the editor,
and spawn planner/coder/tester/critic subagents from the same panel.

## Layout

- `core/` - Rust JSON-RPC service: model gateway, project store, checkpoints, assets, baselines, image-to-3D, agent loop.
- `client/` - Vite + React + TypeScript three.js editor.

## Run

```bash
./scripts/dev.sh
```

The Rust core listens on `http://127.0.0.1:8765`; Vite serves the editor on
`http://127.0.0.1:5199` and proxies `/rpc` and `/events` to core.

## Tests

```bash
cd core && cargo test
cd client && pnpm test
cd client && pnpm test:e2e
```
