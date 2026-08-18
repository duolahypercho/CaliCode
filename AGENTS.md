# AGENTS.md

Working agreement for anyone — human or agent — changing CaliCode.

CaliCode is a native AI game-coding harness: a Rust control plane paired with a
three.js editor and an agent panel that drives that editor through real tool
calls. Read `README.md` for what the product does; this file is about how the
repo works.

## Layout

| Path             | What lives there                                                         |
| ---------------- | ------------------------------------------------------------------------ |
| `core/`          | Rust control plane. JSON-RPC over HTTP + SSE. Owns projects, sessions, agent loop, assets, MCP, skills. |
| `core/starters/` | Compiled-in workspace starters — one directory per starter, `include_str!`d by `starters.rs`. |
| `client/`        | Vite + React + TypeScript editor. Three.js viewport, agent panel, workspace tabs. |
| `client/electron/`  | Desktop shell (Electron). Spawns core, hosts the browser panel as a real view. |
| `shared/schemas/` | `project.schema.json`, `cali-asset.schema.json` — the contracts both sides honour. |
| `scripts/`       | `dev.sh` (run both halves), `desktop.sh` (package the app), live agent clients. |
| `docs/`          | `runbook.md` (operations), `verification.md` (what proves each feature works), plans, templates. |

Core modules map to features one-to-one: `agent.rs`, `rpc.rs`, `store.rs`,
`sessions.rs`, `assets.rs`, `image3d.rs`, `graph.rs`, `mcp.rs`, `skills.rs`,
`workspace.rs`, `devserver.rs`, `config.rs`, `browser.rs`.

## Run it

```bash
./scripts/dev.sh          # core on :8765 + client on :5199, from the repo root
```

The client proxies `/rpc` and `/events` to core, so only `:5199` is opened in a
browser. Both ports are overridable (`CALI_PORT`, `CALI_CLIENT_PORT`).

```bash
pnpm desktop:build        # from client/ — packages CaliCode.app (+ .dmg)
pnpm desktop:dev          # native shell against a live core
```

**One shell, and it is Electron.** A Tauri shell shipped first and was removed
(`docs/plans/electron-shell.md`): its webview is a different engine per platform
— WKWebView, WebView2, WebKitGTK — and none of them can host a second browser, so
the BROWSER tab could only ever be a video stream of a Chrome running elsewhere.
Electron bundles Chromium, so the panel is a `WebContentsView` the window
composites directly and core drives over CDP.

The macOS menu bar reads `CFBundleName`, so an unpackaged `pnpm desktop:electron`
says "Electron" no matter what `app.setName` is; only a packaged build says
CaliCode. Not a bug to chase.

`CALI_PORT` moves the shell off `:8765` so a second instance can run beside a
live app — attaching two clients to one core is worse than a port collision,
because `editor_attachment` is one owner per session and the newcomer silently
steals tool routing.

## Verify before you claim done

Run these from `client/` unless noted, in this order. Everything must be green.

```bash
cd core && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd client && npx tsc -b --noEmit
cd client && pnpm test                 # vitest
cd client && pnpm test:e2e             # playwright; see the port rule below
```

CI runs exactly this (`.github/workflows/ci.yml`), plus `pnpm build`. Clippy
warnings are errors — do not leave any.

**The port rule.** Core binds a fixed `:8765`, and Playwright deliberately
refuses to reuse a running core (`reuseExistingServer: false`) so the suite
never touches your real projects. Anything already holding `:8765` — a
`dev.sh` session, the packaged `CaliCode.app` — must be stopped first:

```bash
osascript -e 'quit app "CaliCode"'     # macOS, if the desktop app is running
```

**E2E isolation.** The suite points core at `client/.e2e-projects` and
`client/.e2e-config.yaml` via `CALI_PROJECTS_DIR` / `CALI_CONFIG`, and the
`pretest:e2e` hook wipes both. Always invoke it as `pnpm test:e2e` — calling
`playwright test` directly skips that wipe and lets state leak between runs.

`@live`-tagged specs need a real provider key (`CALI_OPENAI_API_KEY`); CI and
local runs exclude them with `--grep-invert @live`.

**Visual specs.** Screenshot baselines are per-platform. Development is macOS,
CI is Ubuntu, so Linux baselines can only be produced by the
`visual-baselines` workflow (`gh workflow run visual-baselines.yml`) and
committed from its artifact. Never hand-edit them.

## Conventions

**Comments explain constraints, not mechanics.** Write a comment when the code
cannot show *why* — an invariant, a failure it prevents, a platform quirk.
Never narrate what the next line does or justify the change to a reviewer;
that noise dies the moment the commit lands. Match the density of the file
you are in.

**Rust.** `cargo fmt` is the formatter, no exceptions. Every RPC method is one
arm in `rpc.rs` dispatch plus a unit test near its implementation. There are
72 methods today; keep names `snake_case` and grouped by subject
(`project_*`, `session_*`, `asset_*`, `graph_*`, `image3d_*`, `model_*`).

**TypeScript.** `strict` is on and there is no ESLint config — `tsc -b
--noEmit` plus review is the gate. Prefer named exports, no default exports
outside route-level components. Types shared with core live in
`src/lib/types.ts`.

**Design system.** Colours come only from semantic tokens defined in
`index.css` (`surface-0..3`, `ink-strong|ink|ink-subtle|ink-faint`,
`line|line-strong`, `raised`, `danger-soft`), never raw hex, so light and dark
stay in sync. Chrome uses the system sans; `.font-mono` (Space Mono) is for
code and the wordmark. **No hover border-colour changes** — hover is a
background tint, selection is a background fill. **No focus rings either**:
this is the owner's standing decision, taken twice, and `index.css` suppresses
the outline in one unlayered rule so no utility can reintroduce it. Never add
a `focus-visible:ring-*` utility. `.focus-ring` / `.focus-ring-inset` remain
as inert hooks — a dozen files still spell them, and the classes stay so
restoring rings is a one-block edit rather than a sweep. `ui/focusRing.test.tsx`
enforces the absence; if you believe rings should return, change that test and
this paragraph in the same commit, not the CSS alone. Icons are `lucide-react`
at `strokeWidth` ~1.7.

**Persistence is automatic.** There is no SAVE button: editing `project` state
debounces into `project_save`. Anything that loads a project from core must
register it as already-saved so hydration never writes back.

**Secrets.** API keys are read from the environment (`CALI_<PROVIDER>_API_KEY`)
and never written to `~/.cali/config.yaml`. Do not add a code path that
persists one.

## Accessibility and test contracts

E2E specs depend on these; changing them means changing the specs in the same
commit:

- exactly one `Toggle games sidebar` button exists per sidebar state
- the search dialog exposes `textbox` named `Search games`
- the sidebar resize separator is named `Resize games sidebar`
- the composer exposes `Permission mode`, `Active model`, `Agent prompt`
- the side chat exposes `Side chat prompt`, `Side chat model`, `Send side chat
  message`, and `Stop side chat answer` while an answer is in flight. `/side`
  opens a thread per run, so a second one names its controls `Side chat 2
  prompt` and so on; the first keeps the bare names above, and its tab keeps
  the bare `sidechat` id
- a finished tool row offers `Ask about <tool> in side chat`; the step it opens
  is pinned as `[data-side-anchor]` and dropped by `Stop asking about this step`
- files the side chat opened while answering are listed as `[data-role="reads"]`
- a per-game hover action named `New chat in <title>`
- a per-chat hover action named `Archive <title>`. Archiving is how a chat
  leaves the sidebar — there is no delete there; Settings > Archive is the only
  place one is restored or destroyed
- the empty transcript carries `[data-empty-game-hint]` containing the slug

## The agent browser

`browser.rs` drives a real Chrome over the devtools protocol and the
`browser_*` tools are its surface. Note the name clash: older comments call
the *client webview* tools (`editor_*`) "browser tools" — unrelated.

- Chrome is the user's own install, found automatically on macOS, Windows and
  Linux (chrome, then chromium, then edge, then a playwright cache);
  `CALI_CHROME` overrides the path, `CALI_BROWSER_HEADED=1` shows the window
  for debugging, `CALI_BROWSER_PROFILE` moves the profile off `~/.cali/browser`.
- **A found Chrome is the fallback, not the panel.** When the shell hands core
  its `WebContentsView` there is one browser and the user watches the agent work
  in it. Core still knows how to launch its own Chrome, because the handshake can
  fail and a headless agent has no panel at all; that path is degraded — the tab
  shows a screencast of it — but it keeps working rather than failing.
- The model reads pages as ref-tagged element lists (`browser_snapshot`), not
  HTML or pixels, and clicks refs rather than coordinates. Coordinates exist
  for `<canvas>`, which is the only way to reach a running game.
- **Playing a game is a different verb from using a page.** `browser_key` takes `holdMs`
  because movement is a held W, not a tapped one; `browser_mouse_move` takes a *delta* because
  a camera turns by motion, not by destination; and `browser_play` holds several keys *while*
  looking, because strafing is two keys at once and aiming while advancing is keys and mouse at
  once — neither is expressible as a sequence of single actions. It always releases what it
  held, including when the look fails: separate down/up tools would put a stuck W one error
  away, and a stuck W is a character running into a wall until somebody notices.
- **Recording happens during the action, not after it.** `browser_play` takes `recordFrames`
  and captures them interleaved with the look while the keys are still down, because a
  screenshot taken once the keys come up is a picture of standing still. The frames go straight
  into the same contact-sheet path `video_contact_sheet` uses and only a path and motion
  metrics come back — a dozen base64 JPEGs would cost more context than the rest of the turn,
  and the model cannot look at them anyway.
- **Reading a recording back has two halves, and they answer different questions.** The sheet's
  sibling JSON manifest carries measured motion per frame pair — mean luma delta, mean RGB
  delta, perceptual-hash Hamming distance — and `file_read` turns that into text, which is the
  half to trust for *did it move, and how much*. `image_look` sends the sheet itself to a vision
  model and returns words, which is the half for *what happened*. Neither replaces the other,
  and a provider without vision still has the numbers.
- **Key events carry no `nativeVirtualKeyCode`, deliberately.** It used to be sent the Windows
  VK code, which is a different keycode space on macOS — 87 is keypad-5 — so every held key
  reached the page as `Numpad5` and auto-repeated about twenty thousand times in 600ms. A game
  keyed on `e.code === "KeyW"`, which is the usual way, saw nothing. Chrome derives the native
  code correctly when the field is simply absent. It splits that motion into steps and primes the
  origin first — Blink measures `movementX` against the previous pointer position, so the first
  event of a sequence reports 0 and an unprimed turn arrives one step short. Click the canvas
  once before looking if the game wants a pointer lock.
- `browser_search` deliberately skips Google, which serves this browser an
  interstitial instead of results.
- **The Electron shell hands core its own panel** (`browser_attach`), so core
  drives the `WebContentsView` the user is looking at instead of launching a
  Chrome of its own. The target id is passed, never discovered: guessing by url
  or title would eventually pick the editor's own window, and core would start
  driving the app instead of the page inside it. `browser::tests::live_attach`
  is the regression check: it asserts core drives a browser it did not launch and
  leaves it running.
- **Playing a game is a different verb from using a page.** `browser_key` takes
  `holdMs` because movement is a held W, not a tapped one; `browser_mouse_move`
  takes a *delta* because a camera turns by motion, not by destination. It
  splits that motion into steps and primes the origin first — Blink measures
  `movementX` against the previous pointer position, so the first event of a
  sequence reports 0 and an unprimed turn arrives one step short. `browser_play`
  exists because the other two are strictly sequential: strafing (w+a) or aiming
  while advancing needs keys held *and* the mouse moving at once. Click the
  canvas once before looking if the game wants a pointer lock.
- Files downloaded in the panel land in `~/.cali/downloads`, and
  `browser_downloads` lists them — a download is working material the agent is
  about to pull into a project, not a personal download. A navigation that turns
  into one reports `aborted: true` rather than failing: chrome cancels the page
  load by design, and the file is already on disk.
- The BROWSER tab renders the same page over a CDP screencast, so the user and
  the agent share one browser rather than each having their own. The tab strip
  shows that page's own favicon and title; its accessible name stays `browser`.
- Chrome renders at `deviceScaleFactor: 2` and the cast is sized to the panel
  in *device* pixels. Both matter: a 1x raster downscaled to the cast bound and
  upscaled again by a retina panel is visibly blurry, and it compresses worse.
- A chrome that outlives core keeps the profile's `SingletonLock`. Core clears
  a lock whose pid is gone and diverts to a unique scratch profile when one is
  genuinely held, so a leaked browser cannot wedge the next launch.
- Live coverage is four `#[ignore]`d tests: `cargo test browser::tests::live --
  --ignored`. Run them after touching that module; CI cannot. `live_attach` is
  the one to keep honest — it asserts core drives a browser it did not launch
  *and* leaves it running, which is the shell's entire contract.

## Permission modes

Four modes, and they answer four different questions. `agent.rs` owns the gate
(`tool_gate`), `guardian.rs` owns the judgment, `approvals.rs` owns the asking.

| Mode | Wire value | What it does |
| --- | --- | --- |
| Manual | `supervised` | Asks before every tool call. |
| Auto | `auto` | Asks when the call warrants it — see below. |
| Full access | `full-access` | No gate at all. |
| Plan | `plan` | Reads, plus `plan_write` and `exit_plan_mode`. Nothing else dispatches. |

`auto-accept-edits` still parses so an old session keeps working; the picker
stopped offering it.

**Auto is not a list of tool names.** It used to be, and a list cannot tell a
`file_write` into the game's own `main.js` from one into the user's dotfiles.
A call now goes through four layers, in this order, and each may only be
reached by falling through the one above:

1. **`permissions:` rules** in `~/.cali/config.yaml` — `deny`, `allow`, `ask`,
   last match wins. The user's standing decision, never reviewed by anything.
   **`deny` also removes the tool from what the model is sent**, so it is the
   supported way to stop *paying* for a family, not only to refuse it:
   `{pattern: "browser_*", action: deny}` drops 15 schemas — about 2,000
   tokens — from every turn. `ask` deliberately does not, or the approval card
   would be unreachable. `agent::tests::a_deny_rule_removes_the_family_from_what_the_model_is_sent`
   pins both halves. Bring a denied capability back as an MCP server when a
   given project actually needs it.
2. **The floor** (`auto_floor`) — `project_revert` and untrusted `mcp__*`
   always ask. Two entries, both decidable from the name alone, both wrong
   things to be wrong about.
3. **The agent's own escalation** — every guarded tool's schema gains an
   `ask_user` property in `auto` and only in `auto`. A model that fills it in
   has decided this call needs the user; the string becomes the question on
   the card. One-way: it can add a prompt, never remove one, and it is lifted
   out of the arguments before dispatch so no tool sees a field it never
   declared.
4. **The guardian** (`guardian.rs`) — a second, cheaper model reads the tool,
   its description, the arguments, and the user's own words, and answers
   `ALLOW` / `ASK` / `DENY`.

Reads never reach layers 3 or 4, so a `file_read` costs nothing extra.

Two properties of the guardian are load-bearing and easy to break:

- **Tool results never enter its prompt.** It sees `role: "user"` turns and
  the pending call. A file, a page, or an MCP server cannot argue for its own
  approval. `recent_user_messages` is that boundary; do not widen it.
- **Every failure is `ASK`.** An unparsable reply, an outage, a missing key, a
  reply that reasons its way to "…so ALLOW" — all of them ask the user. A
  guardian that cannot answer degrades the session to Manual, never to Full
  access. `parse_verdict` reads the first token only, for exactly this reason.

Three consecutive guardian denials escalate the message the model gets from
"no" to "stop and tell the user". A human approval resets the tally.

**Layer 0: hooks.** `hooks.rs` runs user-declared shell commands and sits
*above* all four layers — ahead of the `permissions:` rules, the mode, and the
guardian. The guardian is judgment; a hook is policy. A hook costs no tokens,
always runs, and cannot be argued out of its answer by anything in the
transcript, so a call it refuses should never reach a model that might be
talked into allowing it. Measured: a hook-blocked call makes **zero** guardian
requests.

```yaml
hooks:
  pre_tool_use:
    - matcher: "file_write"        # glob over the tool name, same matcher as permissions:
      command: "~/.cali/guard.sh"  # stdin: {hook_event_name, session_id, cwd, tool_name, tool_input}
      timeout_ms: 4000
  session_start:
    - command: "echo 'HOUSE RULE: this project ships only ES modules.'"
  post_tool_use:
    - matcher: "file_write"
      command: "npx tsc --noEmit 2>&1 | head -5"   # stdout lands on the tool result
  stop:
    - command: "~/.cali/keep-going.sh"   # block to re-inject a prompt; top-level turns only
```

- **A hook may only add a block, never remove one** — there is no allow
  verdict, the same one-way property the agent's `ask_user` escalation has. A
  hook that could approve would be a config edit that silently widens Manual.
- **Block with** exit 2 (stderr becomes the reason) **or** stdout
  `{"decision":"block","reason":"…"}` on exit 0, matching Claude Code so a hook
  written for one harness runs in the other. Stdout is scanned from the first
  `{`, so printing a log line before the verdict still blocks.
- **Every failure proceeds** — timeout, spawn failure, or a non-zero exit that
  is not 2 is logged and ignored. The opposite of the guardian's fail-closed
  rule and for the opposite reason: a broken hook means a *check* did not run
  over a call the ordinary gate still sees, and failing closed would let one
  typo wedge the session with nothing to click.
- **`env_clear()` plus a six-key allowlist**, so no `CALI_*_API_KEY` reaches a
  command that came out of a config file. `hooks::tests::secrets_never_reach_a_hook`
  is the regression check.
- The tool *arguments* are on stdin, which is the whole point: a hook can tell
  a `file_write` into the game's own `scripts/` from one into `~/.ssh`, which
  is exactly the distinction a tool-name allowlist cannot make.
- **Global `~/.cali/config.yaml` only.** Project-scoped hooks are deliberately
  absent until they carry first-use consent keyed on the command string —
  checking out a repo must never silently acquire arbitrary code execution.
  Copy the `approved_project_mcp` pattern when adding them.
- **`Stop` fires only for the top-level agent.** Subagents and graph nodes do
  not, and that was measured rather than assumed: a hook written for the main
  turn ("keep going until you say DONE") does not recognise a child's reply, so
  it blocked every one and drove a single `subagent_spawn` through 199 extra
  model calls. `stop_hook_active` tells a hook it is inside its own
  continuation; the real bound is the turn budget, since every re-injection
  spends a turn. This is the seam that lets an autonomous loop be a shell
  script rather than harness code.
- **`PostToolUse` cannot block, only report.** The tool has already run, so a
  refusal there would misdescribe the disk. Its stdout is attached to the
  result as `hookOutput` — which is where a post-write typecheck belongs, since
  the model needs that in the same turn rather than as an approval question. A
  hook that exits 2 has its stderr attached like any other output, because a
  failing check is exactly the case worth reporting.

**Live coverage**, like `browser::tests::live` — CI cannot run it:

```bash
cargo test guardian::tests::live -- --ignored --nocapture
```

It reads your own `~/.cali/config.yaml`, so it judges on whatever provider you
have. The assertions are one-directional on purpose: a real model's exact
verdict is not reproducible (the same `/etc/hosts` write has come back both
`ASK` and `DENY`), so what is asserted is only the direction that matters —
ordinary work must not stop the user, and the dangerous cases must not be
waved through. `the_ask_band_is_reachable` is the one that would catch the
worst regression: a prompt edit that collapses every risky call to `DENY`
leaves the user unable to approve anything, and the approval card unreachable.

**Which model reviews.** The client sends `guardianModel` with the turn — the
cheapest priced model the active provider offers, from models.dev
(`reduceGuardianModels`). `approvals.guardian_model` in config stands in when
the client sends none; the session's own model reviews when both are absent.
Core holds no model literal, same rule as everywhere else.

**Plan mode produces a document.** `plan_write` writes exactly
`<project>/plan.md` — a constant, not a parameter, or the whitelist would be
admitting an arbitrary writer. `exit_plan_mode` takes the finished markdown,
is intercepted in `execute_tool_call` before the ordinary gate, and asks the
user: approve and the session moves to `auto` via an `agent.permission_mode`
event, or deny with a reason, which comes back as a failed call carrying what
they want changed.

## Computer use

`computer.rs` drives **native windows** — the ones `browser.rs` cannot reach because they are
not a web page. `spawn_ledger.rs` is what makes it safe. Note this is now the *third* thing
called "browser tools" in this repo's history: `editor_*` (the client webview), `browser_*` (the
agent's Chrome), and these. They are unrelated.

- **The agent may drive only processes core itself spawned.** `spawn_ledger` records every
  spawn — dev server, agent browser, Blender, MCP servers — and `computer_targets` is the whole
  population. Anything else is refused, and the refusal names what is attachable instead.
- **Entries are a pid *and* the kernel start time**, because pids are recycled. A bare-pid
  ledger would keep vouching for a dead browser after the kernel reissued its number, handing
  the agent whatever now owns it. Every lookup re-reads the start time and compares.
- **What ships, works.** `computer_targets`, `computer_doctor`, `computer_look`,
  `computer_type`, `computer_key`. `computer_click` and `computer_scroll` were built, measured,
  and **withheld**: no synthetic mouse event reaches a background window by any route tried
  (`CGEventPostToPid`, `CGEventPostToPSN`, SkyLight's `SLEventPostToPid`, plus the
  `SLPSPostEventRecordTo` activation record and a primer click). Keyboard does arrive, verified
  against a window that is never key. Both stay compiled under `#[cfg(test)]` with their failing
  live tests as the regression check.
- **Capture is `CGWindowListCreateImage`**, deprecated in macOS 14 and working on 26.4. Chosen
  because the ScreenCaptureKit wrapper crates build and link Swift, and shelling out to
  `screencapture` would need a Seatbelt carve-out. It is one function, so migrating is contained.
- **Two macOS grants are required and both fail silently**: Screen Recording (or captures come
  back blank) and Accessibility (or input posts and vanishes). They attach to whichever process
  is *responsible* for core — the terminal under `dev.sh`, the app bundle when packaged, which
  is why those two contexts differ. `computer_doctor` reports which, and proves capture by
  capturing rather than asserting.
- **Today it has nothing to do, deliberately.** three.js and WebGPU games render in the agent
  browser, where `browser_click` on the canvas already reaches them over CDP. Computer use is
  staged for Unity, Godot and Unreal. `docs/plans/computer-use.md` carries the measurements.
- Live coverage is `#[ignore]`d and must run **serially** — `-- --ignored --test-threads=1` —
  because each test launches Chrome against the same profile and two at once collide on its
  `SingletonLock`, failing for a reason unrelated to what they measure. `computer::tests::live`
  needs `CALI_BROWSER_HEADED=1`; the input diagnostics need the Swift control at
  `core/tests/helpers/clicktarget.swift`.

## The /loop profiles

`/loop` takes a profile, and the default changed: it is now **`standard`**.

| Profile | Invocation | What an iteration is |
| --- | --- | --- |
| `standard` (default) | `/loop <goal>` | The goal, **verbatim**. DONE is taken at its word. |
| `aaa` | `/loop --aaa <goal>` | The quality pipeline: three dependency-free specialist build roots, an integration build, a terminal judge, PIE captures, at least three persisted frames, and a durable report that must clear the score threshold before DONE is believed. |

The pipeline is the stronger machine and none of it was removed — but it used
to be the *only* one, and that is the defect it caused: "fix the typo in the
README" was answered with a three-specialist task graph and a demand for
screenshots. A quality bar that cannot be declined is a tax, not a bar.

- The flag and the interval are order-independent and only count in leading
  position, so `/loop document the --aaa flag` keeps its goal intact.
- `standard` sends the user's words untouched on iteration 1 and adds exactly
  one continuation sentence afterwards. A loop that rewrites its goal every
  iteration is not looping on the goal it was given.
- The evidence gate, the graph proof, and the carry-forward report are all
  `aaa`-only. `AgentPanel.loop.test.tsx` runs its 30 pipeline tests under
  `--aaa`, unchanged, so that contract is still pinned.
- **To flip the default back**, change `DEFAULT_LOOP_PROFILE` in
  `client/src/lib/interval.ts`. One constant, one line.

**The driver lives in core** (`loop_run.rs`). `loop_start` returns as soon as
the run is registered and the driver continues detached, so a loop outlives the
request — and the tab — that started it:

```
loop_start {projectSlug, goal, profile?, intervalMs?, sessionId?}
loop_stop {loopId} · loop_status {loopId} · loop_runs {}
```

- The RPC assembles the system prompt (so `default_system_prompt` and the
  `SessionStart` hooks stay in `rpc.rs`); the driver owns only iteration.
- Tools are re-read every iteration, because an editor can attach or detach
  mid-loop and a cached empty set would tell a connected editor's model it has
  no scene.
- `Aaa` completion defers entirely to
  `loop_report::validate_completion_readiness` — the same gate a model calling
  `loop_report_update` must clear, so the loop cannot finish itself by a route
  the report would have rejected. Measured: with no passing report on disk,
  three DONEs in a row are refused and the run remains live until Stop, while
  `standard` completes in two iterations.
- Progress rides the SSE bus as `loop.iteration`, `loop.done_refused`,
  `loop.completed`, `loop.finished`.
- **The panel rejoins a run it did not start.** On mount it asks `loop_runs`
  whether one is live. With a session open only that session's run is adopted
  (anything else would stream another chat's turns into this transcript); with
  none open — the ordinary state after a reload, since `activeSessionId` is not
  persisted — the project's run is adopted along with its session. Without this
  the run kept working with nobody rendering it and the composer would start a
  second one on top.

**The panel only renders.** `AgentPanel.runLoop` calls `loop_start` and then
draws `loop.iteration` / `loop.done_refused` / `loop.completed` /
`loop.finished`; the run's own turns arrive as ordinary `agent.*` events
because the run reuses the panel's session. Stop is `loop_stop`, not a local
flag — a tab that closes no longer takes the run with it.

Two consequences for tests: the browser never sends `agent_chat` for a loop, so
a spec cannot stub the model by intercepting `/rpc` (that is why
`e2e/loop-gate.spec.ts` now asserts the `loop_start`/`loop_stop` contract and
leaves the DONE gate to `loop_run::tests`); and driver behaviour is tested in
Rust against a scripted provider rather than through a mocked panel.

## Extending without touching source

- **Skills** — markdown + YAML frontmatter (`name`, `description`) dropped in
  the skills directory (`CALI_SKILLS_DIR`). Each enabled one is also a slash
  command: the composer lists them beside the built-ins (tagged `SKILL`) and
  `/<skill> <task>` sends a turn naming it, which the agent pulls in with
  `skill_load`. A skill may not take a built-in's name — the built-in wins.
  - **Some skills ship with core.** `core/skills/*.md` are `include_str!`d
    (`skills::BUILTIN_SKILLS`) and merged in `skills::composed`, ranked below
    every directory so a user file of the same name shadows them; they can be
    disabled like any other. They exist to keep prose *out* of
    `STATIC_SYSTEM_PROMPT`: `goal-loop` is the 673-token quality loop that only
    GOAL-tier turns can act on, and it now costs 69 tokens of description
    instead of 673 tokens on every turn of every session. The merge is
    deliberately not inside `list_from_roots` — that function answers how the
    configured *directories* rank, and its tests exist to pin exactly that.
- **Slash commands** — `~/.cali/commands/<name>.md` (`CALI_COMMANDS_DIR`) plus
  `<project>/.cali/commands/`, project shadowing global. Frontmatter is
  `description` and optional `argument-hint`; **the body is the prompt**, and
  the filename is the command name. They join the menu beside the built-ins
  tagged `Your commands`, and cannot take a built-in's name — refused in
  `commands.rs` *and* in `slashCommands.ts`, two locks on one door.
  `command_list` feeds the menu, `command_render` expands the body only when
  the command is actually fired, so a body never sits in the prompt.
  - Substitution is `$ARGUMENTS` (whole tail) and `$1`..`$9` (words). **An
    unfilled positional is left exactly as written**, because expanding it to
    nothing turns `costs $5.00` into `costs .00` whenever fewer than five
    arguments were passed — silent corruption of a prompt file is worse than a
    visible `$3` saying no third argument arrived.
- **Subagents** — `~/.cali/agents/<name>.md` (`CALI_AGENTS_DIR`) plus
  `<project>/.cali/agents/`. The **body is the child's system prompt**, and an
  optional `tools:` list narrows what it may call. `/spawn <name> <task>` offers
  them beside the four built-in roles (`planner|coder|tester|critic`), which a
  file may not claim.
  - The allowlist is applied in `agent::build_tools`, not by filtering the
    registered map: `build_tools` starts from `core_tool_defs()` and only
    *extends* with that map, so filtering there looked correct and removed
    nothing. `an_agent_allowlist_removes_core_tools_too` pins it.
- **Starters** — `~/.cali/starters/<id>/` (`CALI_STARTERS_DIR`), a `starter.yaml`
  manifest beside a `files/` tree that `workspace_create_from_template` writes to
  disk and then opens as a workspace. Compiled-in starters (`core/starters/`,
  `include_str!`d so a packaged app carries them) are shadowed by a user
  directory of the same id, the arrangement `graph.rs` uses for node templates.
  - **A starter is not a project template.** `store.rs`'s `blank|starter|showcase`
    are *scene documents* the three.js editor owns; a starter is a *repository*
    with its own `package.json` and dev script. Anything with a build belongs in
    a workspace, because a project document round-trips through one debounced
    `project_save` and a real game's file tree does not fit that.
  - **Nothing fetches.** A starter is compiled in or already under `~/.cali`,
    which is the trust level `~/.cali/commands` and `~/.cali/agents` already
    have. A registry that cloned a remote repo is arbitrary third-party source
    arriving because somebody clicked a name, and must not ship without
    first-use consent keyed on the source — copy `approved_project_mcp`. The
    manifest has no `url:` field so the half-built version cannot exist.
  - **Dependencies are not installed.** `npm install` needs the network, and the
    only sanctioned way to run a command on the user's machine is `terminal.rs`,
    which is user-initiated by design. `install:` is reported to the client as a
    string to offer, never spawned.
  - The destination must be absent or empty, paths inside a starter may not
    traverse, and symlinks are skipped rather than followed.
- **MCP servers** — configured in `~/.cali/config.yaml`; their tools join agent
  sessions automatically.
- **Asset library** — one file in `client/src/lib/assetLibrary/repos/`
  exporting `repo: AssetRepo`. A glob picks it up; no index edit.
- **Model catalog** — models and their reasoning-effort levels come from
  models.dev through `@opencode-ai/models` (see `src/lib/modelMeta.ts`), cached
  for a day with the package's bundled snapshot as the offline fallback. Do not
  hardcode model lists.
- **Output cap** — `model.max_tokens` (default 32768) bounds one turn's
  completion, reasoning included. Too small and a long tool call is cut off
  mid-argument; the truncated JSON is kept as `ToolCall.unparsed_arguments` and
  refused by name rather than reaching a tool as an empty argument set. A
  provider that refuses the cap as too large for its model has its own ceiling
  read out of the refusal and retried (`rejected_output_cap`), so raising the
  default cannot lock a smaller model out.

## State on disk

| Path                          | Contents                                  |
| ----------------------------- | ----------------------------------------- |
| `~/.cali/config.yaml`         | model/provider config, MCP servers        |
| `~/.cali/projects/<slug>/`    | project documents                         |
| `~/.cali/browser/`            | the agent browser's Chrome profile        |
| `~/.cali/downloads/`          | files downloaded in the browser panel     |
| `~/.cali/sessions/`           | saved transcripts                         |
| `~/.cali/starters/`           | user-authored workspace starters          |
| `~/.cali/memory/`             | durable memories that apply everywhere    |
| `<project>/.cali/memory/`     | durable memories about one game           |
| `client/.e2e-projects/`       | throwaway; wiped by `pretest:e2e`         |

Current baseline: 1076 Rust tests (plus 17 `#[ignore]`d live ones), plus 2
shutdown tests; 941 client unit tests across 75 files.

## Memory

`memory.rs` is `skills.rs` with the authorship reversed: a skill is written by
the user and pulled in when a task matches, a memory is written by the *agent*
so the next session does not rediscover what this one paid for. One fact per
markdown file, `name` / `description` / `metadata.type` frontmatter, project
scope shadowing global, and the same symlink-escape guard on the scan.

- **The `description` is the whole system.** It is not a summary of the body —
  it is the line a later session reads to decide whether to open the body at
  all, which is why the system prompt carries descriptions and `memory_read`
  carries bodies. `MAX_INDEX_BYTES` (2 KB) bounds that index, because the
  per-session block of the prompt has its own budget and an unbounded index
  would eat it on every turn of every session.
- **The index is derived, never stored.** There is no `MEMORY.md` on disk: a
  file listing the directory beside it is a file that can disagree with it.
- **Appended after `STATIC_SYSTEM_PROMPT`, never into it.** That const is
  byte-identical across projects and sessions so a provider prefix cache serves
  it as one shared read; a per-project index inside it re-bills the whole static
  body every turn. `rpc::tests::memory_reaches_the_prompt_as_descriptions_only_and_never_the_static_body`
  pins both halves.
- **A session-start snapshot**, since the system message is only inserted into
  an empty transcript (`agent.rs`). That is the right lifetime: a memory written
  mid-session is already in context because the agent just wrote it, and it
  survives compaction anyway inside `PROTECTED_HEAD_MESSAGES`.
- `memory_list` / `memory_read` are `ReadOnly`; `memory_write` / `memory_forget`
  are `Guarded` — they write outside any project and outlive the session.
- `CALI_MEMORY_DIR` isolates the global root for a test run, exactly as
  `CALI_SKILLS_DIR` does.

`docs/plans/harness-port.md` carries the rest of the plan this came from —
hooks, file-defined commands and agents, and moving `/loop` into core.
