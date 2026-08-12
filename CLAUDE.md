# CLAUDE.md

@AGENTS.md carries the shared working agreement — layout, commands, the
verification order, conventions. Read it first. This file adds only what is
specific to working here through Claude Code.

## Ship loop

A UI change is not done when it compiles. Finish the loop:

1. `cd core && cargo test` (if core changed) — `cd client && npx tsc -b --noEmit`
2. `cd client && pnpm test`
3. `osascript -e 'quit app "CaliCode"'` — frees `:8765` for the suite
4. `cd client && pnpm test:e2e --grep-invert @live`
5. `cd client && pnpm desktop:build`
6. `open client/src-tauri/target/release/bundle/macos/CaliCode.app`
7. Screenshot it and look before reporting.

The `.dmg` step occasionally fails on a Finder-permissions quirk in
`bundle_dmg.sh`. The `.app` is still good; say so rather than calling the
build broken.

## Verify visually, headlessly

Look at what you built. Write a throwaway Playwright script **inside
`client/`** (module resolution needs `client/node_modules`), point Chromium at
the running instance, screenshot, and read the image back:

```js
import { chromium } from "@playwright/test";
const page = await (await chromium.launch()).newPage({ viewport: { width: 1440, height: 860 } });
await page.goto("http://127.0.0.1:5199/");  // or :8765 when only the packaged app is up
```

Delete the script afterwards.

**Never drive the user's live screen.** No `cliclick`, no AppleScript UI
events, no synthetic clicks — the user is working in that session, and a
stolen click lands in whatever they had focused. Headless only.

## This repo is edited concurrently

Another session frequently has this repo open and lands changes mid-task —
new tabs, new slash commands, core refactors. So:

- Re-read a file before an edit that depends on surrounding lines.
- Never revert an unfamiliar change just because it is not yours; fold it in.
- A `cargo` failure in code you did not touch is usually their in-flight work.
  Rebuild core once (`cd core && cargo build`) before reporting it as broken.

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
