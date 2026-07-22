# Caliber

**Caliber is a game coding agent — a coding agent built only for games.**

A generic coding agent verifies its work with builds and tests. Caliber
verifies by playing: it scaffolds a playable game, watches its runtime
telemetry, takes click-to-edit context from what you touch in the live game,
and (next) plays the game itself to check its own changes.

The generic agent machinery (sessions, chat, review, terminal) comes from a
fork of [OpenCode](https://opencode.ai) (MIT — see LICENSE; upstream copyright
preserved) and is deliberately treated as a replaceable component behind the
product. Everything game-specific is ours:

## What is ours

### Caliber Arcade (`packages/app/src/caliber/`)

A gaming pane docked on the right side of every session, with its own visual
system (CRT bezel, scanlines, neon arcade chrome — none of upstream's UI
primitives):

- **New Game** — scaffolds a playable starter game into the session's project
  via caliber-core, serves it, and boots it on the CRT screen.
- **Insert Coin / Scan** — load any local dev-server URL, or discover one via
  real TCP probes in the Rust core (browser no-cors probing as fallback).
- **Live telemetry** — LED, FPS/EVT/SIG readouts, and a console drawer fed by
  the caliber-game protocol.
- Reload / eject / fullscreen, drag-resize, persisted state.

### caliber-core (`caliber-core/`, Rust)

The Rust service that owns game-side responsibilities:

- `GET /health` — liveness.
- `GET /scan` — concurrent TCP probes of common dev-server ports.
- `POST /games/scaffold` — creates a starter game (caliber protocol built in)
  inside a project directory.
- `GET /play/{game}/...` — serves scaffolded games with path containment.

Per the Caliber master plan, Rust is the long-term home for the production
control plane: asset pipeline, playtest orchestration, task/lease durability,
performance budgets. caliber-core is the seed of that layer; capabilities move
here progressively rather than by rewriting the browser UI (which necessarily
stays TypeScript) or discarding upstream's mature agent code.

### The caliber-game protocol

Games report telemetry to the Arcade with one line of glue:

```js
parent.postMessage({ source: "caliber-game", type: "ready" }, "*")
// types: ready | runtime_error {message} | game_event {name} | fps {value}
```

### Brand surface

App title and empty-state wordmark are Caliber. Internal package names keep
the upstream `@opencode-ai/*` namespaces intentionally, so upstream merges stay
cheap while the product surface is ours.

## Running

```bash
bun install
bun run dev:web                                   # studio UI (port 3000/3001)
cd packages/opencode && bun run --conditions=browser src/index.ts serve --port 4096
cd caliber-core && cargo run                      # Rust core (port 4870)
```

Open a session and press the neon ARCADE tab on the right edge.

## Direction

1. Move game project understanding (scenes, assets, budgets) into caliber-core.
2. Game-aware agent tools (MCP) backed by the core: scene inspection, playtest
   runs, performance capture.
3. Asset Foundry per the master plan (Tripo/Meshy adapters, validation gates)
   as caliber-core modules.
4. Engine adapters (Godot first) speaking to the same core.
