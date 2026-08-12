# CaliCode UX punch list — next iteration

Merged from four independent read-only audits (shell/nav, agent panel, creation surfaces, design system). Every claim below was spot-checked against source before landing here. Ranked strictly by impact on a newcomer's ability to use the editor, not by cost.

**Path corrections carried over from the audits:** `GamesSidebar.tsx` and `SettingsDialog.tsx` are in `client/src/components/workspace/`, not `components/editor/`. All paths below are corrected and relative to the repo root.

---

## In-flight conflict warnings — read before assigning

Another session is refactoring the agent panel and the client sandbox files. **Do not patch these in parallel.** Items touching them are marked `⚠ CONFLICT` and should be handed to the session that owns the file, applied after that refactor lands, or cherry-picked as a rebase-on-top patch.

Conflict surface:

- `client/src/components/editor/AgentPanel.tsx` and its tests (`AgentPanel.activity.test.tsx`, `AgentPanel.loop.test.tsx`)
- `client/src/components/editor/GraphPanel.tsx` (rendered by, and wired from, AgentPanel)
- `client/src/lib/useBrowserTools.ts` (agent tool bridge)
- `client/src/lib/scriptSandbox*.ts`, `frameSandbox.ts`, `frameTestSandbox.ts`, `hardenWorkerScope.ts`, `cspFrameWorker.ts`, `testRunner.ts`, `pie.ts`

Everything in Tier A that is **not** marked `⚠ CONFLICT` is safe to ship in parallel today.

---

# TIER A — ship next

High impact, self-contained, low regression risk. 14 items.

---

## A1. Restore focus indication app-wide

**Impact:** The app is currently unusable by keyboard. Tab moves focus and nothing on screen changes — including on hover-revealed buttons that materialise with no indication they are focused. WCAG 2.4.7 failure.

**Files**
- `client/src/index.css:191-196` (the blanket suppression)
- `client/src/components/ui/{button,input,textarea,select,tabs,dialog}.tsx` (each carries `focus-visible:outline-none`)
- ~60 `focus-visible:outline-none` occurrences in feature code
- Bare `outline-none` on text inputs users must type into: `EntityProperties.tsx:59,79,93,102,111`, `AssetBuilder.tsx:65,636,665`, `AssetLibrarySection.tsx:168,208`, `ArtTab.tsx:117,160`, `CodeTab.tsx:116`, `FileEditor.tsx:251`

**Change**
1. Delete the rule block at `index.css:191-196`. Keep `[data-no-focus-ring]` as a narrow opt-out (used by the search input at `SessionSearchDialog.tsx:84`, which has its own container treatment).
2. Add one token-driven ring to `index.css`: `:focus-visible { outline: 2px solid var(--line-strong); outline-offset: 2px; }`.
3. Strip `focus-visible:outline-none` from the six primitives so they inherit it, then sweep the ~60 feature-code overrides.
4. Replace the dead `transition-colors` on raw text inputs (nothing to transition — they have no `focus:`/`hover:` variant) with `focus:border-ink-faint`. `ArtTab.tsx:108` already does this via `focus-within:border-ink-faint` on the wrapper; promote that into the `Input` primitive.

**Verify:** Tab from the top of the window through sidebar → tabs → composer → resize handles. Every stop shows a ring. Then Tab in light and dark theme — the ring must be visible in both. Confirm the search dialog input still has no ring.

---

## A2. Five panels are hardcoded dark and disappear in light theme

**Impact:** Light is the default on a light-mode Mac (`App.tsx:77-81` reads `prefers-color-scheme`). A newcomer on a light-mode machine opens BUILD and gets a white page with white-on-white borders where the SAVE button and the active gizmo mode are the *least* readable things on screen; `BUTTON_BASE`'s `hover:text-[#dcdcdc]` makes labels vanish entirely on hover.

**Files**
- `client/src/components/editor/AssetBuilder.tsx:60-67, 199, 462, 465, 483, 489, 493` — confirmed: `TOGGLE_ON = "border-white/40 text-[#e6e6e6]"`, `TOGGLE_OFF = "border-white/10 text-[#9c9c9c]"`, canvas `0x0b0b0b`
- `client/src/components/workspace/TweakPanel.tsx:23,25,30,37,42,45,55` — confirmed: `bg-[#0c0c0c]/95`, `border-white/[0.16]`, `text-[#dadada]`
- `client/src/components/workspace/PlayOverlay.tsx:37,51,58,65,74-78` — confirmed: `bg-black/50`, `border-white/10`, `text-[#c0c0c0]`
- `client/src/components/editor/Viewport.tsx:60` (three.js background)
- `client/src/components/workspace/{LivePreview.tsx:66,125-135, ArtTab.tsx:187, TestTab.tsx:22-26}`

**Change** Mechanical substitution against tokens that already exist (`index.css:26-45`, exposed via `@theme inline` at `:110-122`): `#0c0c0c`→`bg-surface-0`, `#8f8f8f`→`text-ink-subtle`, `#d4d4d4`/`#dcdcdc`/`#e6e6e6`→`text-ink-strong`, `border-white/[0.12]`→`border-line-strong`, `border-white/10`→`border-line`, `bg-black/50`→`bg-surface-0/80`. For the two three.js backgrounds (`AssetBuilder.tsx:199`, `Viewport.tsx:60`) copy `AssetPreview.tsx:131-133,151-156` verbatim — it reads `--surface-0`/`--line-strong` off `getComputedStyle` and remounts on `[theme]`. `TOGGLE_ON` becomes `bg-surface-3 text-ink-strong border-line-strong`. `TestTab.tsx:22-26`'s `SEVERITY_TINT` (`#c8c8c8`/`#8f8f8f`/`#949494` — HIGH is currently *lighter* than MED) becomes `--danger-soft` / `--ink` / `--ink-subtle`.

**Verify:** Set OS to light mode, open BUILD, PLAY (with tweak panel open), ART, and TEST. Every border, label, and button must be legible; hover must never reduce contrast. Repeat in dark.

---

## A3. Switching files in CODE silently destroys unsaved edits

**Impact:** Type 40 lines into a workspace file, click another file in the tree, come back — gone. No prompt, no toast. Same loss on tab switch, because `App.tsx:1561` unmounts the whole CODE panel. Confirmed at `FileEditor.tsx:57-59` (`setDraft("")` fires unconditionally in the `[workspaceId, path]` effect) while `:125` computes `dirty` and never guards on it.

**Files** `client/src/components/workspace/FileEditor.tsx:48-71,125`, `client/src/components/workspace/FileTree.tsx`, `client/src/App.tsx:1561`

**Change** Hoist a `Map<path, draft>` of dirty buffers into App so switching away and back restores text; on mount, seed `draft` from the map before the read resolves. Minimum acceptable version: bail out of the reset with a confirm when `dirty` is true. Independently, make the CODE panel persistent rather than conditional — mirror the always-mounted Viewport trick at `App.tsx:1520-1526` (keep mounted, hide with `opacity-0 pointer-events-none`). Render the `MODIFIED` chip in the FileTree row so users can see which files are dirty *before* navigating.

**Verify:** Edit file A without saving → click file B → click file A. Text is intact. Edit file A → switch to PLAY → back to CODE. Text is intact. FileTree shows a modified marker on A throughout.

---

## A4. Save and autosave failures are invisible

**Impact:** `App.tsx:806-812` autosaves on an 800ms debounce; on failure it calls `pushLog(..., "error")`. The only destination is LiveBar's console, which is `useState(false)` — collapsed by default (confirmed `LiveBar.tsx:26`), inside the right-hand tools dock, which is itself hidden when `toolsVisible` is false or the window is under 1024px. `WorkspaceTabs.tsx:24-26` explicitly tells the user "There is no SAVE button — the project document autosaves on edit", so they have been instructed to trust a mechanism whose failure is unobservable. Same path swallows `open failed`, `attach folder failed`, `reveal failed`, `import failed` (`App.tsx:872, 451, 1003, 1160`).

**Files** `client/src/App.tsx:799-815`, `client/src/components/workspace/LiveBar.tsx:26,58-101`

**Change**
1. Add a persistent save indicator next to the header title in `App.tsx` — `Saved` / `Saving…` / `Save failed — retry` — driven by `lastSavedRef` vs the serialized project.
2. Surface any `level === "error"` log as a transient toast at App level.
3. In LiveBar's always-visible row, add an error-count badge on the CONSOLE button and auto-expand the console on the first error of a session. Replace the text `▸`/`▾` disclosure glyph with a real chevron icon so it reads as a control.

**Verify:** Stop the core process, edit the project, wait 1s. Header shows `Save failed`, a toast appears, the CONSOLE button shows a red count, the console auto-opens. Restart core, edit again → returns to `Saved`.

---

## A5. The agent cannot be stopped ⚠ CONFLICT

**Impact:** Highest-severity item in the agent panel, and it hits the newcomer's very first prompt. Two merged findings:

- **A normal turn has no stop control at all.** The stop affordance exists only under `looping ?` (confirmed `AgentPanel.tsx:2472`). A plain message runs up to `maxTurns: 20` of tool round-trips — with file writes and shell commands enabled by default (see A6) — and the only escape is closing the window. The send button just greys out (`:2487`).
- **The loop's Stop button is a placebo.** `stopLoop` only mutates a ref (confirmed `:1835-1837`: the entire body is `cancelLoopRef.current = true`). A ref mutation triggers no re-render, so `disabled={cancelLoopRef.current}` at `:2477` is never re-evaluated — it flips to disabled at an arbitrary later moment when unrelated state updates, so the control appears to randomly grey out. The flag is only read at the top of the next iteration (`:1616`); the in-flight `agent_chat` runs to completion first.

**Files** `client/src/components/editor/AgentPanel.tsx:1616-1619,1835-1837,2472-2492`, `client/src/lib/rpc.ts:26` (takes no signal today), and eventually `core/src/rpc.rs` (has `graph_cancel`, no `agent_cancel`)

**Change**
1. `const [stopping, setStopping] = useState(false)` set inside `stopLoop`; drive both `disabled` and the label from state, not the ref.
2. In `stopLoop`, immediately `say("■ Stopping — finishing the current step, then halting.", "tool")` so the transcript acknowledges the click within one frame.
3. Render the stop button whenever `busy`, not only when `looping`. Give it a text label ("Stopping…") while pending.
4. Thread an `AbortSignal` through `rpc()` and abort the in-flight `agent_chat` fetch on stop; then `completeActivityTurn`, `settleRunningToolRows` (already exported at `:160`), and append "Turn cancelled — tools already dispatched may still finish." Cancellation is then bounded by a network round-trip, not by `maxTurns`.
5. Follow-up (separate PR): add a real `agent_cancel` RPC in core. The client affordance must not wait on it.

**Verify:** Send a long prompt, click Stop. Within one frame: the button labels itself "Stopping…", a transcript line appears, and the turn ends within one round-trip. Repeat inside `/loop`.

---

## A6. Full-access is the default permission mode ⚠ CONFLICT

**Impact:** Confirmed `AgentPanel.tsx:760` — `useState("full-access")`. A first-time user's first prompt runs every tool without asking, including file writes and shell commands. The only disclosure is a small pill tinted `#e58a52`; the explanatory hint "Runs every tool without asking" lives inside a dropdown they have no reason to open.

**Files** `client/src/components/editor/AgentPanel.tsx:760,2311-2335,395-401`

**Change** Default to `"auto"` (Sandbox — safe tools free, irreversible writes ask). If product insists on full access as the default, then at `:2313` give the trigger a filled danger treatment plus the word "unsandboxed", and render the hint text inline in the composer on first use.

**Verify:** Fresh profile → first message that would write a file → an approval card appears rather than a silent write. Switching to full access requires an explicit, visibly-warned selection.

---

## A7. "Attach folder" is invisible, and Play/Code mean two different products depending on it

**Impact:** The deepest IA problem in the shell, and three reviewers hit it independently. Attaching a folder gates Code, Play-via-dev-server, Reports, and worktrees — it is the single most consequential action in the product. Its only route is a `⋯` glyph that is `opacity-0` until `group-hover` (confirmed `GamesSidebar.tsx:459-460`), then the third item in a seven-item menu. Hover-reveal has no touch equivalent. Consequently PLAY renders either a dev-server iframe or a three.js toy scene, and CODE renders either a repo file tree or a list of scene scripts — same label, same icon, opposite mental models, with nothing on screen explaining which one you are looking at.

**Files** `client/src/components/workspace/GamesSidebar.tsx:315-322,454-478`, `client/src/App.tsx:1508-1610`

**Change**
1. On the game row: when `project.workspaceRoot` is null, render a **persistent, labeled** `Attach folder` chip instead of nothing. When set, render the folder basename in `text-ink-subtle` so users can see which folder a game points at.
2. Give the `⋯` trigger `opacity-60` at rest rather than `opacity-0`.
3. When `!workspace`, render a one-line banner above the tab body: "No folder attached — showing CaliCode's built-in scene. **Attach folder**", the button wired to `handleProjectAction(project, "attach")`.
4. Stretch (fold into A11's vocabulary pass if cheap): label the tabs for what they show — `Scene Preview`/`Scene Scripts` in doc mode, `Dev Server`/`Files` in workspace mode.

**Verify:** Create a game without touching the mouse-hover path — the attach affordance is visible at rest. Open PLAY and CODE on a folderless game — both explain what they are showing and offer the attach action. Attach a folder — the row shows the basename, the banner disappears.

---

## A8. Every destructive action is one unconfirmed click with no undo

**Impact:** Confirmed `App.tsx:1623-1628` — the ArtTab `✕` handler is a bare `assets.filter(...)` with no check against `entities`. The card renders `IN USE 3` and, 22 lines later, an unlabeled `✕` that orphans those three entities' `assetId`; the project autosaves 800ms later and there is no project-level undo anywhere in the app. Same for DELETE ENTITY. In the builder, the per-row `✕` sits 6px from the row's select button at `text-[10px]`.

**Files** `client/src/components/workspace/ArtTab.tsx:205-232`, `client/src/App.tsx:1623-1628`, `client/src/components/workspace/EntityProperties.tsx:115-121`, `client/src/components/editor/AssetBuilder.tsx:561-568`

**Change** When `uses > 0`, require a confirm naming the consequence: "Remove drone-1? 3 entities in the scene use it and will lose their mesh." Same for DELETE ENTITY. Restructure the ArtTab card footer as `PROMOTE | EDIT | ✕` with the `✕` visually demoted (`text-ink-faint`, not equal weight). Give the builder's row `✕` the app-standard `min-h-[28px]` hit target and separate it from the select button with a border.

**Verify:** Delete an in-use asset → confirm dialog names the affected entities. Cancel → nothing changes. Confirm → entities are cleaned up, not orphaned.

---

## A9. Fixed-width panels clip themselves at the dock's own minimum width

**Impact:** The tools dock is `overflow-hidden` with `lg:min-w-[360px]` (`App.tsx:1487-1489`) and the UI invites dragging it there. Confirmed `TestTab.tsx:81` is `w-[388px] shrink-0` — **388 > 360**, so the playtest column collapses to zero, taking the Run Playtest button and filmstrip with it, and the issues panel overhangs the clip boundary with no scrollbar and no way to reach it. `AssetBuilder.tsx:460` is `flex` with a `w-[280px] shrink-0` aside → an 80px 3D viewport, no breakpoint anywhere in the file. `SceneGraphCanvas.tsx:146-147` has 434px of fixed chrome in a 360px box plus `md:overflow-hidden`, so the asset column at hardcoded `COLUMN_X = 540` is permanently unreachable.

**Files** `client/src/components/workspace/TestTab.tsx:40,81`, `client/src/components/workspace/CodeTab.tsx:44`, `client/src/components/editor/AssetBuilder.tsx:460,500`, `client/src/components/workspace/SceneGraphCanvas.tsx:146-147,179`, `client/src/components/ui/dialog.tsx:19`

**Change** Mirror the pattern `SceneGraphCanvas` already uses in the same directory: `flex-col md:flex-row` root, side column `w-full shrink-0 border-t md:w-[388px] md:border-l md:border-t-0`. Apply to TestTab (`w-[388px]`), CodeTab (`w-[236px]`), and AssetBuilder (`flex-col lg:flex-row`, aside `w-full lg:w-[280px]`, viewport `min-h-[280px]`). In SceneGraphCanvas, drop `md:overflow-hidden` for `overflow-auto` at every size. In `dialog.tsx:19`, change `w-full max-w-lg` to `w-[calc(100%-2rem)] max-w-lg` — confirmed there is no horizontal inset today, so below 512px every dialog in the app is edge-to-edge with clipped corners.

**Verify:** Drag the dock resize handle to its minimum. TEST, CODE, BUILD, and SCENE all remain fully usable — every control reachable, either stacked or scrollable. Open any dialog at a 400px window width; it has margin on both sides and intact corners.

---

## A10. Chrome header pass: fake window controls, a dead primary button, unnamed icons, a dead end

**Impact:** Four separate lies in the highest-value pixels of the layout, all in one small area:

- **Fake macOS traffic lights.** Confirmed `GamesSidebar.tsx:216-220` — three 12px `aria-hidden` circles in `#ff5f57/#febc2e/#28c840` with no handler, rendered whenever `hasOverlayWindowControls()` is false. Users click the red one to close and nothing happens.
- **The loudest button in the app is disabled.** Confirmed `App.tsx:1369-1382` — the `ml-auto` slot holds a bordered, raised, primary-tinted "Open in" button with a `ChevronDown` that promises a menu; the click handler calls `openInBlender()` directly, there is no menu; it is `disabled` unless the user has previewed an imported `.blend`, so it is greyed out on first run and for most sessions forever.
- **Chrome icons have no visible names.** Toggle-sidebar / Back / Forward / Search are bare 15px Lucide glyphs. `TooltipTrigger` appears 4 times in the whole app; the `Tooltip` primitive already exists and `AgentPanel.tsx:29` already imports it.
- **Assets Library is a room with no door.** `App.tsx:1430-1436` replaces the main column and the header drops every button but the title. Clicking the nav row again is a no-op. With the rail collapsed there is no exit at all.

**Files** `client/src/components/workspace/GamesSidebar.tsx:90-101,213-224,243`, `client/src/App.tsx:70-71,1367-1382,1430-1436`

**Change**
1. Delete the three traffic-light spans. Use the reclaimed space for the wordmark and collapse the header from two 40px rows to one.
2. Delete the "Open in" button from the shell header. Blender launch belongs in the Assets tab / `AssetPreview`, where `blenderAsset` is actually selected. If it must stay in chrome, render it only when `blenderAsset` is non-null, drop the chevron, and label it `Open in Blender`.
3. Wrap `HeaderIcon` (`GamesSidebar.tsx:90-101`) in the existing `Tooltip`, reusing the `label` prop already threaded through — roughly six lines, and it fixes every icon in the chrome at once. Do the same for `CHROME_ICON_BUTTON` call sites. Note `App.tsx:70-71` and `GamesSidebar.tsx:96` are the *same class string character-for-character*; collapse them to one shared component while you are here.
4. Add a `← Back to chat` button at the left of the header when `mainView === "library"`, calling `setMainView("chat")`.

**Verify:** Browser build shows no fake traffic lights. Hovering any chrome icon names it. First run shows no greyed-out primary button. From Assets Library, one labeled control returns to chat without navigating to a different game.

---

## A11. One noun per concept — user-visible strings only

**Impact:** A newcomer cannot tell whether Projects and Games are the same thing, whether Chats and Tasks are the same thing, or where "ART" is. Verified sequence in a single sitting: sidebar header **Games** → nav row **New game** → dialog titled **"Create project"** whose body uses both words in one sentence → primary button reads **"Create project"** on one path and **"Create game"** two steps later → a name collision says *"A **project** with this name already exists"* (`App.tsx:883`) via one path and *"A **game** called X already exists"* (`App.tsx:479`) via the other → sidebar rows are **chats** but a failure says *"could not create **task**"* (`App.tsx:967`) and the APIs call them **sessions** → the Build tab's empty state says *"generate some in **ART** first"* (`App.tsx:1656`) for a tab that `WorkspaceTabs.tsx:16` labels **Assets**. Separately, "Assets Library" (installs third-party packs) and the "Assets" tab (things inside your game) are two different features with colliding names.

**Files** `client/src/App.tsx:479,883,967,1656,1929-1954`, `client/src/components/workspace/{NewProjectDialog.tsx:65,68,120,127,184, GamesSidebar.tsx:259-265, WorkspaceTabs.tsx:14,16}`, `client/src/components/editor/{Filmstrip.tsx:14, ConsolePanel.tsx:19, AssetBuilder.tsx:529,701-722}`, `client/src/components/workspace/ArtTab.tsx:212`

**Change** One pass over user-visible strings. Canonical nouns: **Game** (the container), **Folder** (the attached workspace root — never "workspace", never "project folder"), **Chat** (the agent session), **Asset** (a thing in the game). Reserve "project" for code identifiers only. Concretely:
- `NewProjectDialog` title → "New game"; both collision messages → "A game called X already exists"; `App.tsx:967` → "could not create chat"; `App.tsx:1656` → "generate some in Assets first".
- Sidebar "Assets Library" → **Asset packs** (it installs packs); keep the tab as **Assets**.
- "PIE" → "Play" in every user-facing string (`Filmstrip.tsx:14`, `ConsolePanel.tsx:19` — the empty states currently instruct users to "Run PIE", a control that does not exist by that name).
- `PROMOTE` → `ADD TO SCENE`. `COL BOX`/`COL SPH` → `BOX COLLIDER`/`SPHERE COLLIDER`, with `title` attributes.
- Drop the `.slice(0, 3)` machine-truncation at `AssetBuilder.tsx:529` — "CON"/"TOR"/"PLA" become Cone/Torus/Plane; the full words fit.
- `WorkspaceTabs.tsx:75`: `aria-label={meta.label}`, not `aria-label={tab}` — a screen reader currently says "art" for the tab captioned "Assets".

**Verify:** `grep -ri "PIE\|project" client/src --include=*.tsx` over string literals returns only code identifiers. Walk create-game → collision → create-chat → Build empty state and confirm one vocabulary throughout.

---

## A12. Empty states are missing, misleading, or fake

**Impact:** Three merged findings, all about a newcomer's first five minutes:

- **Zero games is unreachable, so a fake game impersonates a real one.** Confirmed `App.tsx:913-914` — `projects.length > 0 ? projects : [project]`. With core offline or nothing on disk, the sidebar shows a game named **Starter** that is expandable, right-clickable, and removable. The user renames it, attaches a folder, and none of it persists. The real empty state at `GamesSidebar.tsx:272-273` (`<p>No games yet.</p>`) is dead code that can never render.
- **An expanded game with no chats renders a bordered stub** — a 1px vertical rule indented 13px beside nothing (`GamesSidebar.tsx:332-377`).
- **The builder's component list has no empty state** — `flattenTree([])` renders a 2px-tall empty bordered rectangle under the heading "Components" (`AssetBuilder.tsx:543`), while every other list in the app has one.

**Files** `client/src/App.tsx:913-917`, `client/src/components/workspace/GamesSidebar.tsx:272-273,332-377`, `client/src/components/editor/AssetBuilder.tsx:543`

**Change**
1. Drop the fallback at `App.tsx:914` — pass `projects` through. Make `GamesSidebar`'s empty state do work: a short line, a primary **New game** button, and surface `coreStatus` ("Core is offline; your saved games will appear when it reconnects") since offline is the common cause.
2. When a game's session list is empty, render a single row inside the disclosure — `Start a chat in {project.title}` — styled like a session row and calling `onNewSession(project.slug)`.
3. `AssetBuilder.tsx:543`: `{components.length === 0 ? <li className="px-2 py-3 text-[11px] text-ink-subtle">No components yet — add a primitive above.</li> : ...}`.

**Verify:** Kill the core and reload. The sidebar shows a real empty state with a working CTA and an offline explanation — no phantom "Starter" game. Create a game, expand it: a labeled first-chat row. Open BUILD on a new asset: a labeled empty list.

---

## A13. Delete the two dead components that disagree with what ships

**Impact:** No user impact today, but both are traps that will produce wrong-file edits during this very punch list.

- `client/src/components/workspace/SettingsDialog.tsx` (316 lines) is imported **only** by its own test (verified). It defines a *different* settings IA (three tabs, uppercase-tracked, `xl` dialog) than the shipped `SettingsPage.tsx` (five sections, sentence case, full page, used at `App.tsx:1758`). Its tests pass.
- `client/src/components/editor/ConsolePanel.tsx` — verified that the only references anywhere are `import type { LogEntry }` in `App.tsx:3` and `LiveBar.tsx:2`. The component itself is never rendered. It disagrees with the shipping console: ConsolePanel shows `log.time` oldest-first; `LiveBar.tsx:95` does `.slice(-40).reverse()` newest-first and drops the timestamp entirely.

**Change** Delete `SettingsDialog.tsx` and `SettingsDialog.test.tsx`. Delete `ConsolePanel.tsx` and move the `LogEntry` type to `client/src/lib/types.ts`, updating the two importers.

**Verify:** `npm run build` and the test suite pass; `grep -rn "ConsolePanel\|SettingsDialog" client/src` returns nothing.

---

## A14. Make the shipping console readable

**Impact:** This is the surface A4 makes users open, so it has to be worth opening. Confirmed `LiveBar.tsx:95` renders newest-first with no timestamps — the log reads backwards and nothing is time-anchored. Separately `LiveBar.tsx:40-54` is mounted unconditionally (`App.tsx:1753`), so while reading a Reports table the strip still says `LOAD 0.4s · FPS 0 · SIG IDLE`: "SIG" is not a word, `FPS 0` is the normal idle value and reads as a stall, and with a workspace attached those numbers describe a hidden `Viewport` that is not on screen.

**Files** `client/src/components/workspace/LiveBar.tsx:40-54,66,86,95`, `client/src/App.tsx:1753`

**Change** Render log rows oldest-first with auto-scroll-to-bottom and include `log.time`. Render the stats chips only when the runtime is the thing on screen (`tab === "play" && !workspace`); keep the CONSOLE control always mounted since it is the error surface. Spell `SIG` as `Status`. Show `—` rather than `0` for FPS when `pieState !== "running"`.

**Verify:** Trigger three errors in order; the console reads top-to-bottom in that order with timestamps. Switch to Reports — the fps/load chips are gone, the CONSOLE button remains.

---

# TIER B — worthwhile, larger or riskier

Grouped by theme. Each needs either a design decision, a wide mechanical sweep, or coordination with the in-flight agent-panel work.

---

## B1. Design-system adoption — the structural fix behind half of Tier A

The system exists and almost nothing uses it: 6 of 30 feature files import a single primitive; ~96 hand-rolled `<button>` elements against 18 uses of `<Button>`; 29 raw `<input>`/`<select>`/`<textarea>` bypass the primitives. Downstream symptoms: fifteen font sizes (nine arbitrary px, five of them half-pixel and visually indistinguishable), eight tracking values, five control heights, ten radii against an orphaned `--radius` token, and two visually and behaviorally different dropdowns in one product (native `<select>` at `ReportsTab.tsx:174`, `AssetLibrarySection.tsx:164`, `AssetPreview.tsx:537` vs Radix `Select` in AgentPanel/SettingsPage).

There are also two button *languages*: the primitive is sentence-case 14px filled; hand-rolled controls are ALL CAPS 10-11px bold outlined with wide tracking. The primary action in the Test tab and the primary action in the New Game dialog do not read as the same class of thing.

**Change** Add the missing shapes to `buttonVariants` (`ui/button.tsx:16-20`) — an `xs` size and a `toggle` variant covering the `aria-pressed`/`TOGGLE_ON` case — then delete the three ad-hoc `BUTTON_BASE` constants and `CHROME_ICON_BUTTON` and migrate call sites. Define a 5-step type scale in `@theme` (10/11/13/15/18) and snap all sizes onto it, deleting the half-pixel variants. Reset the primitives from `text-sm` to the 13px body step so primitive and hand-rolled buttons sit on the same line. Two control heights only (`h-8`, `h-7`); delete `min-h-[26px]` and `h-[30px]`. Three radii. Convert the three native `<select>` call sites to Radix.

**Risk:** wide, touches nearly every feature file, will conflict with anything else in flight. Sequence it *after* Tier A, and do it as several small typed PRs, not one.

---

## B2. Dialog and form visual convergence

`NewProjectDialog.tsx:145-159` and `FolderPicker.tsx:58,90,141` use shadcn tokens (`border-border`, `bg-card`, `bg-accent/50`, `text-destructive`, visible focus rings); everything else uses the semantic ramp (`border-line`, `bg-surface-1`, `text-danger-soft`, no rings). Two clicks apart, they look like different apps. Three dialog widths (`max-w-sm`/`max-w-lg`/`max-w-2xl`), three shadows including a bespoke `shadow-[0_24px_80px_rgba(0,0,0,0.6)]`, and inverted footer button order.

**Change** Adopt the semantic ramp as canonical (it drives the shell) and convert `NewProjectDialog` + `FolderPicker` onto it. Two dialog widths (`max-w-md` confirmations, `max-w-2xl` pickers), one shadow token, and reuse the existing `ProjectActionButtons` (`App.tsx:1896`) instead of hand-rolling footers.

---

## B3. Undo integrity in the asset builder

Two merged findings, both silent data loss inside an "undoable" surface:

- **The colour picker evicts your history.** `<input type="color">` fires `onChange` continuously during a drag; each event runs `patchMaterial` → `apply` → `undoRef.current.push(...)` against a `HISTORY_CAP` of 100 (confirmed `AssetBuilder.tsx:57`). One casual drag through the colour wheel evicts every prior entry — the primitives added, the transforms set — then UNDO walks back through 100 near-identical colour states one click at a time.
- **The agent bypasses undo, and undo dies on tab switch.** `useBrowserTools.ts:1141` calls `applyBuilderOps` directly, never touching `undoRef` — so after the agent adds six components, UNDO pops the snapshot from *before the user's own edit* and the agent's work vanishes in one click. And `undoRef`/`redoRef` are refs on a component `App.tsx:1637` unmounts on every tab change, so 100 entries of history are silently discarded when the user clicks SCENE and comes back. `Cmd+Z` is not bound at all.

**Change** Move `undoRef`/`redoRef` into App next to `applyBuilderOps` (`App.tsx:704-717`), keyed by `assetId`, so agent mutations push through the same path and the stack survives unmount. Give `apply` a `coalesce` key so a colour drag is one entry, or switch the colour input to `onBlur` and the numeric inputs to the `NumericField` component `EntityProperties.tsx:145-219` already implements. Bind `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` in the existing `onKeyDown` at `AssetBuilder.tsx:272-278` (it already handles W/E/R and excludes inputs — three more branches).

⚠ **CONFLICT** — touches `client/src/lib/useBrowserTools.ts`.

---

## B4. The primary viewport has no controls and no feedback

Three compounding problems in the main creation surface: (a) the selected-entity badge at `Viewport.tsx:185` (`absolute left-3 top-3`) and PlayOverlay's status pill at `:37` (`absolute left-3.5 top-3.5`) resolve against the same positioned ancestor with no z-index, so `RUNNING · CLICK TO SELECT` paints directly over the entity name; (b) `Viewport.tsx:117-125` raycasts and calls `onSelect` but nothing in `lib/pie.ts` draws an outline or tint, so clicking a cube produces no visible change; (c) `PieRuntime.frameProject` exists and `onFrameCamera` is wired, but no button calls it — orbit past the grid and the only recovery is reloading the app.

**Change** Delete the duplicate badge and render the entity name inside PlayOverlay's existing pill. Add a `THREE.BoxHelper` re-targeted on `selectedEntityId`. Add a `FRAME` button to PlayOverlay's transport cluster and extend the `hint` prop to `"DRAG ORBIT · SCROLL ZOOM · CLICK SELECT"` (the string is already plumbed from `App.tsx:1544`).

⚠ **CONFLICT** — touches `client/src/lib/pie.ts`.

---

## B5. TweakPanel covers the pins that open it

`TweakPanel.tsx:23` is `absolute bottom-3.5 right-3.5 w-[242px]`; `PlayOverlay.tsx:64` is `absolute bottom-3.5 left-3.5 max-w-[70%]`. They overlap below ~900px, and the dock is capped at `max-w-[960px]`, so in practice the panel always sits on the pin row. Switching which entity you are tweaking requires closing the panel to see the pins. **Change:** anchor to `top-14 right-3.5` (below the PLAY/RESET cluster), or move the pin row into the panel as a header select.

---

## B6. Agent panel transcript and status legibility ⚠ CONFLICT (all items)

Batch these into the in-flight refactor rather than shipping separately:

- **"Thinking…" is shown while the agent is blocked on you.** `:2190-2216` — in Manual/Sandbox mode the busy shimmer and seconds counter keep running while an approval card waits, and the card only auto-scrolls when `stickToEndRef.current` is true, so a user who scrolled up never sees it. The card also dumps `JSON.stringify(approval.arguments)` when `activitySummary()`/`buildActivityFileChange()` are already imported at `:59-72`. Pin the card above the composer, relabel the indicator "Waiting for your approval", stop the counter, bind `⌘⏎`/`Esc`.
- **`/loop` floods the transcript with 1,200-char machine prompts styled as the user's own messages**, up to 25 times (`:1620-1638`, `MAX_LOOP_ITERATIONS` at `lib/slashCommands.ts:47`). Add `synthetic: true` to `AgentMessage` and collapse those to a single expandable row.
- **Infrastructure errors are attributed to the model.** `say` defaults to `role: "assistant"` (`:1275-1277`), so `Graph plan failed: HTTP 502` appears in a **CALICODE** bubble. Add `level?: "info" | "error"`, route failures through `say(..., "tool")`, and render them with `danger-soft` + an alert icon.
- **Every non-conversational line looks identical** — progress ticks, session notices, subagent output, and hard failures all share one grey 12px row with a square bullet, and the loop lifecycle uses ASCII `▶ ■ ✔` while the rest of the panel uses Lucide. Introduce three tiers (lifecycle / info / error). Also render non-expandable `ToolRow`s as `<div>`, not `<button disabled>` — screen readers currently announce informational lines as disabled buttons.
- **Typing while busy is silently swallowed** (`:2035-2037`) — the textarea accepts keystrokes and `send()` returns immediately. Queue the message or disable the textarea with `placeholder="Agent is working — press Stop to interrupt"`.
- **The graph panel can never be dismissed** — `activeGraph` is only ever set, never cleared (`:822-825`), so one `/graph` run permanently occupies `max-h-[45%]` with a finished DAG. Collapse to a 32px summary bar on completion; add a dismiss control.
- **The composer collapses to unlabeled icons at narrow widths** — the model chip becomes a bare `Zap` under `@[360px]` (`:2384`) and the context meter disappears entirely at `@[420px]` (`:2345`). Never let the model chip go icon-only; degrade the meter to a bare numeral.
- **Reasoning effort silently switches your model** — `:2449-2452` calls `selectEffort(...)` then `switchModel(choice.value)`, so browsing effort options on a different model changes the active model for the session.
- **The context meter doesn't indicate the thing it exists for** — hardcoded 70/90 thresholds (`:2350`) against a real auto-compaction threshold of `coreConfig.compaction.threshold`, default 0.75 (`:1451-1454`). Draw a tick at the real threshold and make the meter a button that calls `compact()`.
- **Slash commands are undiscoverable and match only exact prefixes** — `/stop` is a dead end though `graph-stop` exists (`lib/slashCommands.ts:192-197`); `/graph ` with a trailing space kills the menu; `/help` dumps 15 unformatted lines as a **CALICODE** bubble. Add a persistent `/` button, substring matching with aliases, did-you-mean, and a structured `/help`.
- **Graph STOP behaves differently by entry point** — `GraphPanel`'s header STOP swallows errors and writes nothing to the transcript (`:2101`), while `/graph-stop` explains "the current node finishes first" (`:2010`). Point both at one handler.
- **Dropped SSE leaves tool rows spinning forever** — `settleRunningToolRows` exists (`:160`) and is used only on the loop's terminal-error path. Subscribe to `subscribeCoreStatus` and reconcile.
- **Empty-state starter buttons only prefill the box** (`:2137-2140`) — they look like actions; send on click, and make the block a normal flow child with `overflow-y-auto` so it doesn't clip on short windows.
- **Compaction is presented as a debug payload** — the archive row renders `JSON.stringify(archived).slice(0, 20_000)` (`:1881`). Render it as a nested read-only transcript.

---

## B7. Sidebar navigation model

The game row is a disclosure and a navigation action at once — one `onClick` both toggles `expanded` and calls `onOpenProject` (`GamesSidebar.tsx:287-301`), so you cannot see what chats exist in game B without switching the entire editor to B (which reopens the project, resets selection, and clears frames and test results). `expanded` is seeded from `activeSlug` at mount only (`:165`), so opening a game from the search palette leaves it collapsed while the previous one stays open. The global **New chat** row targets `activeSlug` (`:259`) without saying so anywhere.

**Change** Split the row (chevron toggles, label navigates); add `useEffect(() => setExpanded(activeSlug), [activeSlug])`; label the nav row with its target or drop it in favour of the per-game affordance from A12.

**Risk:** changes navigation semantics users may already rely on — worth a design call first.

---

## B8. Remaining discoverability and polish

- **No `⌘K`.** The search palette's only entry is a 15px magnifier that disappears with the rail. Register `⌘K`/`Ctrl+K` at App level and show the hint on the trigger. Also seed the Chats section with the 5 most recent sessions on an empty query so the palette's shape doesn't change as you type (`SessionSearchDialog.tsx:48`).
- **Seven equal-width tabs shed all labels at the dock's normal width** — `grid-cols-7` with labels gated on `@[520px]` against a 360px minimum, so the phone drawer (`min(720px, 94vw)`) is more legible than the desktop dock. Switch to `flex` + `overflow-x-auto` so tabs scroll rather than shed text.
- **`--ink-faint` (#9b9b9b) measures 2.55:1 on `--surface-1`** and is the colour of the "Games" header, every chat timestamp at `text-[9.5px]`, and every LiveBar chip. Retire it as a *text* colour (keep it for icon strokes and hairlines), move `.calicode-label` and timestamps to `--ink-subtle`, raise the floor to 11px, and darken `--ink-subtle` from #6e6e6e (4.24:1) to ~#5f5f5f to clear 4.5:1.
- **"Create permanent worktree" is jargon whose failure is discovered two clicks in** — enabled unconditionally, then a dialog with a disabled confirm and an amber "attach a folder first" box. `ProjectActions` already receives `hasFolder`; disable the item and put the reason in its tooltip. Rename to "Work on a separate branch copy".
- **Two folder flows, each error pointing at the other** — the collision message tells the user to go find the hover-revealed "Attach folder" menu from A7. Offer the action inline instead ("Open X instead" / "Attach to X"); App has both handlers in scope.
- **The file tree doesn't name its root** — the header is the word `Files`, with chat sessions able to swap the root via worktrees. Put `workspace.name` in the header with `root` as `title`, add a refresh control (the `attempt` counter at `:33` already exists), and name the folder in the empty copy.
- **Build's asset picker duplicates the Assets tab** (`App.tsx:1658-1673`). Delete it; render "Select an asset in the Assets tab and choose Edit" with a button that sets `tab = "art"`.
- **CODE opens on an empty diff** — `CodeTab.tsx:24` initialises `mode` to `"diff"`, so a fresh project shows "No changes since the project was loaded" and the way out is a lowercase 10px `edit` toggle adjacent to the identical `diff` toggle. Default to `"edit"` when `changed.length === 0`; extract one segmented `<ModeToggle>` shared with `FileEditor.tsx:155-181`.
- **AssetPreview shoves the grid it was opened from** — the preview renders above a single scrolling column, so clicking a fourth-row card injects 394px above it and the card jumps off-screen. Make it `sticky top-0 z-10` or split the tab into grid + preview pane.
- **LivePreview's failure states are dead ends** — `stop()` has no `catch` (verified `LivePreview.tsx:53-61`), so a failed stop is an unhandled rejection and the button simply appears not to work; the crashed state gives no reason and no retry; `starting` has no timeout; and `:106-108` ends in `${running ? "" : ""}`, a branch that produces the empty string either way. Match `start()`'s error handling, surface stderr with a RETRY, and time out the starting copy at ~30s.
- **Filmstrip is decoration** — hard `grid-cols-3` at any width, non-clickable figures, and a silent 60-frame cap (`App.tsx:1536`) that makes the header count plateau. Container-query the grid, make each figure open full-size, and say "60 frames (oldest dropped)" when capped.
- **Scene graph layout is thrown away on every tab switch** — `offsets` is component state on a panel `App.tsx:1680` unmounts, while the panel's own help text invites users to "drag a node to rearrange". Lift to App (persist into the project document if in scope) and add a FIT button.
- **ARIA patterns promised but not implemented** — `AssetBuilder.tsx:543` puts `role="listbox"` on a `<ul>` whose un-roled `<li>` children break the ownership chain for `role="option"` buttons, with shift-multi-select but no `aria-multiselectable` and no keyboard path; `SceneGraphCanvas.tsx:231-240` hangs `onClick` on a bare `<div>` with no role, tabIndex, or key handler, duplicating the button above it (the `suppressClickRef` dance exists only to work around this). `WorkspaceTabs.tsx:56-73` already implements the correct roving-tabindex pattern to copy.
- **When WebGL fails, only the three gizmo buttons are disabled** (`AssetBuilder.tsx:482`) — the whole right rail including SAVE stays live, so the user edits blind against a "WEBGL UNAVAILABLE" wall.
- **The builder's close `✕` sits inline inside the asset-name input row** and reads as "clear the name".
- **`CodeTab.tsx:36`** — `active = changes.find(...) ?? changes[0]` renders the first script as selected while `selectedId` is still `null`, so clicking it appears to do nothing.
- **`FileEditor.tsx:132-198`** — a 38px header packs path + operation + MODIFIED + TRUNCATED + counts + DIFF + FILE + RELOAD + SAVE in one non-wrapping row where everything but the path is `shrink-0`; below ~500px the path truncates to nothing.
- **`ArtTab.tsx:128-148`** — the IMPORT button accepts `image/*,.blend,.glb,.gltf,.obj` but nothing states the formats or that `.blend` takes a different path requiring Blender afterwards.
- **AssetBuilder status line** — one string carries reducer errors, save success, and save failure through the same `text-[10px] text-ink-subtle max-w-[60%] truncate` element pinned to the *opposite corner* from the SAVE button that produced it, and the next edit clears it. Split into `error` and `saveState`; render errors in the right rail above SAVE, wrapped not truncated. `FileEditor.tsx:199-203` is the template. Also track a `dirty` boolean and disable SAVE when clean — today it is always enabled and styled identically to an *active toggle*.
- **The builder's component list nests a `max-h-[180px] overflow-y-auto` `<ul>` inside an already-scrolling aside**, pushing the transform fields out of view.

---

## What's already right — do not regress it

- `AssetBuilder.tsx:229-242` — one undoable op per gizmo gesture, committed on `mouseUp`, with the reasoning in a comment. This is the correct model; B3 is about the paths that don't follow it.
- `AssetBuilder.tsx:469-488` — gizmo modes are real labeled buttons with the shortcut in the label (`MOVE · W`) and `aria-pressed`. This is the "no unlabeled icons" standard.
- `EntityProperties.tsx:145-219` — `NumericField` handles intermediate typing states, clamping, and arrow-key stepping.
- `FileEditor.tsx:84-94,199-203` — sha256-guarded writes with a plain-English conflict banner. Best error state in the codebase.
- `WorkspaceTabs.tsx:56-73` — correct roving-tabindex tablist.
- `AssetPreview.tsx:131-133,151-156,418-433` — reads theme tokens off computed styles and remounts on `[theme]`; four distinct explained load states via one `ViewerMessage`. This is the proof the tokens work and the bar for state handling.
