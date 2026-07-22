# Caliber Studio loop state

Updated: 2026-07-21 (post-pivot)

## Direction change (user decision)

The scratch-built demo was removed on request. New base: a fork of OpenCode
(`opencode/`, branch `caliber-arcade`, shallow clone of anomalyco/opencode)
with a gaming surface added on the right side of the session view.

## Current state

- `opencode/packages/app/src/caliber/` — the Caliber Arcade panel: unique
  gaming UI (CRT bezel, neon arcade chrome, scanlines), Insert Coin / Scan
  port discovery, reload/eject/fullscreen, drag-resize, persisted state,
  console drawer, and FPS/EVT/SIG readouts fed by an opt-in postMessage
  protocol ({ source: "caliber-game", type: ready|runtime_error|game_event|fps }).
- Integration surface: two small edits in
  `opencode/packages/app/src/pages/session.tsx` (import + docked sibling of
  the measured panel row, so OpenCode's own width logic adapts).
- Verified in the running app: panel docks and resizes correctly, Scan found
  a live server on :5173, a canvas game loaded in the CRT, LED/SIG went LIVE
  from the ready message, FPS/EVT readouts update from protocol messages.
- `packages/app` typecheck passes; commit `b0193d3` on branch `caliber-arcade`.

## How to run

- `cd opencode && bun run dev:web` (app, port 3000/3001)
- `cd opencode/packages/opencode && bun run --conditions=browser src/index.ts serve --port 4096`
- Open a session, click the neon ARCADE tab on the right edge.

## Iteration 2 (commit 20e3843): identity + Rust core

- `opencode/caliber-core/` — Rust (axum) service: /health, /scan (real TCP
  probes), /games/scaffold (starter game with the caliber protocol), /play
  static serving with containment. Built, unit-tested, verified end to end:
  New Game in the Arcade scaffolds into the session project and boots on the
  CRT with GAME READY telemetry.
- Brand surface: app title + empty-state wordmark now Caliber; upstream
  package namespaces kept for cheap merges. CALIBER.md is the identity doc.
- Full Rust rewrite of the UI/agent was assessed and rejected (browser UI
  cannot be Rust; rewriting upstream agent code discards the fork's value).
  Rust adoption is progressive via caliber-core per the master plan.

## Iteration 3-4 (commits 4468495, 8189df9): full identity + proven agent loop

- Global Caliber theme: dark-first violet/neon token override across the whole
  app — it no longer resembles OpenCode visually. Wordmark + title rebranded.
- Scaffolded games ship with AGENTS.md (protocol + rules for coding agents).
- END-TO-END PROVEN in the UI: New Game (Rust scaffold) → session prompt →
  agent (opencode gateway free model deepseek-v4-flash-free) edited the game
  (magenta stars, win-at-5 banner, caliber win event) → cartridge live in the
  Arcade with SIG LIVE.
- Credential reality: MiniMax key invalid (401), OpenAI OAuth expired (401),
  Claude CLI OAuth revoked. Free gateway models work — the demo runs on them.
- Known residue: composer Send button needs a recheck after the server restart
  (the wedged dev server, not the UI, blocked it); home screen has minor
  un-themed surfaces.

## Next candidates

- Session-header toggle + keybind registered through OpenCode's command system.
- Auto-start the game dev server from the project (spawn via OpenCode terminal).
- Ship the caliber-game protocol as a tiny npm snippet games can drop in.
- Gamepad passthrough and viewport presets in the arcade deck.

## Production loop (current) — iteration log

Goal: dogfood to AAA/production quality, fit the macOS app. Branch
caliber-arcade in opencode/, 14 commits. Stack: vite :3001, opencode serve
:4096, caliber-core :4870 (Rust), /Applications/Caliber.app installed.

Iteration 1-2 shipped (commits 11163dd, ba893a8):
- Game library: core /games/discover + /games/register; Arcade lists project
  game folders as cartridges. Verified: "a breakout game" prompt -> agent
  built it -> cartridge appeared -> click -> playing (SIG LIVE).
- Caliber.app bundle in /Applications (icon, plist, signed); core reuses
  existing port instead of panicking.
- opencode.json: free default model + CALIBER-GAMES.md instructions (protocol
  + click-to-edit contract for all agent-built games).

Iteration 3 (cda6473): PLAYTEST SHIPPED — caliber:playtest protocol, steppable
frame(dt) template, Arcade button + verdict. Verified: scripted sweep scored 2,
events captured. Iteration 4: hot reload + auto-playtest shipped — cartridge file changes
trigger reload + scripted playtest automatically (verified hands-off).
Remaining candidates:
1. Agent-facing playtest (MCP tool in core so turns self-verify) — agent plays the game via __caliberStep/input script and
   reports events (the flagship "verifies by playing" feature).
2. Auto-load newest cartridge when an agent turn creates one (SSE-driven).
3. Composer default model at home level; hide DEV debug bar for product feel.
4. Godot adapter spike per engine-neutral protocol.

Iteration 5 (c4b42d3): Caliber.app self-contained — core serves built studio
from bundle Resources; no dev server needed for UI. Next: app spawns opencode
serve as managed child (double-click completeness), then full packaged-app
dogfood pass.

Iteration 6: cold-start complete — Caliber.app spawns opencode serve as
managed child; double-click brings up the whole product. PRODUCTION LOOP
CONCLUDED: journey (prompt->build->cartridge->play->click-edit->auto-playtest)
all verified inside the packaged stack.
