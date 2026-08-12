# CaliCode soak bug ledger

This ledger records failures reproduced while building `Neon Coin Dash QA`
through the native app and a second browser frontend. It is intentionally
evidence-first: items that were observed only once remain marked for soak
reproduction rather than being promoted to confirmed root causes.

| ID | Severity | Area | Reproduction / evidence | Status |
| --- | --- | --- | --- | --- |
| CALI-SOAK-001 | P0 | Editor bridge | With Chrome and the native app connected to the same core, a fresh Neon chat repeatedly received `editor is attached to another session/worktree`; PIE and test tools were rejected until the duplicate frontend closed. | Fixed with per-session client ownership; unit/RPC/E2E coverage green, final native two-window check pending unlock |
| CALI-SOAK-002 | P0 | Agent lifecycle | Both `deepseek-v4-flash` and `gpt-5.6-luna` spent most of a 12-turn budget on discovery/retries, then terminated with either `Turn limit reached before the agent finished.` or `I could not produce a response.` without a useful recovery action. | Fixed with empty-response retry, explicit terminal metadata, resumable max-turn result, and 20-turn client budget; core tests green |
| CALI-SOAK-003 | P1 | Entity inspector | Controlled numeric fields collapse intermediate input. Typing a leading minus produced positive coordinates, and one decimal edit produced `35` instead of `0.35`, creating a wall-sized entity. | Fixed; focused component tests and repeated Playwright signed/decimal persistence workflows green |
| CALI-SOAK-004 | P1 | Responsive editor | Entity properties are hidden at narrower effective workspace widths, leaving selection without an editable inspector while the agent panel is open. | Fixed; responsive component and full visual/browser suites green |
| CALI-SOAK-005 | P1 | Dev server | Vite emitted reloads for `src-tauri/target/**`, bundled app resources, and copied `dist/index.html` files during desktop builds, interrupting the browser session and flooding terminal output. | Fixed with generated-path watch exclusions and managed dev-process lifecycle; custom-port start/stop verified |
| CALI-SOAK-006 | P1 | Core recovery | When the pre-existing core disappeared, the browser silently fell back to Starter and hid the saved Neon project until a controlled core restart and reload. The project remained safe on disk. | Fixed with explicit offline/retry state, active-project preservation, reconnect probing, and dirty autosave retry; transport tests green, final native restart check pending unlock |
| CALI-SOAK-007 | P1 | Cross-window state | During the attachment conflict, the native app showed a Starter header with the Neon session's tool transcript, while Chrome showed Neon. Project/session/editor ownership was not legible to the user. | Fixed in routing/state contracts; multi-session ownership tests green, final native two-window check pending unlock |
| CALI-SOAK-008 | P2 | Playtest state | A fresh native session displayed `2/2 passing · 0 frames captured` before an explicit rerun; the rerun correctly produced 10 frames. | Covered by repeated play/reset/playtest browser workflows; no stale-pass reproduction after fix wave |
| CALI-SOAK-009 | P2 | Runtime status | A background Chrome frontend could remain `SIG RUNNING` with `FPS 0`; Reset/Play recovered state, while the foreground native app held 59–60 FPS. | Fixed: hidden editors report `SIG BACKGROUND` instead of implying a runtime stall; visibility regression test green |
| CALI-SOAK-010 | Watch | Core process | The initially discovered core process exited during the first runtime attempt. A controlled `cargo run` core remained stable through later runs, so this is not yet attributable to a product crash. | Not reproduced across full and repeated isolated suites; retain as watch item for longer native soak |
| CALI-SOAK-011 | P1 | Generated workspaces | `client/worktrees/` held 14 generated worktrees (33 MB) plus `client/sessions/` inside Vite's project root. Without explicit watch exclusions, session churn can multiply filesystem events and reload pressure. | Fixed for new runs: generated paths are ignored and Playwright state is isolated under disposable `.e2e-state`; historical user artifacts preserved |
| CALI-SOAK-012 | P1 | Model controls | The UI displays and persists reasoning effort such as `gpt-5.6-luna · max`, but `AgentPanel` documents that core currently ignores the `effort` parameter. The control therefore overstates the request actually sent. | Fixed; effort reaches request-scoped provider payload and regression tests pass; live provider confirmation needs a configured key |
| CALI-SOAK-013 | P0 | Editor tool surface | `editor_scene_inspect` claims to inspect scripts and tests but returns only their ids/names, omits entity `scriptIds` and materials, and `editor_test_add` cannot update an existing test. Agents consequently burn turns searching worktree files for live project code and cannot safely replace tests. This directly preceded both terminal agent failures. | Fixed with complete snapshots, validated object updates, idempotent script/test upserts, and focused tests |
| CALI-SOAK-014 | P0 | Session resources | Durable session create/fork allocates generated git worktrees, but session/project deletion and project-session archive do not remove them; failed allocation can also leave empty session records. Fourteen orphan worktrees were present after prior runs. | Fixed with clean generated-worktree cleanup, dirty-worktree preservation, rollback, editor/agent cancellation, and RPC tests |
| CALI-SOAK-015 | P0 | Session persistence | Session save/fork/compaction/delete can run concurrently, but the original read-modify-write path was not serialized and reused one temporary filename. A late writer could replace a newer transcript or collide with another save during a long agent run. | Fixed with serialized session I/O and unique atomic temporary files; concurrency tests green |
| CALI-SOAK-016 | P1 | E2E isolation | Parallel repeated workflow workers generated identical `Date.now()` names, and core-derived E2E sessions/worktrees lived beside `client/`, so an interrupted live test leaked three durable records and worktrees. | Fixed with worker/repeat/random labels plus one disposable `.e2e-state` root; 5x parallel workflow repeat and full 58-test suite green |
| CALI-SOAK-017 | P1 | Desktop packaging | `pnpm desktop:build` produced the app but failed the DMG when macOS denied create-dmg permission to send cosmetic AppleEvents to Finder. | Fixed with a narrow CI-safe DMG fallback after the styled packaging attempt; the exact desktop build command now succeeds and emits both bundles |
| CALI-SOAK-018 | P0 | Offline recovery | After an autosave failed offline, clicking `Retry` reran startup hydration and replaced the newer dirty in-memory project with core's older disk copy before autosave could retry. | Fixed so hydrated games probe transport without reopening; a real routed-RPC outage/reconnect/persistence test and 3x repeated workflow suite are green |
| CALI-SOAK-019 | P0 | Cross-game session state | Creating `Native Soak 0811` while a Neon task was selected carried that session id into the new game, then rendered `Resume failed: session belongs to project Some("neon-coin-dash-qa"), not native-soak-0811`. | Fixed by clearing/remounting task state on every game-creation/open path; regression E2E added, full isolated rerun pending native-port release |
| CALI-SOAK-020 | P0 | Compaction persistence | `session_save` rebuilt the durable record without its `archived` field, so the first ordinary transcript autosave after compaction could erase the soft-archived turns that compaction promised to preserve. | Fixed by preserving archived turns across saves with a direct save/archive/save regression test |
| CALI-SOAK-021 | P1 | Agent activity UX | Every tool call rendered as a separate low-context row, work duration was lost on completion/resume, concurrent same-name calls paired by name, and file edits could not open the real file or a trustworthy diff in the editor. | Fixed: one collapsed activity per Enter, call-id pairing, atomic bounded edit metadata, worked-time persistence, aggregate file stats, expanded action details, and safe click-through to the real file/diff; 307 unit and 62 isolated E2E tests green |
| CALI-SOAK-022 | P0 | Native workspace access | The packaged sidecar could serve the app but `workspace_open` against a repo under macOS Desktop consistently timed out while the same path opened in ~2ms from the user's shell. The custom browser-style picker never produced an NSOpenPanel grant, so protected folders could not back the real editor. | Native picker and explicit access-recovery flow implemented with scoped directory selection; Tauri fmt/clippy/tests and browser fallback tests green. Packaged parent-to-sidecar grant behavior still needs the final Computer Use pass after the Mac is unlocked; broker fallback remains the next fix if the OS does not extend the grant to the sidecar. |

## Passing baseline from the same run

- New project creation and template selection persisted a valid project.
- Scene edits and script edits survived core restart.
- Native PIE ran at 59–60 FPS.
- Play, Reset, and the existing two-test suite passed; the final run captured
  10 frames and reported no issues.

## Exit criteria

1. Only one deterministic editor owner exists per active project/session, or
   contention is surfaced with a direct recovery action.
2. Agent terminal states preserve a useful reason and retry path; tool-only
   progress cannot end as an unexplained empty response.
3. Signed and decimal transforms are safe to type and remain editable at
   supported window sizes.
4. Desktop builds do not trigger Vite reload storms, and core restart does not
   silently replace the current project.
5. The full verification suite passes, followed by repeated native-app
   create/edit/agent/PIE/reset/test/reload loops without a blocking failure.
