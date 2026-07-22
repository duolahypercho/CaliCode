# __GAME_TITLE__ — Caliber game project

This folder is a Caliber web game. It is served by caliber-core at its play
URL and rendered inside the Caliber Arcade panel.

## Files

- `index.html` — the entire game: markup, styles, and the game script. Keep it
  a single self-contained file with no external dependencies or build step.

## Rules for coding agents

- Keep the game playable after every change: it must load without errors,
  respond to input, and have a visible objective.
- Keep the Caliber protocol calls intact (and add events for new mechanics):
  `caliber({ type: "ready" })` once at startup,
  `caliber({ type: "fps", value })` about once per second,
  `caliber({ type: "game_event", name })` on meaningful moments (score, win,
  death), and `caliber({ type: "runtime_error", message })` from error
  handlers. The Arcade's LED, FPS/EVT readouts, and console are driven by
  these messages.
- Pure JavaScript + canvas only. No frameworks, no CDN scripts, no fetches.
- Prefer small focused edits matching the request; do not rewrite the whole
  file for a one-line change.

## Testing a change

Reload the Arcade cartridge (or open the play URL in a browser) — the served
files are read from this folder on every request, so saved edits are live
immediately.
