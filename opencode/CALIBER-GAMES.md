# Building games in Caliber

When the user asks for a game (or a change to one), follow these rules.

## Project shape

- Each game is a folder in the project root containing a self-contained
  `index.html` (no build step, no external dependencies, canvas + vanilla JS).
- The folder becomes a cartridge in the Caliber Arcade automatically; keep
  folder names short and game-like (`breakout`, `star-fall`).
- Tunable look/feel values (colors, sizes, speeds, counts) live in a
  `config.json` next to index.html; the game fetches it at boot and falls back
  to built-in defaults if missing.

## The caliber protocol (required)

Talk to the Arcade with `parent.postMessage({ source: "caliber-game", ... }, "*")`:

- `{ type: "ready" }` once after boot.
- `{ type: "fps", value }` about once per second.
- `{ type: "game_event", name }` on meaningful moments (score, win, death).
- `{ type: "runtime_error", message }` from window error handlers.

## Click-to-edit (required)

Listen for messages from the Arcade:

- `{ type: "caliber:edit-mode", on }` — toggle an edit flag; show a small EDIT
  badge and crosshair cursor; pause gameplay collisions while editing.
- On canvas pointerdown in edit mode, hit-test what was clicked and reply
  `{ type: "edit_pick", entity, props }` where `props` is that entity's
  object from config (colors as "#rrggbb" strings, numbers as numbers).
- `{ type: "caliber:set-prop", entity, key, value }` — apply to the live
  config immediately.
- `{ type: "caliber:get-config" }` — reply `{ type: "edit_config", config }`.

## Quality bar

- The game must load with no console errors, respond to input, and have a
  visible objective and restart path.
- Prefer small focused edits over rewrites when changing an existing game.

## Scripted playtests (required)

Handle `{ type: "caliber:playtest", durationMs, inputs: [{ code, atMs, forMs }] }`:
run your game loop synchronously for the duration with the scripted keys
applied at their windows, collect every game_event/runtime_error emitted, then
reply `{ type: "playtest_result", events, frames, durationMs, finalScore }`.
Structure the game so one frame(dt) function serves both the live loop and
playtests (see any scaffolded game's index.html for the pattern).

## Animation recording (required)

Handle `{ type: "caliber:record", durationMs, fps }`: capture downscaled JPEG
frames of the canvas while the game runs (self-step the game loop if rAF is
stalled), then reply `{ type: "record_result", frames: [dataURL], fps, durationMs }`.
Caliber saves them to `<game>/recording/frame-NNN.jpg` + `recording.json`.
To review an animation, read `recording/recording.json` and then the frames in
order — frame N is at N/fps seconds.

## Live status (recommended)

Report what you are doing to the shared feed so the user and other agents can
see it in the Arcade's LIVE rail:
`POST http://localhost:4870/activity {"actor":"<your name>","action":"editing","detail":"arena/index.html"}`
