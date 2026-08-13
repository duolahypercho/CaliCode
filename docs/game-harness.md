# Game harness: how to drive CaliCode's agent to build a game

CaliCode gives an agent a real editor — scene graph, asset workbench, PIE
runtime, frame capture, scripted tests — and a harness around it (slash
commands, permission modes, subagents, sessions). What it does *not* give you
is taste. This doc is the instruction layer: the loop, the tool surface, the
commands, and the prompt patterns that turn "make me a game" into a scene that
actually looks and plays like one.

Target runtime: **three.js `0.170` + WebGL2** (`client/package.json`). The
authoring APIs used here — `MeshStandardMaterial`, `InstancedMesh`,
`WebGLRenderer.shadowMap`, `Fog` — are stable through r180, so nothing below
changes if the pin moves.

Companion docs: `docs/harness-parity.md` (what the harness has vs. codex /
opencode / t3-code), `docs/runbook.md` (RPC surface), `docs/verification.md`
(what is proven and how), `docs/templates/city-game.md` (a worked example).

---

## 1. The loop

One iteration of game-building is seven steps. Do not skip 5–7; an agent that
never looks at its own output will happily ship a grey box farm.

| # | Step | Primary tools | Done signal |
|---|---|---|---|
| 1 | **Describe** | — (prompt only) | A written spec: look, scale, entity list, DONE condition |
| 2 | **Generate assets** | `editor_asset_generate`, `editor_asset_preview`, `editor_asset_import_file` | Every asset in the spec exists in the library with a thumbnail |
| 3 | **Place** | `editor_promote_asset`, `editor_object_add`, `editor_update_transform` | `editor_scene_inspect` shows the expected entity count and no entity at the origin by accident |
| 4 | **Script** | `editor_script_write` | Behaviour compiles and moves something; no `script <name>:` lines in the console |
| 5 | **Frame + playtest** | `editor_camera_frame`, `editor_run_pie`, `editor_console_history` | The authored camera shows the gameplay foreground, N frames stepped, and the readable console has zero errors |
| 6 | **Persist visual evidence** | `editor_persist_capture`, `editor_analyze_motion`, `editor_test_add`, `editor_run_tests` | Three chronological frames plus a contact sheet/manifest exist, and the suite is green |
| 7 | **Iterate** | critic pass → back to 2/3/4 | Rubric (§7) scores ≥ threshold on every row |

Two properties make this loop work rather than spin:

- **Step 1 produces a written artifact.** If the goal is not written down with a
  falsifiable DONE condition, the loop in §5 cannot terminate correctly — it
  terminates when the model *feels* finished, which is early.
- **Step 6 produces durable images.** Use `editor_persist_capture(path)` for
  at least three different moments and `editor_analyze_motion` for a labelled
  contact sheet. A model result containing a screenshot data URL is transient;
  a verified project-relative PNG/manifest is evidence a critic and the
  Reports tab can revisit. Text self-assessment ("the city now looks vibrant")
  is not evidence.

### Checkpoint discipline

Call `editor_project_checkpoint` **before** each destructive phase (bulk
placement, a lighting rewrite, a mass transform edit) and `editor_project_save`
after each phase that passed its critic check. Checkpoints are the only cheap
undo; the scene graph has no rewind stack yet (`docs/harness-parity.md`, Tier 2
item 8).

---

## 2. The tool surface

Registered in `client/src/lib/useBrowserTools.ts` and handed to the Rust core at
startup. The agent drives the *real* editor through these — there is no mirrored
copy of editor state, so a tool call and a human click are indistinguishable
downstream.

| Tool | Arguments | Returns | Use it when |
|---|---|---|---|
| `editor_scene_inspect` | — | entities (id/name/kind/transform/assetId), scripts, assets, tests | **First call of every turn.** Never place or edit blind. |
| `editor_object_add` | `name`, `kind`, `position?`, `color?` | the new entity | Adding a primitive or a light directly, without an asset record |
| `editor_object_remove` | `id` | `{removed}` | Cleaning up a mistake; always inspect first to get the id |
| `editor_update_transform` | `id`, `position?`, `rotation?`, `scale?` | `{updated}` | Layout passes, alignment fixes, scale corrections |
| `editor_script_write` | `name`, `code`, `id?` | `{saved}` | Behaviour. Omit `id` to create, pass it to update |
| `editor_camera_frame` | `entityIds?`, `excludeEntityIds?`, `viewDirection?`, `padding?`, `reset?` | camera pose + fit bounds | Author a persistent evidence camera around gameplay entities before captures; exclude sky/backdrop geometry from composition |
| `editor_run_pie` | `frames?` (default 12) | `{frames, captures}` | Playtest. Starts PIE, steps N frames, pauses |
| `editor_capture_frame` | — | `{dataUrl}` PNG | Before any visual judgement, and before saving a baseline |
| `editor_persist_capture` | `path` | `{path, bytes, mime, sha256, frame, timeMs}` | Capture and atomically save a PNG/JPEG without copying its data URL through model context |
| `editor_analyze_motion` | `frames?`, `label?`, `maxCaptures?` | `{pngPath, manifestPath, frames}` | Persist a chronological contact sheet, timestamps, and motion metrics |
| `editor_run_tests` | — | `TestResult[]` | Regression gate after every behaviour change |
| `editor_asset_generate` | `name`, `kind`, `color?`, `metalness?`, `roughness?` | the asset | Building the palette of reusable pieces |
| `editor_asset_preview` | `id` | `{thumbnail}` | Confirming an asset looks right *before* 200 copies of it exist |
| `editor_promote_asset` | `id` | the new entity | Instancing a library asset into the scene |
| `editor_project_save` | — | `{saved, slug}` | End of every phase |
| `editor_project_checkpoint` | — | `{id}` | Start of every destructive phase |
| `editor_select_entity` | `id?` | `{selected}` | Focusing the human's inspector on what you just changed |
| `editor_console_log` | `message`, `level?` | `{logged}` | Narrating a long phase so the human can follow without reading chat |
| `editor_console_history` | `limit?`, `level?` | `{logs, count, available}` | Reading the actual console back; use `level: "error"` as the runtime-error gate |
| `editor_test_add` | `name`, `script` | the test | Locking in an invariant you just fixed |
| `editor_asset_import_file` | `name`, `data` (base64), `mime`, `tags?` | import result | Bringing in an image or 3D file; images route through image-to-3D |
| `editor_model_switch` | `provider`, `model` | `{switched, …}` | Dropping to a cheap model for bulk placement, back up for design |

### Constraints the surface implies

These are not bugs to route around; they are the shape of the editor. Prompts
that ignore them produce tool errors and wasted turns.

- **Geometry kinds are a closed set:** `box`, `sphere`, `cylinder`, `cone`,
  `torus`, `terrain`, `plane` — plus `light` for `editor_object_add`. Every
  form is a composition of those. "Low-poly stylized" is not a limitation here,
  it is the native register.
- **Materials are `MeshStandardMaterial`:** `color`, `metalness`, `roughness`.
  No texture maps from the tool surface (`procedural.ts` can attach a noise map
  when a `seed` is present, but `editor_asset_generate` does not expose it).
  Variety comes from roughness spread and hue relationships, not textures.
- **One light per `editor_object_add` call**, `kind: "light"`, and it is created
  as a *directional* light at intensity 2. The viewport already provides a
  hemisphere fill (0.9) and a key directional (2.4) at `(5, 8, 5)`; scene
  lights add to that, they do not replace it.
- **Evidence framing is explicit:** call `editor_camera_frame` with the hero,
  opponent, goals, and arena IDs before capturing. The exact pose persists;
  decorative sky/backdrop entities stay drawable but no longer control the fit.
- **`editor_run_pie` always pauses when it returns.** Call it again to keep
  simulating; it is a step-N-frames tool, not a play button.

### The script contract

`editor_script_write` bodies run in a hardened Worker
(`client/src/lib/scriptSandbox.worker.ts`). Write an `update` function:

```js
// state.time is the simulation clock in seconds; delta is the fixed step in seconds.
function update(entity, state, delta) {
  entity.rotation.y += 0.8 * delta;
  return state;
}
```

| Available | Not available |
|---|---|
| `entity.position/rotation/scale` as plain `{x,y,z}` | live three.js objects, materials, the renderer |
| `state.time` (seconds), `delta` (seconds), `state.entities` (names) | global `scene` or `input` objects |
| frozen `state.scene` snapshots, `state.find(nameOrId)` | `fetch`, `WebSocket`, `XMLHttpRequest`, `importScripts`, `postMessage`, `Worker`, `indexedDB`, `caches`, `navigator`, `globalThis` |
| `state.patch(nameOrId, {position?, rotation?, scale?})` with finite partial `{x,y,z}` values | materials, visibility, assets, scripts, entity creation/deletion |
| persistent JSON-safe `state.self` and shared `state.world` | DOM, `window`, `document`, live objects |
| ordinary JS and `Math` | timers, storage, external modules |

Only the transform is patched back. A script cannot change colour, spawn an
entity, or delete one — structural change is the agent's job through tool
calls. `state.patch` returns `true` when at least one component was accepted;
unknown targets, malformed vectors, non-finite components, and non-transform
fields are ignored with an actionable script log. `state.scene` and
`state.find` remain frozen snapshots for the entire step. A script that exceeds
**2000 ms** in one frame gets its worker
terminated and the frame reported; the sandbox restarts clean.

### The test contract

`editor_test_add` scripts run in a second sandbox with a request/response
channel to the host. Globals: `scene` (slug + `{id,name,kind}` list),
`entityFor(name)` (synchronous, returns `{position, rotation}` or `null`),
`assert(cond, message)`, `log(text)`, `await step(frames)`,
`await baseline(name, dataUrl, threshold = 8)`. Default timeout 15 s.
The runner drains all outstanding capability calls before marking a test done,
so an unawaited `assert(false, ...)` still fails the test. Await calls for clear
ordering and fresh `entityFor` / `state.world` snapshots.

```js
const before = entityFor("Patrol Car").position.x;
await step(60);
assert(entityFor("Patrol Car").position.x !== before, "patrol car should move");
```

> **Baselines are real now.** `editor_run_tests` passes the same
> `test_baseline_compare` RPC the TESTS panel uses, so `baseline()` inside an
> agent-run test compares against the saved PNG and fails on drift. A
> comparator that cannot be reached returns `{pass: false, distance: 64}`
> rather than a pass — an unreachable comparator is not a matching frame.
>
> This previously synthesised `{pass: true, distance: 0}`, which let a suite
> certify a scene it had never compared. If you are reading an older
> transcript, treat its green baseline assertions as unproven.

---

## 3. Slash commands

Registry: `client/src/lib/slashCommands.ts`. Type `/` in the composer for
autocomplete.

| Command | Usage | What it does |
|---|---|---|
| `/help` | — | Lists every registered command |
| `/loop` | `/loop <goal>` | Autonomous run: re-sends the goal, then "continue", until the agent replies `DONE` alone on a line, the cap is hit, or you press STOP |
| `/model` | `/model <provider>:<model>` | Switches the active model; bare `<model>` keeps the current provider |
| `/compact` | — | One supervised turn that summarizes the transcript into 5–8 bullets and *replaces* it |
| `/diff` | — | Asks the agent to list every file it changed this session |
| `/sessions` | — | Prints saved sessions from `~/.cali/sessions` |
| `/resume` | — | Reloads the most recent saved session |
| `/fork` | — | Branches the current session into a new one |
| `/clear` | — | Clears the visible transcript, keeps the session id |
| `/new` | — | Fresh session id, empty transcript |

Loop mechanics worth knowing before you write one:

- **Cap is 25 iterations** (`MAX_LOOP_ITERATIONS`), each iteration allowing up
  to **10 tool-calling turns** inside the core agent loop. Budget accordingly:
  a phase that needs 400 placements will not fit in one loop unless the agent
  writes a placement routine instead of 400 individual calls.
- **The continuation prompt is fixed:** *"Continue toward the goal. When it is
  fully complete, reply with exactly DONE on its own line and nothing else."*
  Your goal text is only sent on iteration 1 — everything the loop needs to
  keep itself honest must be in that first message.
- **Termination is a regex on `DONE`.** A goal with a soft finish line ends
  early. A goal with a checkable finish line does not.
- **STOP is cooperative** — it lands between iterations, not mid-turn.

### Writing a `/loop` that finishes correctly

Four parts, in this order.

1. **Goal** — one sentence of intent.
2. **Constraints** — the closed set of kinds, the palette, the scale unit, the
   entity budget. State them; the model will not infer your metre.
3. **DONE condition** — countable and inspectable. `editor_scene_inspect`
   should be able to prove it.
4. **Self-check instruction** — capture a frame, judge it against named rubric
   rows, and keep going if any row fails.

```text
/loop Build the road network for the city block grid.

Constraints:
- Only box/plane/cylinder primitives. Unit scale: 1 unit = 1 metre.
- Roads are 8m wide, sidewalks 2m, blocks 40x40m, 5x5 grid.
- Palette: asphalt #2f3236, sidewalk #b8b2a7, curb #8e887c.

DONE when all of these hold:
- editor_scene_inspect reports >= 60 road/sidewalk entities, all named
  road_*/sidewalk_*/curb_*.
- No two road entities overlap (centre-to-centre >= 8 on the shared axis).
- editor_run_pie(12) completes with zero script errors in the console.
- editor_capture_frame returns a frame in which the grid reads as a grid:
  continuous lanes, no gaps at intersections, no z-fighting stripes.

Before replying DONE: capture a frame and score it on silhouette readability,
scale consistency, and colour harmony. If any score is below 7/10, fix it and
do not reply DONE.
```

Anti-patterns: *"make the city look better"* (no DONE), *"add some buildings"*
(no count), *"iterate until it's great"* (unfalsifiable — burns all 25
iterations and ends on the cap).

### Permission modes

Set in the composer footer; passed to `agent_chat` as `permissionMode`.

| Mode | Behaviour | Use for |
|---|---|---|
| `full-access` | No approvals | Long unattended `/loop` runs on a checkpointed project |
| `auto` | Automatic within policy | Normal interactive building |
| `auto-accept-edits` | Edits auto-approved, other tools prompt | Script/asset iteration while you watch |
| `supervised` | Every tool call prompts | First run of an unfamiliar goal; anything touching files |

Rule of thumb: **checkpoint, then `full-access` for a loop; `supervised` for
anything you have not run before.** `/compact` always runs supervised
internally regardless of the selector.

---

## 4. Prompt pattern: decomposition

A game is not one prompt. Split along the axis where a *failure is
localizable*, so a bad phase can be re-run without redoing the good ones.

Good seams: data model → static geometry → dynamic geometry → behaviour →
lighting → polish. Each seam has a distinct DONE condition and a distinct
failure signature.

Bad seams: "the north half of the city" / "the south half" — a failure in one
half is a failure in both, because the mistake is in the shared method.

Per phase, write: **inputs** (what must already exist), **budget** (entity
count, tool-call count), **DONE**, **critic check**. If a phase cannot state its
DONE in one countable sentence, it is two phases.

---

## 5. Prompt pattern: fan-out to subagents

`subagent_spawn` runs a focused agent with its own context and returns a reply
plus a turn count. Roles in the panel: **planner**, **coder**, **tester**,
**critic**.

| Role | Give it | Expect back | Do not give it |
|---|---|---|---|
| `planner` | The phase goal + current `editor_scene_inspect` output | An ordered tool-call plan with counts and names | Freedom to invent scope |
| `coder` | One phase of the plan, verbatim, with the palette and naming scheme | Executed tool calls, a diff summary | Multiple phases |
| `tester` | The invariant in English | An `editor_test_add` script + a run result | Vague "test the game" |
| `critic` | A captured frame **and** the rubric rows to score | Per-row score + the single highest-leverage fix | Permission to be polite |

Fan-out that works in practice:

```text
1. planner   → phase plan (once per phase)
2. coder     → execute the plan          ─┐
3. tester    → behavioural invariants     ├─ these three are the inner loop
4. critic    → score the captured frame  ─┘
5. coder     → apply the critic's single highest-leverage fix
6. goto 4 until every row >= threshold, max 3 rounds
```

Keep the fan-out narrow. Six parallel coders editing the same scene produce
merge chaos — the scene graph has one writer. Parallelism is safe for
*read-only* work (three critics scoring the same frame on different rubric
rows, then a merge) and unsafe for placement.

The interaction-state pass recorded in `docs/harness-parity.md` used exactly
this shape: a 6-agent fan-out applied one house style, then an adversarial judge
scored the result against 10 criteria over 2 rounds until PASS.

---

## 6. Prompt pattern: the harsh visual critic

The default failure mode of an agent building 3D content is *declaring
victory on grey boxes*. The fix is a critic that (a) sees a real frame, (b) is
explicitly instructed to be harsh, (c) scores against named rows, and (d) is
only allowed to return **one** fix at a time.

```text
You are a harsh art director reviewing a frame from a stylized low-poly city
game. You are not being helpful by being kind.

Score 0-10 on each row, with one sentence of evidence per score:
silhouette readability, lighting, material variety, colour harmony,
scale consistency, framerate.

Rules:
- 7 is "shippable". Below 7 is a defect. Do not award 7+ without evidence
  visible in this frame.
- Name the single highest-leverage fix — the one change that raises the most
  rows at once. Exactly one.
- If the frame reads as untextured primitives with flat lighting, silhouette
  readability is at most 4. Say so.

Reply as: rows + scores + evidence, then FIX: <one change>.
```

Then loop: apply the fix → `editor_run_pie` → `editor_capture_frame` →
re-score. Stop when every row is ≥ 7 (or your phase threshold), or after 3
rounds — if 3 rounds do not clear it, the phase plan is wrong, not the
execution.

**Score drift** is the thing to watch. If a critic's scores climb while the
frames look identical, it is scoring the conversation instead of the image.
Re-spawn the critic with a fresh context and only the frame.

---

## 7. Quality rubric for a 3D game scene

Score each row 0–10. **7 = shippable.** Every row is judgeable from one captured
frame except framerate, which comes from the runtime readout.

| Row | What it means | How to check | Fails when |
|---|---|---|---|
| **Silhouette readability** | Every object is identifiable from its outline alone | Squint test: mentally flatten the frame to black shapes on grey. Can you still name each object? | Boxes at uniform size and rotation; a skyline that reads as one bar |
| **Lighting** | Directional key + soft fill, contact darkening where forms meet the ground | Look at the shadow side of a form — it should be *dark but not black*, and objects should not float | Everything evenly lit; no ground contact; single harsh light with black shadows |
| **Material variety** | Roughness/metalness differ meaningfully between material classes | Sample 4 objects: do they have ≥ 3 distinct roughness values? Glass ≈ 0.05, painted metal ≈ 0.3, concrete ≈ 0.85 | Everything at the `0.1/0.7` default from `editor_object_add` |
| **Colour harmony** | A bounded palette with intentional relationships | Count distinct hues. 4–6 total; ≤ 2 saturated accents; the rest desaturated neighbours | Rainbow-per-entity, or one grey for everything |
| **Scale consistency** | One unit means one thing everywhere | Pick the human-scale reference (door, ped, car) and measure 3 other objects against it | A 4-unit door next to a 3-unit building |
| **Framerate** | Smooth at target resolution | PIE readout: FPS and DRAW (real WebGL draw calls, `useFrameStats.ts`) | < 50 fps, or draw calls climbing linearly with entity count |

Practical thresholds for a stylized scene:

- **Draw calls**: budget ~200. The editor builds one mesh per entity, so 800
  entities is 800 draws — that is the ceiling this architecture imposes, and
  the reason repeated geometry belongs in fewer, larger entities.
- **Hue count**: 4–6, with one accent used on < 10 % of surface area.
- **Roughness spread**: at least 3 distinct values in frame.
- **Contrast**: the darkest material should not be `#000` and the brightest not
  `#fff`; keep both inside roughly 8–92 % luminance or the tone mapping clips.

---

## 8. Failure modes and their tells

| Tell | Cause | Fix |
|---|---|---|
| Loop hits the 25-iteration cap | Goal had no checkable DONE | Rewrite DONE as a count `editor_scene_inspect` can verify |
| Loop replies `DONE` on iteration 2 | DONE was subjective | Add "before replying DONE, capture a frame and score …" |
| Everything is at `[0, 0.5, 0]` | `editor_object_add` default position, no explicit placement | Always pass `position`; verify with `scene_inspect` |
| Objects vanish past a point | Camera far = 100, fog 18–42 | Keep the world inside ~40 units or ask the human to widen the camera |
| Console shows `script <name>: …` each frame | Script threw; the frame still rendered | Read the console before trusting a playtest |
| `scripts exceeded 2000ms and were terminated` | Unbounded loop in a script | Scripts do per-entity math only; anything global belongs in tool calls |
| Tests pass but the scene looks wrong | `baseline()` is a no-op under `editor_run_tests` (§2) | Judge visuals with capture + critic; run the TESTS panel for real baselines |
| FPS drops with entity count | One draw call per entity | Merge repeated geometry into fewer entities |

---

## 9. Minimum viable session

```text
/new
<paste the spec: look, palette, scale unit, entity list>
/loop <phase 1 goal with DONE + self-check>      # supervised the first time
… critic round …
/loop <phase 2 goal>                              # full-access, post-checkpoint
/compact                                          # when the transcript is long
/diff                                             # what actually changed
```

`/resume` picks it up tomorrow; `/fork` branches an experiment off a scene you
do not want to risk.
