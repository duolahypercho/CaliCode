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

## Extending without touching source

- **Skills** — markdown + YAML frontmatter (`name`, `description`) dropped in
  the skills directory (`CALI_SKILLS_DIR`). Each enabled one is also a slash
  command: the composer lists them beside the built-ins (tagged `SKILL`) and
  `/<skill> <task>` sends a turn naming it, which the agent pulls in with
  `skill_load`. A skill may not take a built-in's name — the built-in wins.
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
| `~/.cali/sessions/`           | saved transcripts                         |
| `client/.e2e-projects/`       | throwaway; wiped by `pretest:e2e`         |

Current baseline: 267 Rust tests, 257 client unit tests across 25 files.
