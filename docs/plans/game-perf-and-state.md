# `game_perf` and `game_state`

Status: **`game_perf` shipped. `game_state` proposed.**

`game_perf` is live in `browser.rs` (`PERF_SCRIPT`, `perf_expression`) and
`tools.rs` (`budget_verdict`), with eight unit tests and a live run recorded in
`docs/verification.md`. One caveat carried forward: the WebGPU draw counter is
written and unit-pinned but **never exercised against a real device** —
headless Chromium exposes no `GPURenderPassEncoder`, so only the guard that
skips it is proven. Anyone touching a WebGPU game should check it first.

Recommendation: **build `game_perf` first and alone.** It needs nothing from
the game, works on any engine, and it is the tool that turns "AAA" from a
rubric score into a number. `game_state` needs the game's cooperation and is
worth less; ship it second.

---

## 0. The decision in one paragraph

The `/loop` can already act on a running game (`browser_play`), capture it
(`video_contact_sheet`), and judge it (`image_look`, `baselines`). Every one of
those answers a question about *pixels*. None answers "did the player actually
move 4.2 units" or "is this holding 60fps." So an `aaa` loop can iterate for
hours toward a quality bar that is defined as an average score in
`loop_report`, with no frame budget anywhere — and the only occurrence of
"fps" in this repository is `aaa-fps.json`, a genre template. **A quality bar
with no budget is a taste contest.** These two tools give the loop numbers to
converge on, and `game_perf` gives it the one that makes the word AAA mean
anything.

---

## 1. Two worlds, and which one this is for

This is the distinction that decides the whole design, and it is easy to miss
because both are "the game."

| | World 1 — the project document | World 2 — the attached workspace |
| --- | --- | --- |
| What it is | CaliCode's own scene JSON, rendered by the client viewport | a real repo with `package.json`, run by `devserver_*`, viewed in BROWSER |
| Who reads it | `editor_scene_inspect` — 28 `editor_*` tools already cover it | nothing |
| Who measures it | nothing | nothing |

`editor_scene_inspect` reads `liveProjectRef.current` — an in-memory JSON
document. It is not a runtime probe and cannot see a frame rate, a draw call,
or where an entity ended up after physics ran.

**An AAA 3D game is world 2.** Both tools target the page in the agent
browser, over the CDP connection `browser.rs` already owns.

## 2. Naming

`game_perf` and `game_state` — a new subject group, not `browser_*`.

Two reasons. This repo already has three unrelated things called "browser
tools" (`editor_*`, `browser_*`, `computer_*`) and AGENTS.md has to spend a
paragraph untangling them; a fourth entry does not help. And the questions
these answer are about the *game*, not the transport — when the native path
(`computer.rs`, staged for Unity/Godot/Unreal) arrives, `game_perf` should
keep its name and change its backend, rather than acquire a `computer_perf`
twin that measures the same thing.

## 3. `game_perf`

```
game_perf { durationMs?: 2000, budget?: boolean }
```

Returns:

```json
{
  "frames": 118, "durationMs": 2000,
  "fps":     { "mean": 58.9, "p50": 60.0, "low1": 31.2 },
  "frameMs": { "p50": 16.6, "p99": 34.1, "max": 41.0 },
  "longFrames": { "over16ms": 12, "over33ms": 3 },
  "drawCalls":  { "mean": 1840, "max": 2210 },
  "triangles":  { "mean": 940000 },
  "heapMB": 214,
  "api": "webgl2",
  "budget": { "targetFps": 60, "verdict": "fail", "over": ["drawCalls", "low1"] }
}
```

**`low1` is the number that matters** and the reason not to just report mean
FPS. A game that runs at 60 and hitches to 20 four times a second reports a
mean near 55 and *feels* broken. The 1% low is what the player experiences;
mean FPS is the metric that lies. If the loop only ever optimises one number,
it should be this one.

### How it works, and why it needs nothing from the game

One `Runtime.evaluate` with `awaitPromise: true` — the existing
`Browser::eval` already sets that flag, so the tool is a single call that
resolves when the sampling window closes.

The script:

1. Finds the largest `<canvas>` on the page.
2. Re-acquires its live context: `canvas.getContext('webgl2') ||
   canvas.getContext('webgl')`. **Per spec, `getContext` returns the *same*
   context object once created** — which is what makes this work with no page
   reload and no cooperation from the game.
3. Wraps `drawArrays`, `drawElements`, `drawArraysInstanced`,
   `drawElementsInstanced`, `drawRangeElements` to count calls and accumulate
   primitives from the `count` argument.
4. Also wraps `GPURenderPassEncoder.prototype.draw` / `drawIndexed` — the
   stated target set is "three.js and WebGPU games," so counting only WebGL
   would silently report zero draw calls on half of them, which is worse than
   reporting nothing.
5. Hooks `requestAnimationFrame` to timestamp each presented frame.
6. Resolves after `durationMs`, then **restores every original in a `finally`**.
   A patch that leaks because the promise rejected leaves the game slower for
   the rest of the session, and the agent would then be measuring its own
   instrumentation.

Engine-agnostic falls out of instrumenting the *graphics API* rather than the
engine: three.js, Babylon, PlayCanvas, raw WebGL and WebGPU all bottom out in
the same handful of draw entry points. Reading `renderer.info` instead would
have meant finding the renderer, which is exactly the problem `game_state` has
below.

### The budget

A per-project frame budget, in the project's `.cali/`:

```yaml
budget:
  targetFps: 60
  maxDrawCalls: 1500
  maxTriangles: 1000000
  maxHeapMB: 512
```

`game_perf` compares and returns a verdict. This is the strategic half of the
tool: once a budget exists, `loop_report` can carry a perf line per iteration
and `validate_completion_readiness` can refuse a `completed` report that
regressed it — the same fail-closed shape the evidence gate already uses for
screenshots and scores. "Make it AAA" becomes "hold 60fps at this triangle
count," which is a target a loop can actually converge on.

Absent a budget file the tool still returns raw numbers with no verdict. It
should never invent a target.

## 4. `game_state`

```
game_state { name?: string, limit?: 50, offset?: 0 }
```

Returns entity transforms from the live scene graph — name, position,
rotation, scale, visible — plus the camera pose and entity count. Paginated
and compact-by-default, because the alternative is a 4000-entity dump into the
transcript.

**This one needs the game's help, and that is the honest cost.** Under Vite or
any ESM bundle, `const scene = new THREE.Scene()` is module-scoped and
invisible from `window`. Resolution order:

1. `window.__cali_game = { scene, camera, renderer }` — the convention. Our
   project template sets it; one line.
2. Sniff `window` for an object with `isScene === true` (three.js marks its own
   types this way, which is how it does internal checks across module copies).
   Catches globals-style projects.
3. Fail with the fix: *"no scene handle found — add `window.__cali_game =
   { scene, camera, renderer }` after you create them."* An error that names
   the remedy costs one turn; an error that says "not found" costs several.

A cloned third-party repo will hit case 3 until the agent edits one line —
which it can do, since it has `file_edit`. That is acceptable, and it is why
this tool ships second: `game_perf` works on everything on the first call.

## 5. Gate placement

Both are pure reads with no egress and no writes:

```rust
access: Access::ReadOnly
```

Which gives, with no edit to `agent.rs`: runs unprompted in `auto`, never
reaches the guardian (reads skip layers 3 and 4), asks in `supervised` only
because that mode asks for everything.

Both also belong in `PLAN_MODE_TOOLS`, alongside `browser_snapshot`,
`browser_console` and `editor_scene_inspect`, which are already there. They
read a page that is already open and send nothing anywhere — the exact
membership test that list documents.

## 6. Tests

In `tools.rs` beside the arm, per the house rule:

- `instrumentation_is_always_restored` — a script that throws mid-window still
  leaves `drawElements` unpatched. This is the one that matters most; a leaked
  patch corrupts every later measurement.
- `a_page_with_no_canvas_reports_it` rather than dividing by zero.
- `low1_is_computed_from_the_worst_frames_not_the_mean` — pin the percentile,
  since it is the whole point of the tool.
- `webgpu_draws_are_counted` — a page using `GPURenderPassEncoder` must not
  report zero.
- `budget_absent_returns_numbers_without_a_verdict`.
- `game_state_without_a_handle_names_the_fix` — assert on the remedy string,
  not just the failure.
- `game_state_paginates` and defaults to compact.
- both are `ReadOnly` and both are in `PLAN_MODE_TOOLS`.

## 7. Cost and order

`game_perf` is one `ToolDef`, one dispatch arm, one ~80-line injected script,
and the tests above. It touches no other module.

`game_state` is the same shape plus a one-line addition to the project
template.

Build `game_perf` first. It is the one that works everywhere, and it is the
one that gives the `/loop` something to optimise against — which makes every
later tool (image generation, audio, animation) evaluable instead of merely
producible.
