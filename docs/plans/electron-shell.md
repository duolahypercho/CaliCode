# Electron shell

Status: **Done. Tauri is removed and Electron is the only shell (2026-08-15). P3 — deleting the screencast pipeline — is the one phase left.**
Browser-pipeline measurements taken 2026-08-14; §1.
Recommendation: **proceed to P1.** The one assumption that could have killed this is
now measured, and it also settled the capture question in our favour (§5).

---

## 0. The decision in one paragraph

CaliCode is already the same three layers Codex Desktop is — a React 18 + Radix
renderer, a thin desktop shell, and a Rust binary doing the work. The only
difference is the middle layer: Tauri, which draws the app with the *operating
system's* webview (WKWebView on macOS, WebKitGTK on Linux). That single choice is
what forces the BROWSER tab to be a video stream instead of a browser, because a
WebKit window cannot host a Chromium view and speaks no devtools protocol. Electron
ships its own Chromium, so the app window and a browser view are the same engine and
the panel becomes a real page. The cost is ~130 MB of bundled Chromium and a
repackaging job. The lock-in we are unwinding is **246 lines and one import**.

## 1. Why — the pipeline is the whole problem

Today the agent's browser is a separate Chrome process, so its pixels can only reach
the app by being copied there:

```
Chromium renders → GPU surface → CDP screencast → JPEG encode → base64 → SSE
  → JS parse → data: URL → JPEG decode → <img> → WebKit composites
```

Electron's path is `Chromium renders → composited into the window`.

Every defect reported against the tab this week was a stage in that list, not a bug
in the browser:

| symptom | stage |
| --- | --- |
| blurry | frame encoded narrower than the panel, then upscaled |
| stutter | frame size against transport bandwidth |
| clicks land nowhere | mapping screen pixels → viewport pixels |
| "feels remote" | encode → transport → decode latency |

They are all now fixed or measured away — 1:1 resolution, 0 dropped frames, 8.3 ms
input — but the *class* of defect only disappears when the pipeline does. Deleting it
is worth more than tuning it, and this plan is mostly a deletion.

What we cannot fix at any effort: text selection, subpixel antialiasing, right-click,
find-in-page. Those are properties of a real view.

## 2. What changes, and what does not

**Unchanged.** All of `core/` — the agent loop, every tool, `browser.rs`'s protocol
work, sessions, projects on disk. The entire React editor. `core` stays a spawned
child process exactly as it is today.

**The shell.** `client/src-tauri/src/lib.rs` is 246 lines doing four things: find the
core binary, spawn it, wait for `:8765`, open a window. That is the whole port, and
it becomes TypeScript instead of Rust.

**One import.** `@tauri-apps/plugin-dialog`, used in exactly one file
(`client/src/lib/workspace.ts`), becomes Electron's `dialog`.

**The browser panel.** `BrowserTab.tsx` stops painting frames and becomes a container
that positions a `WebContentsView`. The screencast, the frame budget, the sharpen-on-
idle, the letterbox mapping, the cursor probe — all deleted.

## 3. The one thing that can kill this — do it first

**Assumption:** core can attach to Electron's `WebContentsView` over CDP and drive it
with the code it already has.

Electron accepts `--remote-debugging-port`, and its views are Chromium targets, so in
principle `browser.rs` changes only where it *gets* a target — attach to an existing
one instead of `Target.createTarget`. If that holds, the 2292 lines of protocol work
carry over. If it does not, this plan is dead and we keep the stream.

**Spike (half a day, throwaway, outside the repo):**

1. Minimal Electron app: a window plus a `WebContentsView` showing a page.
2. Launch with `--remote-debugging-port`.
3. From a script, enumerate targets, find the view, attach.
4. Drive it: `Page.navigate`, the snapshot walker, `Input.dispatchMouseEvent`,
   `Page.captureScreenshot`.

**Kill criterion:** if the view cannot be attached, or input dispatch does not reach
it, stop. Report and keep Tauri.

### Result — 2026-08-15, passed

Electron exposes every `WebContentsView` as an ordinary CDP `page` target, so core
enumerates them exactly as it enumerates Chrome's today. Attached from a separate
process and ran the full set of operations `browser.rs` needs:

```
attached to the panel view: yes
1. navigate     -> Low poly - Wikipedia
2. snapshot     -> 55 interactive refs      (the same injected walker)
3. click        -> url changed: true        (trusted input, not synthetic events)
4. screenshot   -> 264 KB
5. console      -> captured "hello from the panel"
```

**And the capture question resolved better than expected.** Repeated against a window
created with `show: false` — never displayed at all, the strongest form of the test:

```
capture on a hidden window -> 616 KB in 999ms
full-page capture          -> 3145 KB in 461ms
driving it while hidden    -> scrolled to 500
```

So an Electron view captures, full-page, while invisible. We do **not** need to keep a
second headless Chrome for `browser_screenshot` (§5 assumed we might), and we do not
inherit Codex's [#30605](https://github.com/openai/codex/issues/30605) /
[#20146](https://github.com/openai/codex/issues/20146) limitations.

Caveat on what was actually tested: a window that was *never shown*. Minimising a
previously-visible window is a slightly different compositor path and is untested —
worth re-checking at P2, when there is a real window to minimise.

## 3a. What actually breaks

Not a guess — this is every place the client knows it is inside Tauri. Four things,
all visible, all small. P1 is not done until each is ported.

**1. Window dragging.** `data-tauri-drag-region="deep"` in five places (`App.tsx`,
`SettingsPage.tsx` ×2, `GamesSidebar.tsx`, `WorkspaceTabs.tsx`). Tauri reads that
attribute to let a region drag the window; Electron uses CSS
`-webkit-app-region: drag`, with `no-drag` on interactive children inside it.
**Symptom if missed:** the window stops being draggable by its header and tab bar.
`SettingsPage.test.tsx:119` asserts on the attribute, so it moves with the change.

**2. Shell detection.** `lib/desktop.ts` decides "am I a desktop app" by looking for
`__TAURI_INTERNALS__` / `__TAURI__` on `window`. Electron sets neither, so the app
silently concludes it is a plain browser tab. **Symptom if missed:**
`hasOverlayWindowControls()` goes false, the header stops reserving space, and the
macOS traffic lights land on top of our own chrome. Fix by exposing a flag from the
preload script and keying off that instead.

**3. The folder picker.** `@tauri-apps/plugin-dialog`, one import in
`lib/workspace.ts:95`, becomes `dialog.showOpenDialog` over IPC. **Symptom if
missed:** opening a workspace folder stops working. Note it is gated behind
`isDesktopShell()`, so breakage 2 hides this one — fix them together.

**4. Traffic light position.** `tauri.conf.json` sets `trafficLightPosition`, and
`GamesSidebar.tsx` hard-codes a row height to match it (~20pt). Electron has the same
option on `BrowserWindow`, but the offsets need re-tuning by eye.

**What cannot break, because it does not know the shell exists:** all of `core/`,
every agent tool, projects and sessions on disk, and the entire editor UI apart from
the four items above.

## 3b. How the browser should actually be built

The spike settles the mechanism; this is the shape.

**The panel is a `WebContentsView`, and core drives that same view over CDP.** One
browser, as today — the property worth protecting is that the user and the agent are
never looking at two different pages. What changes is that the user's half stops being
a video of it.

```
Electron main ── creates the view, owns its geometry
      │
      ├─ renderer (React)  reports the panel's rect over IPC; renders nothing itself
      │
      └─ core (Rust) ───── attaches over --remote-debugging-port and drives it
                            with browser.rs exactly as it drives Chrome now
```

**Core keeps ownership of the protocol.** Do not reimplement snapshot/click/capture in
TypeScript because the main process happens to have `webContents` APIs to hand. The
2292 lines in `browser.rs` are the single implementation, the tools stay identical,
and the only change is where a target comes from: attach to the view instead of
`Target.createTarget`. The main process should hand core the target id explicitly when
it creates the view rather than leaving core to guess from url or title.

**The hard part is that a native view floats above the DOM.** It is not in the React
tree, so it does not clip, does not scroll, and has its own z-order. Concretely, in
this app:

- Radix dropdowns and dialogs (`WorkspaceTabs`, `SettingsDialog`, `SessionSearchDialog`,
  `ModelPicker`, `GamesSidebar`) portal to `document.body` and would render *behind* the
  view. **Hide the view whenever an overlay is open**, not just when the tab changes.
- The panel has rounded corners and a border; a native view will not clip to them.
  Either accept square corners inside the frame or inset the view by a pixel.
- Dock resize animates. Positioning the view per frame will lag the CSS; either drive
  it from the same `ResizeObserver` and accept a frame of skew, or hide during the
  drag and place it on settle.
- The view must be hidden — not destroyed — when the BROWSER tab is closed, so the
  agent keeps browsing with the tab shut. The spike proves a hidden view still
  captures and still drives.

**Session isolation.** The view loads arbitrary web pages into our own app. Give it its
own `session` partition so page cookies never touch the app's, and keep
`contextIsolation: true` / `nodeIntegration: false` on it with no privileged preload.
Tauri gave some of this by default; here it is explicit and must be written down.

**What gets deleted at P3:** the screencast, `CAST_*` budgets, sharpen-on-idle,
letterbox mapping, the cursor probe, `browser_input`, and all frame painting in
`BrowserTab.tsx`. What survives unchanged: every `browser_*` tool, the snapshot
walker, the ref scheme, `browser_search`, and capture-to-project.

## 3c. Tauri retirement — done 2026-08-15

`client/src-tauri/` is gone, along with `@tauri-apps/*`, the `tauri` script, and
`compare-shells.mjs` (which needed two shells to compare). `scripts/desktop.sh`
was rewritten rather than deleted: it still owns `build|dev|install`, and it
still creates the app with a *stable* local signing identity, because an ad-hoc
signature is keyed to the binary hash and macOS drops the app's TCC grants on
every rebuild. Signing moved from a post-hoc `codesign --deep` to
electron-builder's own, since an Electron bundle's helpers must be signed
inside-out and `--deep` does it in the wrong order.

Three things the removal had to carry rather than drop:

- **The folder picker.** `chooseNativeWorkspace` called `@tauri-apps/plugin-dialog`.
  It now goes through the shell's `chooseFolder`, and `defaultPath` is threaded
  through the bridge so the panel still opens where the caller expects.
- **The icons.** `src-tauri/icons/icon.{icns,ico,png}` and the source SVG moved to
  `client/build-electron/`, which is electron-builder's `buildResources`. Same
  artwork, same `com.calicode.desktop` identifier, so an upgrade replaces the app
  rather than sitting beside it with a second `~/.cali`.
- **The traffic lights.** `trafficLightPosition` is not measured the same way by
  the two shells. Tauri's `y: 23` put the lights ~10pt below the sidebar's
  window-controls row, on a line of their own. Measured against a real window,
  Electron places the group ~6.75pt above the buttons' visual centre, so `y: 13`
  centres them at 20pt — the same line as an `h-10` row with no top padding.

## 4. Phases

Each phase ends somewhere shippable. `src-tauri/` stays until phase 4 proves out, so
there is always a way back.

- **P0 — spike.** §3. Half a day. Decides everything.
- **P1 — shell parity. Done 2026-08-15.** Built and verified: the shell spawns or
  attaches core, opens the window, loads the editor, and the editor renders
  identically — all ten workspace tabs, sidebar, composer, and the three.js PLAY
  scene. `window.cali` reaches the app, so `isDesktopShell()` is true and the
  header still reserves space for the traffic lights. `src-tauri/` is untouched and
  `pnpm desktop:build` still produces the Tauri app. Run it with
  `pnpm desktop:electron`; `CALI_PORT` moves it off 8765 so it can run beside a
  live app instead of stealing that core's `editor_attachment`.

  Three things bit during integration and are worth remembering:

  - **A sandboxed preload cannot `require` a local module.** Electron sandboxes
    preloads by default, so `preload.js` importing `./ipc` for the channel names
    failed *silently* — `window.cali` was simply undefined, which reads as "not a
    desktop shell" rather than as an error. `sandbox: false` on this window is
    safe because it only loads our own client; the panel view keeps `sandbox:
    true` and no preload. Bundling the preload is the stricter fix and belongs
    with P4.
  - **`package.json` is `type: module`**, so the CommonJS output needs its own
    `{"type":"commonjs"}` beside it or `require`/`__dirname` fail at launch.
  - **Drag regions did not need the five component edits §3a predicted.** One CSS
    rule maps `[data-tauri-drag-region]` to `-webkit-app-region`, with `no-drag`
    on interactive descendants — otherwise the tab strip drags the window instead
    of switching tabs. Both other shells ignore the property.

  Still open from P1: traffic-light offsets are copied from `tauri.conf.json` and
  want tuning by eye, and the panel view exists but shows `about:blank` until P2
  wires it to the React panel.

- **P1 — shell parity (original scope).** Electron main process: resolve the core binary, spawn it,
  wait for the port, create the window, load the client, wire the dialog. Ship it
  behind a script (`pnpm desktop:electron`) alongside the Tauri build. Done when the
  editor is fully usable in the Electron window with the Tauri build untouched.
- **P2 — the panel becomes a view. Mechanism proven 2026-08-15, wiring partial.**
  Core now attaches to a browser it did not launch (`browser_attach { endpoint,
  targetId }`) and drives that exact view. Verified against the running shell:
  attach, `browser_navigate` to Wikipedia, `browser_snapshot` returning 55 refs,
  and a 645 KB capture — with the page living in the window as real DOM (235
  links, selectable text), not a picture of one.

  Two things learned:

  - **`Browser` had to stop assuming it owns the browser.** `child` and
    `profile` are now `Option`, and `close()` refuses to send `Browser.close`
    when attached — otherwise shutting the agent's browser down would quit the
    editor the user is working in.
  - **Geometry is load-bearing, not cosmetic.** Capture failed outright until
    the renderer reported the panel's rect: a view with no bounds has no
    surface to composite, so `Page.captureScreenshot` returns nothing. The
    client now reports its rect through `window.cali.setPanelBounds` and skips
    the screencast entirely under Electron.

  **Both remaining items landed the same day.** The shell now hands core the
  panel itself on startup — verified by driving core with no manual attach call
  — and the renderer hides the view whenever a portalled overlay appears, so a
  dropdown cannot open behind it.

  One gotcha worth keeping: **`contextBridge` freezes what it exposes**, so
  `window.cali.setPanelBounds` cannot be wrapped to observe it from a live page.
  A first attempt to test overlay-hiding that way reported nothing and looked
  like a bug in the app; the calls were happening the whole time. The behaviour
  is covered by a unit test instead, which also has to stub `ResizeObserver` —
  jsdom has none, and the geometry effect guards on it.

- **P2 — the panel becomes a view (original scope).** Position a `WebContentsView` over the BROWSER
  panel's rect; core attaches to it. Both paths exist at once here: the stream still
  works, so this is comparable side by side.
- **P3 — delete the pipeline. MUST COME AFTER P4, not before.** The original
  ordering was wrong: the Tauri shell is still the shipping one until P4
  packages a signed Electron build, and the streaming pipeline is the only thing
  that makes its BROWSER tab work. Deleting first would leave the app users
  actually run without a browser panel for the whole gap. The pipeline is dead
  weight *under Electron only*; it stays until Tauri retires.

- **P3 (deferred) — delete the pipeline.** Remove the screencast, frame budget, sharpen, cursor
  probe, letterbox mapping, and the client-side painting. This is the payoff commit
  and it should be almost entirely deletions.
- **P4 — packaging. Done unsigned 2026-08-15; signing is the only piece left.**
  `pnpm desktop:electron:build` produces `release-electron/mac-arm64/CaliCode.app`
  (359 MB) with `cali-core` and the built client staged beside the asar, mirroring
  what `scripts/desktop.sh` stages for Tauri. Verified by running the packaged
  app: it spawned its own bundled core, loaded the editor, created the panel,
  drove it (navigate, 55-ref snapshot, 603 KB capture), and killed its core on
  quit rather than leaking it.

  Three things settled here:

  - **The `sandbox: false` workaround is gone.** `build:electron` now bundles the
    preload with esbuild into a single file with no local requires, so
    `sandbox: true` is back on the editor window. That was P1's one security
    compromise.
  - **`main` and `type` fight.** electron-builder reads the entry from `main`,
    but this package is `type: module` and the shell compiles to CommonJS. The
    `dist-electron/package.json` marker sits nearer the compiled files, so Node
    resolves those as CJS while the client build stays ESM.
  - **The core binary is staged outside the asar.** It has to be a real
    executable on disk to spawn; an asar-packed binary is not.

  Not done: **signing and notarisation.** Deliberately — a real identity belongs
  in CI secrets, not a checked-in config, and the repo already has
  `scripts/dev-signing-identity.sh` for local ones. Entitlements are written
  (`build-electron/entitlements.mac.plist`) and kept minimal: spawning an
  unsigned child under the hardened runtime, localhost networking, and
  user-selected folders.

- **P4 — packaging (original scope).** electron-builder, code signing, notarisation, the sidecar
  layout, `scripts/desktop.sh`. **This is the fiddly part, not the code.** Retire
  `src-tauri/` only when a signed build runs on a clean machine.
- **P5 — test surfaces. Done for macOS 2026-08-15; Linux baselines still blocked.**
  The whole e2e suite passes unchanged against the Electron work — **71/71,
  including every `@visual` spec**. That was the real risk and it did not
  materialise: gating the LiveBar to PLAY, the drag-region CSS, the tab-strip
  overrides and the view-state migration all left the baselines alone.

  The reason is worth stating, because it inverts the original worry: the
  baselines were always rendered by Playwright, which is **Chromium**. The
  shipped Tauri app renders in WebKit. So the baselines have never described
  what a macOS user actually sees — and moving to Electron makes the app match
  the tests rather than diverge from them.

  `client/scripts/compare-shells.mjs` walked all eleven surfaces in both shells
  and passes against the dev shell *and* the packaged app. Its pixel budget is
  6,000, set from measurement: cross-build antialiasing costs 2,666-3,023
  differing pixels, so this catches gross layout breakage and not subtle
  regressions — the `.diff.png` files it writes are the answer to those, and the
  file says so.

  Still blocked: **Linux visual baselines**, unchanged since before this work.
  They can only come from the `visual-baselines` workflow, which checks out the
  pushed branch, so nothing can be regenerated until this lands.

  Open decision: whether the shell comparison belongs in CI. It needs Electron
  and a virtual display on the Linux runner, which is real flakiness risk for a
  check that today takes one command locally.

- **P5 — test surfaces (original scope).** Regenerate every visual baseline (the editor is drawn by
  Chromium now, so all of them move — macOS locally, Linux via the
  `visual-baselines` workflow). Re-point the e2e suite. Check the `:8765` port rule
  still holds.

## 5. What we keep that Codex does not have

Worth protecting through the migration: **our capture path is better than theirs, and
should stay headless.**

Codex renders the browser natively and captures from that same view, which ties
capture to the compositor — [#30605](https://github.com/openai/codex/issues/30605),
screenshots time out when the app is minimised;
[#20146](https://github.com/openai/codex/issues/20146), no full-page capture. Ours
captures from an offscreen Chrome, so it works minimised, behind another window, or
on another Space, and does full-page.

So the target is not "become Codex". It is: **native view for the user, and keep the
agent's capture path independent of what is on screen.** If the spike shows view
capture is compositor-bound, keep a headless Chrome purely for `browser_screenshot`
and let the view serve the human. Two browsers is a cost we rejected for the *user's*
view; for capture it may be the right answer, and the agent does not care which
Chromium answered.

## 5a. Prior art: GooeyPi

[am-will/gooey-pi](https://github.com/am-will/gooey-pi) is a desktop workspace for the
pi / OMP / Prime Agent harnesses — the same shape as CaliCode, and a useful check on
this plan because it already shipped what we are proposing. It is **Electron + React +
TypeScript, tested with Vitest and Playwright**, and it ships "an isolated in-app
browser with an address bar, navigation history, downloads" running on a separate
browser profile. That is §3b, independently arrived at, including the session
partition.

Two things worth taking from it rather than re-deriving:

- **It builds with `electron-vite`** (`electron.vite.config.ts`), which bundles main,
  preload and renderer together. That is the proper fix for the sandboxed-preload
  problem P1 worked around with `sandbox: false`: a bundled preload has no local
  `require` to fail on. Adopt it at P4 instead of the hand-rolled `tsc` + CommonJS
  marker.
- **Their browser handles downloads.** Ours does not, and for CaliCode that is not a
  nicety: the whole point of the panel is finding assets, and "download this `.glb`"
  is the flow it exists to serve. A native view has `session.on("will-download")`,
  which the streamed panel could never have had — so this is a capability the move
  unlocks rather than a gap it introduces. Worth its own item once P3 lands.

GooeyPi also does voice (dictation via OpenAI/Groq/Deepgram/whisper.cpp, plus a
realtime companion). Out of scope here, but it is evidence that this shell choice does
not box the product in later.

## 6. Costs and risks

| | |
| --- | --- |
| Bundle | 151 MB → ~280 MB. Already 151 MB (117 MB resources, 22 MB core, 12 MB shell), so this is +85%, not the 10× it sounds like. |
| Memory | A bundled Chromium instead of the OS webview. |
| Visual baselines | All of them move. WebKit → Chromium changes text rasterisation everywhere. |
| Signing/notarisation | Different pipeline from Tauri's. The main schedule risk. |
| Security surface | Electron needs `contextIsolation`, `nodeIntegration: false`, and a strict `webSecurity` posture. Tauri gave some of this by default; here it is explicit. |
| Linux/Windows | Untested for us either way, but Electron makes them *one* engine instead of three. |

## 7. Open questions

1. Does `WebContentsView` capture survive minimisation? (§3, §5.)
2. Does the PLAY tab benefit or suffer from Chromium? Probably benefits — consistent
   WebGL and real DevTools — but the visual baselines will say.
3. Does anything depend on the Tauri custom protocol or its asset handling?
   `resolve_dist` suggests the client is served over HTTP by core already, which
   would make this a non-issue.
4. Do we keep `src-tauri/` as a supported second shell, or delete it at P4? Keeping
   two is a real maintenance tax; the plan assumes delete.
