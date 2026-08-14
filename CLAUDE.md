# CLAUDE.md

@AGENTS.md carries the shared working agreement — layout, commands, the
verification order, conventions. Read it first. This file adds only what is
specific to working here through Claude Code.

## Ship loop

A change is not done when it compiles, and not done when the tests pass. It is
done when you have driven the thing yourself, looked at it, and found nothing
wrong. Every update runs this loop — not just the ones that feel risky:

1. `cd core && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` (if core changed)
2. `cd client && npx tsc -b --noEmit`
3. `cd client && pnpm test`
4. `osascript -e 'quit app "CaliCode"'` — frees `:8765` for the suite
5. `cd client && pnpm test:e2e --grep-invert @live`
6. **Drive the change headlessly and read the screenshots back** — below.
7. Fix everything step 6 turned up, then start again at step 1.

Leave the loop only on a whole clean pass: no compiler error, no failing test,
no console error, no visual defect, no control that does nothing. Then, for
anything the user will see:

8. `cd client && pnpm desktop:build`
9. `open client/src-tauri/target/release/bundle/macos/CaliCode.app`
10. Screenshot the packaged app and look before reporting.

Never exit by lowering the bar. Editing a test until it stops failing, deleting
an assertion, or loosening a selector to dodge a defect all end the loop
without ending the problem — a test you believe is genuinely wrong gets changed
*and said out loud*, in the same message as the change. Passing the suite
untouched is the evidence that nothing broke, so spend it carefully.

Two passes that do not converge means stop and report what is still broken,
with the output. Do not keep looping silently.

The `.dmg` step occasionally fails on a Finder-permissions quirk in
`bundle_dmg.sh`. The `.app` is still good; say so rather than calling the
build broken.

## Drive it yourself, headlessly

Looking is the point; taking the screenshot is not. Write a throwaway
Playwright script **inside `client/`** (module resolution needs
`client/node_modules`), drive the surface you changed, and read the image back:

```js
import { chromium } from "@playwright/test";
const page = await (await chromium.launch()).newPage({
  viewport: { width: 1440, height: 860 },
  deviceScaleFactor: 2,
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => m.type() === "error" && console.log("[console]", m.text()));
await page.goto("http://127.0.0.1:5199/");  // or :8765 when only the packaged app is up
```

Wire up `pageerror` and `console` every time. A React error that only reaches
the console is invisible in a screenshot, and the screenshot will look fine.

**Exercise it, do not photograph it.** Click the control, submit the form, open
the panel, and check the state that should follow. Then cover what is not the
happy path — loading, empty, error/offline — in both themes, at a narrow width
and a wide one. A layout that only holds up with data is half a layout.

**Prefer an isolated preview to the user's live app.** A temporary entry
(`client/preview.html` + `preview.tsx`) mounting one component with
`window.fetch` stubbed renders every state on demand, needs no core, and cannot
touch the user's real projects in `~/.cali`. Driving the live app means
fighting whatever it restored: one open context menu eats every click as `html
intercepts pointer events`, and the run dies on a 30s timeout instead of
telling you why.

Delete the script and the preview entry afterwards.

**Never drive the user's live screen.** No `cliclick`, no AppleScript UI
events, no synthetic clicks — the user is working in that session, and a
stolen click lands in whatever they had focused. Headless only.

Step 4's `quit app` is the exception, and only that: a clean quit of the
packaged app. A bare `cali-core` that someone else started is not yours to
`pkill` — it is serving their real projects. If it holds `:8765`, skip the e2e
step and say you skipped it.

**Trust the pixels, not the thumbnail.** A downscaled full-page screenshot
invents defects — mono digits sprout strikethroughs, hairlines vanish. Re-shoot
the element at `deviceScaleFactor: 4`, or crop it, before believing what you
think you saw.

## This repo is edited concurrently

Another session frequently has this repo open and lands changes mid-task —
new tabs, new slash commands, core refactors. So:

- Re-read a file before an edit that depends on surrounding lines.
- Never revert an unfamiliar change just because it is not yours; fold it in.
- A `cargo` failure in code you did not touch is usually their in-flight work.
  Rebuild core once (`cd core && cargo build`) before reporting it as broken.
- Same for `tsc`: errors in files outside your change are theirs. Do not fix
  them and do not let them stall your loop — name the file and move on. Re-run
  once at the end; theirs often lands green while you work.
- A `@visual` failure is theirs too if the diff sits inside a masked region.
  Measure it (`ImageChops.difference(...).getbbox()`) and check which component
  owns those pixels before regenerating a baseline you do not understand.

## Fan out when the work is genuinely parallel

Independent surfaces — a sidebar rework, a new page component, an external
research question — are worth separate subagents; give each an exclusive file
list so they cannot collide, and keep integration (App wiring, shared types,
the test run) for yourself. Sequential UI polish on one component is faster
done directly.

## Scope

Prefer the smallest change that satisfies the request, and mention removals
that touch something the user relied on. When an edit deletes UI, check what
that UI was the only home for — the last cleanup pass removed a menu that also
held the subagent spawner, which had to come back as a slash command.
