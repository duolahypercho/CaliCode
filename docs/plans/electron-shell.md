# Electron shell

Status: **plan only, nothing built.** Browser-pipeline measurements taken 2026-08-14; §1.
Recommendation: **§3 — prove the CDP attach first, in a throwaway app, and let that
one result decide the whole thing.** Everything downstream is mechanical; that one
assumption is not.

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

Secondary unknowns the spike should also answer, because they are cheap to check once
it is running: does `Page.captureScreenshot` on a view work while the window is
minimised (Codex [#30605](https://github.com/openai/codex/issues/30605) says theirs
does not — see §5), and does `captureBeyondViewport` give full-page.

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

## 4. Phases

Each phase ends somewhere shippable. `src-tauri/` stays until phase 4 proves out, so
there is always a way back.

- **P0 — spike.** §3. Half a day. Decides everything.
- **P1 — shell parity.** Electron main process: resolve the core binary, spawn it,
  wait for the port, create the window, load the client, wire the dialog. Ship it
  behind a script (`pnpm desktop:electron`) alongside the Tauri build. Done when the
  editor is fully usable in the Electron window with the Tauri build untouched.
- **P2 — the panel becomes a view.** Position a `WebContentsView` over the BROWSER
  panel's rect; core attaches to it. Both paths exist at once here: the stream still
  works, so this is comparable side by side.
- **P3 — delete the pipeline.** Remove the screencast, frame budget, sharpen, cursor
  probe, letterbox mapping, and the client-side painting. This is the payoff commit
  and it should be almost entirely deletions.
- **P4 — packaging.** electron-builder, code signing, notarisation, the sidecar
  layout, `scripts/desktop.sh`. **This is the fiddly part, not the code.** Retire
  `src-tauri/` only when a signed build runs on a clean machine.
- **P5 — test surfaces.** Regenerate every visual baseline (the editor is drawn by
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
