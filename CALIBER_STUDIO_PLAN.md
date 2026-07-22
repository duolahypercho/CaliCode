# Caliber Studio — Product and Execution Plan

Status: Superseded by [the multi-engine AI game creation plan](./CALIBER_STUDIO_PLATFORM_PLAN.md)  
Date: July 21, 2026  
Planning horizon: First private alpha through public beta

## 1. Executive decision

Caliber Studio will be a local-first AI game-making desktop application built around one loop:

> Describe a change → watch the agent implement it → play it immediately → refine it.

The first release will make small 2D browser games. The left side of the app will contain prompting, agent activity, code, and diffs. The right side will contain a persistent, playable game preview with runtime errors and controls.

Use OpenCode through its SDK as the first coding-agent engine. Do not fork OpenCode's user interface or copy its repository into Caliber. Keep the integration behind a small internal boundary so another engine, such as Codex, can be added later if real user demand justifies it.

The first game stack will be TypeScript, Vite, and Phaser. The first product will be a desktop app using Electron and React. Projects remain normal folders and normal Git repositories that users can open outside Caliber.

## 2. Assumptions

This plan assumes:

- One full-time builder, or one engineer plus a part-time designer.
- A private alpha can ship in roughly six focused weeks; eight weeks is a safer target with polish and onboarding.
- The first users are indie developers, designers who can tolerate seeing code, game-jam builders, and technically curious creators.
- The first version is local-only and bring-your-own-model/provider credentials.
- The first version supports Caliber-created projects, not arbitrary imported repositories.
- The first version produces 2D web games, not Unity, Unreal, Godot, native mobile, console, or multiplayer games.
- Generated games can be exported as static web builds.
- Caliber will optimize for a reliable creative loop before breadth, collaboration, or marketplace features.

If these assumptions change, revisit the architecture before implementation rather than accumulating exceptions.

## 3. Product thesis

General-purpose coding agents can already edit a game repository. They do not, by themselves, create a good game-making experience. Caliber's opportunity is the tight coupling between agent work and an instrumented game runtime.

Caliber should become progressively more game-aware:

1. **Immediate preview:** every valid change appears in a playable canvas.
2. **Runtime awareness:** the agent can receive console errors, build failures, and screenshots.
3. **Game-aware context:** the agent understands scenes, entities, controls, assets, and game state.
4. **Automated playtesting:** the agent can launch the game, provide inputs, inspect frames, and report problems.
5. **Content production:** the studio helps create and manage sprites, audio, levels, dialogue, and releases.

The moat is not the chat box or code editor. It is the increasingly capable game feedback loop.

## 4. Positioning

### One-line description

Caliber Studio is an AI game studio where you describe a mechanic, watch it get built, and play it instantly.

### Mental model

“A game-native coding agent with the canvas always running.”

### Primary user

The initial primary user is a technically curious solo creator who wants to prototype a 2D game quickly and is comfortable inspecting code or diffs when needed.

### Secondary users

- Experienced developers using Caliber for game jams and mechanic prototypes.
- Designers learning game development through editable projects.
- Small teams testing concepts before moving them into a larger production engine.

### Users explicitly out of scope for the alpha

- Studios seeking a complete Unity or Unreal replacement.
- Nontechnical users expecting a purely visual no-code tool.
- Teams requiring real-time collaboration, source-control administration, or production deployment controls.

## 5. Product principles

1. **The game remains visible.** The right-side preview should almost never disappear.
2. **A project is not trapped in Caliber.** It is a readable TypeScript project on disk.
3. **The user stays in control.** Show meaningful activity, permission requests, diffs, verification, and undo.
4. **Fast feedback beats feature count.** Time from prompt submission to playable result is a primary metric.
5. **Defaults create momentum.** One excellent starter is better than ten mediocre templates.
6. **Code is available, not mandatory.** Beginners can remain in Prompt mode; experienced users can move into Code or Changes mode.
7. **Failures become context.** Build and runtime errors should be understandable and easy to send back to the agent.
8. **No silent destructive behavior.** File deletion, broad shell access, dependency replacement, and external access require clear handling.

## 6. Core user journey

### First-run journey

1. User installs and opens Caliber.
2. User chooses a model provider and connects credentials through the supported OpenCode flow.
3. User selects **New Game**.
4. Caliber creates a working Phaser starter in a new project folder.
5. The game starts immediately on the right.
6. The left panel suggests three useful prompts, such as:
   - “Add a dash when I press Shift.”
   - “Make enemies chase the player.”
   - “Turn this into a neon arena.”
7. User submits a prompt.
8. Caliber streams concise agent activity and asks for permission only when required.
9. The change is verified and the game reloads.
10. The user plays the result, reviews the diff if desired, and continues prompting.

### Returning journey

1. Open a recent project.
2. Restore the game preview and conversation.
3. Continue from the latest accepted project state.
4. Undo a bad turn or open its changed files.

### Failure journey

1. A build or runtime error appears in the preview status.
2. Caliber explains whether it is a build error, runtime exception, or agent failure.
3. User chooses **Ask Caliber to fix**.
4. The error, relevant logs, and changed files are attached to a new agent turn.
5. The agent repairs and verifies the project.

## 7. Alpha scope

### Must have

- Create, open, rename, and delete-from-recents a Caliber project.
- One polished Phaser 2D starter project.
- Persistent playable preview with automatic reload.
- Prompt submission and streamed agent activity.
- OpenCode session lifecycle and model/provider selection.
- File tree and Monaco-based code viewing/editing.
- Per-turn changed-file list and readable diff.
- Permission request UI.
- Cancel a running turn.
- Build/typecheck verification after agent changes.
- Build-error and runtime-error capture.
- One-click “fix this error” action.
- Revert the last agent turn safely.
- Project history that survives app restarts.
- Export a production web build to a chosen folder.
- macOS packaging for the private alpha.

### Should have before public beta

- Windows packaging.
- Viewport presets and fullscreen play mode.
- Screenshot attachment to prompts.
- Image drag-and-drop into the project.
- Several curated mechanic prompt recipes.
- A second starter showing a different genre.
- A compact game console and log filters.
- Crash recovery for the agent process and preview process.
- Update mechanism and opt-in diagnostics.

### Not in the initial product

- Unity, Unreal, Godot, or native engine integration.
- 3D authoring.
- Multiplayer or server-authoritative games.
- Real-time collaboration.
- Cloud workspaces.
- Hosted model billing.
- Built-in sprite, music, or voice generation.
- Visual level editor.
- Plugin marketplace.
- Mobile or console export.
- Autonomous endless “keep improving my game” mode.

## 8. Interaction design

### Main shell

Use a resizable two-column layout:

- **Left workspace: approximately 42%.** Prompt, Code, and Changes modes.
- **Right preview: approximately 58%.** Game, play controls, viewport, and console.

The preview remains mounted when the left mode changes.

### Left workspace modes

#### Prompt

- Conversation and concise agent event timeline.
- Running/cancelled/completed state.
- Permission cards inline with the turn.
- Prompt composer pinned to the bottom.
- Attachment button for selected files, screenshots, and runtime errors.
- Suggested prompts only when the session is empty.

#### Code

- Compact file tree.
- Monaco editor.
- Open tabs and unsaved-state indicators.
- Search and “send selection to prompt.”
- No attempt to reproduce every VS Code feature.

#### Changes

- Files changed in the latest turn.
- Unified or side-by-side diff.
- Verification result.
- Revert-turn control.
- “Continue from this change” prompt shortcut.

### Right preview

- Play/reload button.
- Game URL and readiness status hidden behind a compact status affordance.
- Viewport presets: responsive, 16:9 desktop, common mobile portrait.
- Fullscreen play button.
- Screenshot button.
- Collapsible console showing warnings and errors.
- Error overlay that does not destroy the last useful logs.

### Status language

Prefer product language over internal agent jargon:

- “Planning change”
- “Editing player movement”
- “Checking the game”
- “Waiting for permission”
- “Ready to play”
- “The game did not build”

Raw tool activity may be available in a detail disclosure, but should not dominate the experience.

## 9. Technical architecture

### Chosen stack

- **Desktop shell:** Electron.
- **Renderer:** React, TypeScript, and Vite.
- **Styling:** plain CSS modules or a small token-based CSS layer; do not adopt a large component framework initially.
- **Code editor:** Monaco Editor.
- **Agent backend:** `@opencode-ai/sdk`, run from the trusted main-process side.
- **First game engine:** Phaser with TypeScript and Vite.
- **Project history:** Git for Caliber-created projects, with Caliber-managed checkpoints.
- **Application metadata:** small JSON files initially; migrate to SQLite only when querying or migration needs justify it.
- **Testing:** unit tests for pure logic, integration tests for process boundaries, and Playwright-driven Electron tests for critical journeys.

### High-level flow

```text
React renderer
  │ typed, narrow IPC
  ▼
Electron main process
  ├─ Project service ── filesystem and Git checkpoints
  ├─ Agent service ──── OpenCode SDK/server
  ├─ Preview service ── game dev-server lifecycle
  └─ Export service ─── production build and output folder
                          │
                          ▼
                 Isolated game preview
                 logs, errors, screenshots
```

### Process boundaries

The renderer must not receive Node.js or unrestricted filesystem access. It sends typed requests to the main process. The main process owns:

- Project folder access.
- Child-process lifecycle.
- OpenCode connection and credentials flow.
- Git operations.
- Export operations.
- Preview navigation policy.

The game preview must run in isolated web contents with Node integration disabled. Navigation outside the local game origin is blocked or opened in the user's normal browser after confirmation.

### OpenCode integration boundary

Do not build an elaborate multi-agent framework. Start with one internal module exposing only what the UI needs:

```ts
interface CodingAgent {
  start(projectPath: string): Promise<void>
  createOrResumeSession(projectId: string): Promise<SessionSummary>
  sendPrompt(input: PromptInput): Promise<TurnHandle>
  cancelTurn(turnId: string): Promise<void>
  respondToPermission(requestId: string, decision: PermissionDecision): Promise<void>
  subscribe(listener: (event: AgentEvent) => void): Unsubscribe
  stop(): Promise<void>
}
```

Implement it directly with OpenCode. Add another adapter only when Caliber actually supports another backend. Pin the tested OpenCode version and upgrade intentionally after integration tests pass.

Relevant OpenCode capabilities already available through its SDK/server include sessions, messages, events, file status, diffs, permission responses, providers, and cancellation. Caliber should consume those capabilities rather than copying their implementation.

### Agent turn state machine

```text
idle
  → starting
  → running
  → waiting_for_permission ──→ running
  → verifying
  → completed

Any active state may transition to cancelled or failed.
```

The state machine must be explicit. UI components should not infer state from arbitrary event strings.

### Preview lifecycle

1. Resolve the project's package manager and install state.
2. Start the template's dev server on a loopback address and assigned port.
3. Wait for a positive readiness signal rather than a fixed delay.
4. Load the URL into isolated preview web contents.
5. Capture console messages, unhandled exceptions, failed resource loads, process exit, and reconnect attempts.
6. Keep the last useful error if the preview reloads into a blank page.
7. Restart with bounded retries after unexpected exit.
8. Stop all project processes when switching projects or quitting Caliber.

### Game template contract

Every Caliber template contains:

```text
game-project/
├─ .caliber/
│  └─ project.json
├─ AGENTS.md
├─ package.json
├─ index.html
├─ public/
│  └─ assets/
├─ src/
│  ├─ main.ts
│  ├─ game/
│  │  ├─ config.ts
│  │  └─ scenes/
│  │     └─ MainScene.ts
│  └─ caliber/
│     └─ runtime-bridge.ts
└─ tsconfig.json
```

The starter must be deliberately small, readable, playable, and visually intentional. It should demonstrate movement, collision, a goal or score, restart behavior, and a minimal HUD without becoming a framework of its own.

### Runtime bridge

The first runtime bridge only needs to report:

- Game ready.
- Current scene name.
- Unhandled errors.
- Selected structured events such as restart or game over.
- A sanitized snapshot of debug state when explicitly requested.

Later versions can expose controllable input, entity inspection, and deterministic playtest hooks. Do not delay the alpha to build those advanced capabilities.

### Project metadata

`.caliber/project.json` should begin with a minimal schema:

```json
{
  "schemaVersion": 1,
  "id": "generated-stable-id",
  "name": "Neon Dash",
  "template": "phaser-2d",
  "createdAt": "ISO-8601 timestamp",
  "commands": {
    "dev": "npm run dev",
    "check": "npm run check",
    "build": "npm run build"
  }
}
```

Do not store credentials, conversation contents, absolute machine-specific paths, or volatile process information in this file.

### Git and undo model

For a Caliber-created project:

1. Initialize Git and create a baseline commit.
2. Before each agent turn, record the current HEAD and working-tree state.
3. Track files changed by the turn.
4. On successful acceptance, create a Caliber checkpoint commit or equivalent recoverable snapshot.
5. Revert only the selected turn's known changes.

Do not run broad reset or clean operations. If user-authored uncommitted changes exist, preserve them and block an ambiguous revert rather than guessing. Imported repositories require a separate design and should wait until the checkpoint model is proven.

### Persistence

Persist:

- Recent project references.
- Project IDs and display names.
- Window/layout preferences.
- OpenCode session association per project.
- Last open left-side mode and selected file.
- Opt-in telemetry choice.

OpenCode remains the source of truth for its own session contents. Caliber should store references, not duplicate every event.

## 10. Security model

Generated code and coding agents are both high-risk execution surfaces. Security is part of the MVP architecture.

### Required controls

- Bind agent and preview services to loopback only.
- Keep Electron renderer Node integration disabled and context isolation enabled.
- Expose a narrow, validated IPC surface.
- Normalize and verify every requested project path against the active project root.
- Never pass shell commands through renderer-controlled string interpolation.
- Preserve OpenCode permission requests and display meaningful intent to the user.
- Default agent file writes to the active project.
- Clearly distinguish read, write, command execution, network, and destructive permissions.
- Never log provider keys or complete environment variables.
- Prevent preview navigation to local files, Electron internals, and arbitrary privileged origins.
- Add a Content Security Policy for the Caliber renderer.
- Stop child processes and event subscriptions reliably on project switch and app exit.
- Audit packaged builds to ensure development endpoints and debugging ports are not exposed.

### Alpha limitations to disclose

- Caliber-generated code executes locally.
- Approved commands may run package scripts and project tooling.
- Users should use disposable projects during the earliest alpha.
- The alpha is not yet designed for opening untrusted third-party repositories.

## 11. Repository plan

Keep the initial repository direct:

```text
caliber-studio/
├─ .github/
│  └─ workflows/
├─ docs/
│  ├─ architecture.md
│  ├─ product-decisions.md
│  └─ threat-model.md
├─ src/
│  ├─ main/
│  │  ├─ agent/
│  │  ├─ export/
│  │  ├─ ipc/
│  │  ├─ preview/
│  │  └─ project/
│  ├─ preload/
│  ├─ renderer/
│  │  ├─ components/
│  │  ├─ features/
│  │  │  ├─ agent/
│  │  │  ├─ code/
│  │  │  ├─ changes/
│  │  │  ├─ preview/
│  │  │  └─ projects/
│  │  └─ styles/
│  └─ shared/
│     ├─ contracts/
│     └─ types/
├─ templates/
│  └─ phaser-2d/
├─ tests/
│  ├─ fixtures/
│  ├─ integration/
│  └─ e2e/
├─ AGENTS.md
├─ package.json
├─ tsconfig.json
└─ CALIBER_STUDIO_PLAN.md
```

Do not split this into multiple packages until a real second consumer or independently versioned component appears.

## 12. Delivery roadmap

Estimates assume one experienced full-time engineer. Each phase ends with a demonstration and a checkable exit condition.

### Phase 0 — Foundation and risk spike

Target: 2–3 days

Build:

- Initialize Git and the TypeScript/Electron/React project.
- Add lint, typecheck, unit test, and packaged-build commands.
- Write the minimal Electron security configuration.
- Spike OpenCode SDK startup, one session, one prompt, event streaming, cancellation, and clean shutdown in a disposable fixture.
- Spike a Phaser dev server inside the isolated preview and capture one runtime error.
- Record decisions in `docs/product-decisions.md`.

Exit criteria:

- A packaged development app opens.
- The app can run one agent prompt against a fixture project.
- The app can display and reload a Phaser game.
- Both child processes stop when the app exits.
- The SDK and preview approach have no unresolved blocking issue.

### Phase 1 — Project-to-preview vertical slice

Target: 1 week

Build:

- Home screen with **New Game** and recents.
- Project creation from the Phaser starter.
- `.caliber/project.json` validation.
- Preview lifecycle and readiness handling.
- Basic two-column studio shell.
- Reload, fullscreen, and console controls.
- Project reopening after app restart.

Exit criteria:

- A new user can create a project and play it in under 60 seconds, excluding first-time dependency installation.
- Restarting Caliber restores the project.
- A syntax error produces a useful error state rather than a blank panel.

### Phase 2 — Prompt-to-play loop

Target: 1–1.5 weeks

Build:

- Provider/model onboarding.
- Project-scoped OpenCode session.
- Prompt composer and event timeline.
- Explicit turn state machine.
- Permission request and response UI.
- Cancellation and failure recovery.
- Automatic preview refresh after file changes.
- Concise activity labels mapped from raw events.

Exit criteria:

- “Add a dash ability” produces a playable change in the starter.
- The UI stays responsive throughout the turn.
- A permission request can be accepted or denied.
- Cancelling a turn leaves the project and app usable.

### Phase 3 — Trust, changes, and recovery

Target: 1 week

Build:

- Changed-file list.
- Monaco file viewer/editor.
- Diff viewer.
- Per-turn verification command.
- Git baseline and checkpoints.
- Safe revert of the last clean agent turn.
- Unsaved and conflicting-change protection.

Exit criteria:

- Users can inspect every changed file.
- Successful turns show a passing build/typecheck result.
- Revert restores the previous playable state without deleting unrelated files.
- Manual edits and agent edits do not silently overwrite each other.

### Phase 4 — Runtime feedback loop

Target: 1 week

Build:

- Structured runtime bridge.
- Build and runtime error inbox.
- One-click **Ask Caliber to fix**.
- Screenshot capture and prompt attachment.
- Bounded dev-server restart policy.
- Better empty, loading, and failure states.

Exit criteria:

- A deliberately introduced runtime exception is captured with useful context.
- The error can be sent to the agent and repaired without copying logs manually.
- Screenshot attachment reaches the agent or fails with an explicit supported-format message.

### Phase 5 — Private alpha quality

Target: 1–2 weeks

Build:

- First-run walkthrough.
- Starter-game visual polish.
- Export flow and production-build verification.
- Keyboard shortcuts and accessibility pass.
- Crash recovery and diagnostic bundle.
- macOS signing/notarization preparation.
- Opt-in telemetry and privacy copy.
- End-to-end tests for the three critical journeys.
- Documentation and feedback channel.

Exit criteria:

- Ten clean end-to-end runs on fresh test projects.
- A non-author can complete the first prompt-to-play journey unaided.
- Exported games work from a static server.
- No known critical data-loss or credential-exposure issue.
- Installer works on at least two clean macOS machines.

### Phase 6 — Private alpha

Target: 2–4 weeks of user learning

Operate:

- Recruit 10–20 target users.
- Observe at least five first sessions live.
- Review failures weekly and fix reliability before adding breadth.
- Ship small releases one or two times per week.
- Track time to first playable, successful-turn rate, preview recovery, and repeated use.

Exit criteria for public-beta work:

- At least 60% of activated testers complete one successful game change.
- Median time from first project creation to first playable agent change is under 10 minutes.
- At least 30% of activated testers return within seven days.
- Fewer than 5% of agent turns leave a project requiring manual recovery.
- At least five users voluntarily create more than one project or spend more than two sessions in one project.

These are directional early-stage thresholds, not promises. Adjust them after observing actual session volume and user mix.

### Phase 7 — Public beta

Only after alpha evidence, consider:

- Windows distribution.
- Imported Caliber-compatible repositories.
- Second game template.
- Managed web publishing.
- Provider setup improvements.
- Better asset workflow.
- Update channel and public issue reporting.

## 13. First six weekly milestones

| Week | Demonstrable outcome |
| --- | --- |
| 1 | Create and play a Caliber starter inside the desktop shell. |
| 2 | Prompt the agent and see a game file change and reload. |
| 3 | Inspect code/diffs, verify the build, and revert the turn. |
| 4 | Capture a runtime error and have the agent repair it. |
| 5 | Export the game and complete the polished onboarding path. |
| 6 | Install a signed alpha build and put it in testers' hands. |

If a week slips, cut breadth rather than weakening project safety or the core prompt-to-play loop.

## 14. Prioritized backlog

### P0 — Required for the first external tester

- Desktop app scaffold and secure preload boundary.
- Create/open recent project.
- Phaser starter.
- Preview process manager.
- OpenCode process manager and SDK client.
- Session and prompt flow.
- Event normalization and turn state machine.
- Permission UI.
- Code file viewer.
- Changed-file list and diff.
- Verification.
- Revert latest turn.
- Runtime/build error capture.
- Fix-error prompt.
- Export.
- Packaging and critical end-to-end tests.

### P1 — Strong alpha improvements

- Screenshot-to-prompt.
- Manual code editing.
- Search files.
- Viewport presets.
- Prompt recipes.
- Better recent-project management.
- Diagnostics export.
- Auto-update.
- Windows packaging.

### P2 — Evidence-dependent expansion

- Imported project support.
- Second agent backend.
- Second game template.
- Asset library.
- Web publishing.
- Game-state inspector.
- Automated input/playtest harness.
- Scene/entity visual tools.

### P3 — Future company bets

- Multiplayer backend workflows.
- Cloud workspaces.
- Collaboration.
- Marketplace.
- Hosted inference and usage billing.
- 3D engine or Godot integration.
- Automated cross-browser and device playtesting.

## 15. Verification strategy

### Required commands from the start

- `lint`: static code-quality checks.
- `typecheck`: full application TypeScript check.
- `test`: fast unit and integration suite.
- `test:e2e`: packaged or development Electron critical journeys.
- `build`: production application build.
- `package`: local distributable.

### Unit tests

Focus on:

- Path containment and normalization.
- Project manifest parsing/migration.
- Turn state transitions.
- Raw OpenCode event normalization.
- Error/log sanitization.
- Checkpoint and revert planning.
- Command configuration validation.

### Integration tests

Use small fixture projects to test:

- Agent startup and shutdown.
- Dev-server readiness and unexpected exit.
- File-change event propagation.
- Git checkpoint creation and safe revert.
- Build failure extraction.
- Runtime bridge messages.

Do not make the default test suite depend on paid model calls. Wrap recorded or fake agent events around the same internal contract. Keep a separate opt-in live-provider smoke test.

### End-to-end tests

Automate three journeys:

1. Create project → preview becomes playable.
2. Fake agent turn → files change → verification passes → diff appears.
3. Runtime error → error action → repair turn → preview recovers.

### Manual release checklist

- Fresh install.
- First provider connection.
- Project path containing spaces.
- App restart during an idle project.
- Cancel during an active turn.
- Deny a permission.
- Dev-server crash and restart.
- Network unavailable.
- Provider authentication failure.
- Revert with and without manual edits.
- Export and serve the output.
- Quit with active child processes.

## 16. Observability and privacy

### Product metrics

Collect only with explicit disclosure and an opt-out:

- App version and operating system.
- Project created/opened.
- Preview ready/failed and time to ready.
- Agent turn started/completed/cancelled/failed and duration.
- Verification passed/failed.
- Revert used.
- Export succeeded/failed.
- Error category, using sanitized codes rather than source content.

### Never collect by default

- Source files.
- Prompt contents.
- Model responses.
- Screenshots.
- API keys or environment variables.
- Absolute local paths.

### Diagnostic bundle

Let users explicitly export a reviewed diagnostic archive containing app logs, versions, process states, and sanitized error codes. Show exactly what will be included before saving it.

## 17. Product validation plan

### Before alpha

- Interview 10 target users about their last game prototype, not hypothetical interest.
- Show a clickable mock or short working demo.
- Ask users to narrate where they expect prompt, code, changes, preview, and errors to live.
- Recruit testers from people who have recently attempted a game jam or AI-generated game.

### Alpha research questions

- Do users start from prompts or inspect code first?
- Do they understand what the agent changed?
- How often do they need to revert?
- Which failures break trust: wrong behavior, broken build, unexplained waiting, or permission friction?
- Does persistent preview materially change iteration behavior?
- What is the first requested capability outside Phaser 2D?
- Do users want generated assets, a visual editor, publishing, or better code control next?

### Leading indicators

- Time to preview-ready.
- Time to first successful agent change.
- Successful verified turns divided by total turns.
- Turns per active session.
- Percentage of users who play after a completed turn.
- Percentage of failures recovered inside Caliber.
- Seven-day return rate.

### Qualitative success signal

The strongest early signal is not “this looks cool.” It is a tester returning to continue the same game without being prompted by the team.

## 18. Launch plan

### Private alpha

- 10–20 invited testers.
- Direct feedback channel.
- Short known-limitations document.
- Weekly builds, with hotfixes for data loss or startup failures.
- Founder observes first-use sessions.

### Closed beta

- 50–200 users from game-jam, indie-hacker, and creative-coding communities.
- Simple landing page with a 60–90 second prompt-to-play demonstration.
- Public changelog and issue intake.
- Referral invitations only after activation and reliability are acceptable.

### Public beta narrative

Demonstrate one complete mechanic change, not a montage of unrelated AI features:

1. Start with a playable game.
2. Ask for a meaningful mechanic.
3. Watch the change land.
4. Play the result.
5. Introduce a bug or show a real runtime issue.
6. Have Caliber diagnose and repair it.
7. Export the game.

### Distribution channels

- Short build-in-public clips focused on the feedback loop.
- Game-jam partnerships or a Caliber-specific weekend challenge.
- Direct outreach to creators already sharing AI-game experiments.
- Small set of high-quality example games with source included.

Avoid paid acquisition until activation and retention are understood.

## 19. Business model hypothesis

Do not block the alpha on monetization infrastructure.

### Initial model

- Free local desktop app during private alpha.
- Users bring their own provider credentials.
- No token markup or hosted inference obligation.

### Plausible future paid value

- Managed publishing and shareable playtest links.
- Cloud builds and device/browser testing.
- Generated asset credits.
- Team projects and collaboration.
- Versioned cloud backups.
- Advanced autonomous playtesting.

Charge for Caliber-specific workflow value, not merely for wrapping access to a model provider.

## 20. Key risks and responses

| Risk | Likely impact | Response |
| --- | --- | --- |
| OpenCode API changes | Integration churn | Pin a tested version, normalize events internally, and run contract tests before upgrades. |
| Agent makes unreliable game changes | Loss of trust | Small template, strong `AGENTS.md`, verification, visible diffs, runtime feedback, and safe revert. |
| Generated code accesses the host | Security incident | Narrow IPC, isolated renderer/preview, loopback services, project-scoped permissions, and clear command approvals. |
| Electron app feels heavy | Poor first impression | Measure startup/memory, lazy-load Monaco, start services only for an open project, and avoid unnecessary frameworks. |
| Preview is flaky | Core loop fails | Explicit readiness, managed lifecycle, bounded restart, persistent logs, and integration fixtures. |
| Product becomes a generic IDE | Weak differentiation | Prioritize runtime/game context and playtesting over editor feature parity. |
| Too many engine requests | Roadmap fragmentation | Stay with Phaser until retention proves the loop; choose the second engine from observed demand. |
| Provider setup is confusing | Activation loss | Curated default path, clear auth diagnostics, and tested onboarding. |
| Users expect finished games from one prompt | Disappointment | Position around iterative creation and show the edit/play/refine loop honestly. |
| Revert damages manual work | Data loss | Snapshot exact turn scope, detect dirty state, and block ambiguous reversions. |

## 21. Decision gates

### Add a second agent backend only if

- A meaningful segment cannot or will not use the supported OpenCode/provider flow, or
- The second backend offers a measurable capability the current integration cannot provide.

### Add a second game engine only if

- The Phaser experience is reliable and retained users repeatedly hit an engine limitation, and
- The requested engine represents a coherent user segment rather than scattered preference.

### Add cloud infrastructure only if

- Users repeatedly ask for publishing, cross-device access, backups, or collaboration, and
- Local-only reliability and retention are already healthy.

### Build asset generation only if

- Asset acquisition is among the top observed iteration bottlenecks, and
- A simple import/library workflow is insufficient.

## 22. First ten working days

### Day 1

- Initialize Git and app scaffold.
- Add CI checks and the first secure Electron window.
- Write a one-page architecture decision record.

### Day 2

- Integrate an OpenCode SDK spike against a fixture.
- Exercise prompt, events, permission response, cancellation, and shutdown.

### Day 3

- Create the minimal Phaser template.
- Start its dev server from the main process and display it in an isolated preview.

### Day 4

- Implement project creation, manifest validation, and recents.
- Confirm paths containing spaces work.

### Day 5

- Build the permanent two-pane shell and preview status states.
- Demo: create project and play it.

### Day 6

- Implement agent session creation/resumption and prompt submission.
- Define normalized agent events and the turn state machine.

### Day 7

- Stream agent activity into Prompt mode.
- Implement cancellation and failure recovery.

### Day 8

- Connect file changes to preview reload.
- Add verification after the turn.

### Day 9

- Add permission UI and changed-file list.
- Test denial and cancellation cases.

### Day 10

- Complete the first end-to-end prompt-to-play demonstration.
- Record latency, failures, rough edges, and revised estimates before expanding scope.

## 23. Alpha definition of done

The private alpha is ready only when all of the following are true:

- A fresh user can install Caliber and create a playable game.
- The starter renders reliably and has an obvious interaction or goal.
- The user can prompt a meaningful mechanic change.
- Agent progress, permissions, failure, and cancellation are understandable.
- The resulting change is verified and appears in the preview.
- The user can inspect code and a per-turn diff.
- The user can safely revert the latest clean turn.
- Build and runtime errors can be fed back to the agent.
- Projects reopen after restarting the app.
- A game can be exported and served outside Caliber.
- Critical paths have automated end-to-end coverage.
- No known critical data-loss, credential-exposure, or unrestricted-navigation defect remains.
- Child processes reliably stop when the app exits.
- Known limitations and local-code-execution risks are disclosed.

## 24. Immediate next action

The next implementation task should be Phase 0 only: initialize the repository, scaffold the secure desktop shell, and complete two disposable integration spikes—one OpenCode prompt and one embedded Phaser preview.

Do not start by building the polished chat UI. The first technical checkpoint is proving that the two engines of the product—the coding agent and the playable preview—can be started, observed, recovered, and stopped reliably from one application.

## 25. Source decisions

- OpenCode SDK: <https://opencode.ai/docs/sdk/>
- OpenCode server and API surface: <https://opencode.ai/docs/server/>
- OpenCode providers: <https://opencode.ai/docs/providers/>
- OpenCode license: <https://github.com/anomalyco/opencode/blob/dev/LICENSE>
- Codex SDK alternative: <https://learn.chatgpt.com/docs/codex-sdk.md>
- Codex app-server alternative: <https://learn.chatgpt.com/docs/app-server.md>
