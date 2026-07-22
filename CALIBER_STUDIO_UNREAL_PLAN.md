# Caliber Studio — Unreal Multi-Agent Production Plan

Status: Superseded by [the multi-engine AI game creation plan](./CALIBER_STUDIO_PLATFORM_PLAN.md)  
Date: July 21, 2026  
Planning horizon: Technical alpha through an AAA-quality vertical slice  
Supersedes: The original web-first Caliber Studio plan

## 1. Executive decision

Caliber Studio will be an AI-native game production environment built on top of Unreal Engine.

Caliber will not initially build a renderer, physics engine, animation engine, networking stack, or replacement 3D editor. Unreal remains the game engine and native authoring environment. Caliber supplies the persistent game understanding, asynchronous multi-agent coordination, structured engine control, playtesting, validation, and human review loop.

The primary user experience will live inside Unreal Editor through a Caliber C++ editor plugin. The user keeps Unreal's native viewport, selection, transform gizmos, Content Browser, Details panel, asset editors, undo, Play In Editor, and rendering performance. A background Caliber Core service coordinates OpenCode workers, durable tasks, MCP tools, source control, locks, changesets, approvals, builds, and playtests.

The defining product experience is:

> The user continues selecting, moving, and editing game objects while multiple agents work asynchronously elsewhere in the project, with explicit ownership, conflict detection, validation, review, and recovery.

The first external proof will be an AAA-quality 10–15 minute Unreal vertical slice created by a small team using Caliber. The first promise is not a complete AAA-sized game from one prompt.

## 2. Product definition

### One-line description

Caliber is the AI production operating system for building, editing, playtesting, and shipping Unreal games.

### What Caliber owns

- Persistent understanding of the game and its design intent.
- Decomposition of creative requests into reviewable tasks.
- Durable asynchronous agent execution.
- Safe coordination between humans and agents.
- Structured manipulation of Unreal scenes and assets.
- Code, content, build, and playtest feedback loops.
- Validation, performance budgets, approval, provenance, and rollback.
- A coherent production history across code, assets, levels, and tests.

### What Unreal owns

- Rendering.
- Physics.
- Animation.
- Audio runtime.
- Networking runtime.
- Native platform abstraction.
- Asset formats and importers.
- Viewport and editor interaction.
- Blueprint and C++ compilation.
- Cooking, packaging, and platform builds.

### What OpenCode owns

- Individual coding-agent sessions.
- Reading, searching, and editing text files.
- Executing approved shell commands.
- Producing patches and textual artifacts.
- Calling Caliber's Unreal-specific MCP tools.

### What Caliber must not become

- A thin chat panel that merely launches OpenCode.
- A mouse-automation wrapper around Unreal.
- A second, inferior 3D viewport.
- A collection of unsupervised agents writing to one shared folder.
- A demo that changes source code but cannot validate gameplay.
- A promise that AI eliminates art direction, design, engineering, or QA.

## 3. Initial target user and outcome

### Primary user

A technically capable solo creator or small game team building a polished Unreal prototype or vertical slice. They understand game-development concepts but want to compress implementation, iteration, content setup, and testing time.

### Secondary users

- Gameplay programmers delegating bounded implementation tasks.
- Technical designers composing mechanics without manually coordinating every system.
- Technical artists automating repetitive content operations.
- Producers supervising parallel AI work with visible state and approvals.
- QA-minded creators using automated playtest scenarios and regression checks.

### First outcome

A user can open the Caliber Unreal template, request a mechanic, continue editing the level manually, inspect parallel agent progress, accept verified changes, play the result, and safely revert an unwanted changeset.

## 4. Product principles

1. **The user remains in Unreal.** Native Unreal authoring is the primary AAA surface.
2. **User interaction has priority.** An agent never silently overwrites an object the user is editing.
3. **Async means durable.** Tasks survive UI closure, editor restart, agent failure, and machine reboot where practical.
4. **Parallelism is scoped.** Agents work concurrently only when their resources and outputs can be isolated or safely merged.
5. **Every mutation is attributable.** Human and agent changes have author, time, base revision, affected resources, intent, and result.
6. **MCP is a control plane.** It carries bounded engine commands and structured results, not video or per-frame data.
7. **The engine is the authority for assets.** Binary Unreal assets are changed through Unreal APIs, not byte or text manipulation.
8. **Verification is part of completion.** A task is not complete when code is generated; it is complete when required checks pass.
9. **Agents communicate through artifacts.** Plans, patches, reports, changesets, and test results are preferred over unbounded agent conversation.
10. **Build the smallest credible vertical loop.** One excellent mechanic workflow is more valuable than a broad but unsafe tool catalog.

## 5. Core user journeys

### 5.1 Create and open a project

1. Install Caliber Core and the Caliber Unreal plugin.
2. Create a project from the pinned Caliber Unreal C++ template.
3. The plugin connects to the local Caliber Core using a short-lived capability token.
4. Caliber validates Unreal version, plugin version, source-control state, required project settings, and OpenCode availability.
5. The Caliber dock opens beside the native Unreal viewport.
6. Project design context, tasks, agents, selections, and recent changes are restored.

### 5.2 Request a feature

1. User prompts: “Add a short dodge roll with invulnerability and stamina cost.”
2. The Director creates a task graph rather than immediately editing.
3. Caliber shows proposed work, resources, dependencies, and approval requirements.
4. A Code Worker implements stable C++ or Blueprint-facing APIs in an isolated worktree.
5. An Unreal Worker configures assets or Data Assets through the plugin's MCP tools.
6. The Integrator applies compatible outputs to an integration revision.
7. A Test Worker compiles, launches Play In Editor or a standalone test, provides inputs, and captures state.
8. Caliber reports behavior, changed files/assets, checks, screenshots, logs, and remaining risk.
9. User accepts, requests refinement, or reverts the changeset.

### 5.3 Edit while agents work

1. User selects a prop in the Unreal viewport.
2. The plugin emits selection and resource identity to Caliber Core.
3. The user's transform drag acquires a temporary actor lock.
4. The user moves the prop and changes its material using native Unreal controls.
5. Unreal records normal transactions; the plugin records corresponding Caliber events and resource revisions.
6. Any agent touching that actor pauses and re-reads after the user releases it.
7. Agents working on unrelated code, actors, tests, or documentation continue.
8. The user's actions appear in the same project history as agent changes.

### 5.4 Resolve a conflict

1. An agent tries to mutate a resource based on revision 42.
2. The resource is now revision 43 because of a user or other agent change.
3. The mutation is rejected before application.
4. Caliber classifies the conflict as re-readable, mergeable, or exclusive.
5. The worker re-plans automatically when safe; otherwise, the Conflict Center asks the user to choose.
6. No broad reset, forced overwrite, or silent binary merge occurs.

### 5.5 Play and repair

1. User or Test Worker starts a playtest.
2. Caliber records build, runtime, gameplay-event, screenshot, and performance evidence.
3. A failure becomes a linked defect task with exact base revision and reproduction steps.
4. A Repair Worker changes the smallest relevant scope.
5. The failing scenario reruns before the repair is accepted.

## 6. Product surfaces

### 6.1 Caliber Unreal dock

The primary surface is a dockable Unreal Editor tab placed beside the native viewport.

```text
┌────────────────────────────┬─────────────────────────────────────┐
│ Caliber                    │ Unreal native viewport              │
│                            │                                     │
│ Prompt / Plan              │ Select, move, rotate, scale         │
│ Active agents              │ Materials, actors, components       │
│ Tasks and dependencies     │ Native snapping and editor tools     │
│ Approvals and conflicts    │                                     │
│ Changes and verification   ├─────────────────────────────────────┤
│                            │ Details / Outliner / Content Browser│
└────────────────────────────┴─────────────────────────────────────┘
```

The first UI can use native Slate for the dock shell and critical status/approval controls. A locally served React UI may be embedded for richer task timelines, diffs, and prompt interactions after a security and packaging spike. Do not block the plugin/core proof on a perfect web UI.

### 6.2 Optional Caliber Hub

A later lightweight Tauri application may provide:

- Cross-project task monitoring.
- Notifications when async work needs attention.
- Provider and credential setup.
- Build and artifact history.
- Project creation and plugin installation.
- Work that continues while Unreal Editor is closed.

The Hub is not the primary 3D authoring surface and is not required for the technical alpha.

### 6.3 Native Unreal surfaces retained

- Viewport.
- World Outliner.
- Details panel.
- Content Browser.
- Blueprint Editor.
- Material Editor.
- Animation tools.
- Output Log.
- Source Control UI.
- Play In Editor.

Caliber adds context and coordination around these surfaces instead of replacing them.

## 7. High-level architecture

```text
Unreal Editor
├─ Native viewport and editors
└─ Caliber Unreal Plugin (C++)
   ├─ Editor event capture
   ├─ Transactional mutation gateway
   ├─ Selection and resource identity
   ├─ PIE/runtime bridge
   └─ Authenticated local connection
                   │
                   ▼
Caliber Core (Rust daemon)
├─ Project registry
├─ Durable task graph
├─ Scheduler and worker leases
├─ Event log and projections
├─ Resource revisions and locks
├─ Changesets and approvals
├─ Source-control/worktree manager
├─ MCP server
├─ Agent runtime manager
├─ Playtest/evaluation service
└─ SQLite persistence
       │             │
       │             └──────── Unreal build/test processes
       ▼
OpenCode workers
├─ Director
├─ Code Worker
├─ Unreal Worker via MCP
├─ Test Worker
└─ Integrator/Repair Worker
```

## 8. Technology choices

| Component | Initial choice | Reason |
| --- | --- | --- |
| Game engine/editor | One pinned Unreal Engine version | Avoid version-matrix complexity during alpha. |
| Unreal integration | C++ editor plugin with optional runtime module | Direct, typed access to Unreal editor/runtime APIs. |
| Core service | Rust | Durable local daemon, process control, concurrency, safety, and future Tauri reuse. |
| Core persistence | SQLite with migrations | Durable local tasks/events without cloud infrastructure. |
| Agent workers | OpenCode local sessions | Existing coding loop, providers, tools, events, and MCP client support. |
| Agent-engine protocol | MCP | Typed discoverable tools and structured results. |
| Plugin-core protocol | Authenticated loopback WebSocket initially | Cross-platform C++/Rust implementation and bidirectional events. |
| High-volume artifacts | Files with metadata references | Avoid pushing large binaries through MCP. |
| Text source control | Git worktrees for technical alpha | Simple isolated agent workspaces and patch integration. |
| Unreal binary assets | Git LFS locks initially; Perforce adapter later | No unsafe merges of `.uasset` files. |
| Plugin UI | Slate first; React-rich panel after spike | Native reliability first, richer UX without blocking architecture. |
| Optional project hub | Tauri later | Small cross-project desktop surface backed by the same Rust core. |

### Version policy

- Pin one Unreal minor version for the technical alpha.
- Pin OpenCode and MCP SDK/protocol versions tested by Caliber.
- Plugin, Core, template, and protocol versions must report compatibility explicitly.
- Reject incompatible combinations with a useful message rather than attempting best-effort mutation.
- Add a second Unreal version only after automated compatibility tests exist.

## 9. Caliber Core responsibilities

### 9.1 Project service

- Register and validate projects.
- Resolve canonical paths.
- Detect Unreal engine association and plugin version.
- Load `.caliber/project.json`.
- Track active editor connections.
- Track source-control provider and current revision.
- Refuse unsafe roots or ambiguous project identity.

### 9.2 Task service

- Create task graphs.
- Store task inputs, dependencies, resource claims, state, and outputs.
- Lease work to agents.
- Recover abandoned leases.
- Pause, cancel, retry, and supersede work.
- Attach approvals, conflicts, checks, and artifacts.

### 9.3 Agent runtime service

- Start and stop OpenCode worker sessions.
- Assign bounded prompts and workspace roots.
- Normalize OpenCode events into Caliber events.
- Enforce tool and resource policy.
- Monitor liveness and cancellation.
- Prevent workers from silently expanding scope.

### 9.4 Resource service

- Create stable resource identities.
- Maintain current revisions.
- Issue short-lived read/write leases.
- Enforce user-priority locks.
- Track exclusive binary-asset ownership.
- Detect stale expected revisions.
- Produce conflict records.

### 9.5 Changeset service

- Group text patches, asset operations, actor operations, and test results by intent.
- Record base revision and authorship.
- Support preview/dry-run where possible.
- Apply through the correct engine or source-control path.
- Validate and finalize.
- Revert only known operations with conflict checks.

### 9.6 Playtest service

- Define repeatable scenarios.
- Launch PIE, standalone, or commandlet-based checks through the plugin/toolchain.
- Record inputs, events, screenshots, logs, crashes, and performance samples.
- Compare results against explicit assertions and budgets.
- Produce artifacts linked to the originating task and changeset.

## 10. Unreal plugin design

### 10.1 Modules

```text
Plugins/Caliber/
├─ Caliber.uplugin
└─ Source/
   ├─ CaliberProtocol/   # Shared DTOs, IDs, serialization, versioning
   ├─ CaliberEditor/     # Dock, selection, transactions, assets, PIE control
   └─ CaliberRuntime/    # Optional runtime telemetry and playtest hooks
```

`CaliberEditor` is editor-only and must never be packaged into a shipping game unintentionally. `CaliberRuntime` remains minimal and optional so projects do not inherit a large proprietary runtime dependency.

### 10.2 Editor event capture

Capture and normalize:

- Actor selection changes.
- Object property changes.
- Actor added/deleted/moved.
- Map opened/saved.
- Asset created/renamed/deleted/saved.
- Blueprint compile result.
- PIE begin/end/pause.
- Editor undo/redo where observable.
- Source-control state changes.
- Relevant build and Output Log messages.
- Editor/plugin shutdown.

Do not stream every noisy engine event. Debounce transforms and properties where appropriate while preserving transaction boundaries.

### 10.3 Transactional mutation gateway

Every mutating engine operation must:

1. Authenticate the caller and project/editor session.
2. Validate tool schema and operation limits.
3. Resolve stable resource IDs.
4. Check expected revision and lock ownership.
5. Optionally return a dry-run plan.
6. Acquire the required resource lease.
7. open an Unreal transaction.
8. Apply through official Unreal APIs.
9. Compile or save affected resources when required.
10. Validate postconditions.
11. Emit normalized change events.
12. Release or renew the lease.
13. Return structured success, partial failure, or rollback evidence.

### 10.4 Stable resource identity

Use the strongest durable engine identity available for each resource and wrap it in a Caliber resource ID:

- Project.
- Map.
- Actor instance.
- Component.
- Asset package/object path.
- Blueprint class/function where reliably addressable.
- Source file and symbol.
- Test scenario.

Do not let the agent treat display names as unique identifiers.

### 10.5 Edit and Play modes

Caliber exposes explicit modes:

- **Edit:** persistent editor-world and asset changes.
- **Play:** runtime interaction and observation.
- **Review:** changes, evidence, conflicts, and approval without new mutation.

Runtime objects are not assumed to persist. `Apply Runtime Change to Editor` must be a separate reviewed operation that maps runtime state to editor resources and creates an editor transaction.

## 11. MCP architecture

### 11.1 Boundary

OpenCode is the MCP client. Caliber Core hosts or launches the Caliber Unreal MCP server. The MCP server validates the worker identity, task scope, and project before forwarding bounded commands to the connected Unreal plugin.

### 11.2 Transport progression

- **Spike/alpha:** local MCP server launched over `stdio` by OpenCode.
- **Packaged product:** Caliber Core may expose a loopback Streamable HTTP MCP endpoint protected by a short-lived capability token.
- Never expose an unauthenticated MCP endpoint beyond loopback.
- The plugin-core connection remains separate from MCP.

### 11.3 Initial tool catalog

#### Read tools

- `unreal_project_status`
- `unreal_get_selection`
- `unreal_search_assets`
- `unreal_inspect_asset`
- `unreal_inspect_world`
- `unreal_inspect_actor`

#### Mutation tools

- `unreal_apply_changeset`
- `unreal_save_resources`
- `unreal_compile_resources`

#### Runtime and verification tools

- `unreal_start_playtest`
- `unreal_send_playtest_action`
- `unreal_capture_state`
- `unreal_stop_playtest`
- `unreal_validate`
- `unreal_build_target`

The first usable release should expose no more tools than the model can select reliably. Prefer high-level changesets over hundreds of property-specific tools.

### 11.4 Tool request envelope

Every mutating request includes:

```json
{
  "projectId": "project-id",
  "editorSessionId": "editor-session-id",
  "taskId": "task-id",
  "changeSetId": "change-set-id",
  "idempotencyKey": "unique-operation-id",
  "expectedRevisions": {
    "actor:stable-guid": 42
  },
  "dryRun": false,
  "operations": []
}
```

### 11.5 Tool result envelope

Return:

- Applied/skipped/failed operations.
- Previous and resulting revisions.
- Created resources.
- Warnings and validation results.
- Transaction ID.
- Saved/dirty state.
- Artifact references.
- Whether manual review is required.
- Machine-readable error classification.

### 11.6 Data that must not use MCP

| Data | Correct channel |
| --- | --- |
| 60 FPS viewport video | Native Unreal viewport or Pixel Streaming/WebRTC later |
| Continuous mouse/gizmo movement | Native Unreal editor interaction and plugin events |
| High-frequency gameplay telemetry | Dedicated plugin-core stream or artifact files |
| Large textures/models/builds | Files/object storage with metadata references |
| Source patches | Source-control/worktree pipeline |
| Bounded engine commands | MCP |

## 12. Multi-agent orchestration

### 12.1 Agent roles

Start with roles that have distinct authority:

| Role | Responsibility | Write authority |
| --- | --- | --- |
| Director | Understand intent, create task DAG, request missing decisions | Plans only |
| Code Worker | Implement text/C++ changes in isolated worktree | Assigned text scope |
| Unreal Worker | Propose/apply bounded engine changes via MCP | Leased engine resources |
| Test Worker | Build, run scenarios, collect evidence | Test artifacts only |
| Integrator | Merge compatible patches and sequence asset changes | Integration workspace |
| Repair Worker | Fix a specific reproduced failure | Explicit failing scope |

Do not start with five active agents on every request. The Director launches only workers whose work is independently useful.

### 12.2 Task graph

```text
requested
  → planned
  → awaiting_approval
  → ready
  → leased
  → running
  → blocked | needs_review | verifying
  → completed

Any nonterminal state may transition to cancelled or failed.
Completed work may be superseded but not rewritten in history.
```

Dependencies are explicit. A test task cannot start until its required integration revision exists. An asset task cannot apply while its resource is locked by the user.

### 12.3 Worker isolation

- Each Code Worker receives a dedicated Git worktree and branch/ref.
- Each worker gets a bounded task prompt, project instructions, base revision, and resource claims.
- Workers do not inherit unrestricted access to other worktrees.
- Test Workers use read-only snapshots or an integration workspace.
- Unreal asset mutations pass through a serialized or resource-partitioned queue.
- No two writers modify the same binary asset concurrently.

### 12.4 Agent communication

Agents communicate through durable artifacts:

- Task plan.
- Interface contract.
- Patch.
- Engine changeset.
- Build artifact.
- Test report.
- Defect report.
- Decision request.

Free-form messages may supplement artifacts but are not authoritative state.

### 12.5 Async execution

To qualify as asynchronous:

- Tasks persist before execution starts.
- Agent runs have leases and heartbeats.
- A dead worker's lease expires and the task becomes recoverable.
- The plugin and UI can disconnect without losing task history.
- Work requiring an open Unreal Editor waits visibly instead of failing repeatedly.
- User approvals generate resumable events.
- Cancellation propagates to OpenCode, child processes, and pending engine operations.
- Restart reconciliation checks source-control and engine state before resuming.

### 12.6 Initial concurrency limit

For the technical alpha:

- At most one Unreal asset/level writer at a time.
- At most one integration writer.
- One or two isolated Code Workers may run in parallel on disjoint scopes.
- Test Workers run only when they cannot disrupt the user's active editor session, or use a separate process/snapshot.
- The user always retains native editor control.

Increase concurrency only after conflict and recovery metrics justify it.

## 13. Human-agent concurrency model

### 13.1 Resource claims

A task declares claims such as:

```text
read  source:/Source/Game/Combat/**
write source:/Source/Game/Combat/DodgeComponent.*
read  asset:/Game/Characters/Hero/**
write asset:/Game/Data/DA_PlayerMovement
write actor:/Game/Maps/Arena#PersistentActorGuid
```

Claims are plans, not sufficient permission. Actual mutation also requires a valid lease and expected revision.

### 13.2 User-priority locking

- Selection creates awareness, not an exclusive lock by itself.
- Beginning a transform drag or property edit creates a short user-priority write lock.
- Saving an asset may create or respect a longer exclusive asset lock.
- Agent operations on the same resource wait or fail with a typed conflict.
- User locks cannot be stolen by an agent.
- Stale locks expire only after editor-session liveness checks and recovery rules.

### 13.3 Optimistic revisions

Each resource has a monotonic Caliber revision. A mutation based on stale state fails before application. Workers may automatically re-read and re-plan only when the requested intent is still unambiguous.

### 13.4 Text merge

- Produce a patch from the worker worktree.
- Rebase or three-way merge against the integration revision.
- Run formatting, compile, and focused tests.
- Escalate semantic or unresolved conflicts.
- Do not force-reset the user's working copy.

### 13.5 Binary asset merge

- Treat most `.uasset` writes as exclusive.
- Use source-control locks.
- Use One File Per Actor to reduce level contention.
- Reapply declarative Caliber operations to a new base when possible.
- Never attempt blind binary merge.
- Keep source control as the durable authority after accepted integration.

## 14. Unified change model

### 14.1 Changeset contents

```text
ChangeSet
├─ intent and originating prompt
├─ author(s): user or agent runs
├─ base source revision
├─ expected resource revisions
├─ text patches
├─ engine operations
├─ created/deleted/renamed resources
├─ approvals
├─ validation results
├─ artifacts
├─ resulting revisions
└─ revert strategy
```

### 14.2 Human changes

Native user edits remain normal Unreal transactions. Caliber observes and groups them into human changesets using transaction boundaries, asset saves, and time/context heuristics. Caliber must not break Unreal's native undo behavior.

### 14.3 Agent changes

Agent changes are applied only through controlled text integration or the engine mutation gateway. Every agent changeset has explicit task scope and evidence.

### 14.4 Revert

- Text revert applies an inverse patch only when the current content matches expected context.
- Engine revert uses a known inverse operation or Unreal transaction where still valid.
- Accepted source-control commits may be reverted with a new commit, not history rewriting.
- Ambiguous revert stops and asks for review.
- Revert never invokes broad cleanup or deletes unrelated untracked content.

## 15. Persistence model

SQLite is the local source of truth for Caliber orchestration state.

### Core entities

- `projects`
- `editor_sessions`
- `tasks`
- `task_dependencies`
- `agent_runs`
- `worker_leases`
- `resources`
- `resource_revisions`
- `resource_locks`
- `changesets`
- `changeset_operations`
- `approvals`
- `conflicts`
- `validations`
- `artifacts`
- `events`

### Event log

Store immutable domain events for recovery and audit, then maintain queryable projections for the UI. Examples:

```text
TaskPlanned
TaskLeased
AgentRunStarted
ActorSelected
UserEditStarted
ResourceLocked
ResourceChanged
MutationRejectedStaleRevision
ChangeSetApplied
ValidationFailed
ApprovalRequested
TaskCompleted
```

Do not store raw provider credentials, complete process environments, or unnecessary game source in SQLite.

## 16. Project template

```text
CaliberGame/
├─ .caliber/
│  ├─ project.json
│  ├─ design.md
│  ├─ architecture.md
│  ├─ playtests/
│  └─ policies/
├─ Config/
├─ Content/
├─ Plugins/
│  └─ Caliber/
├─ Source/
├─ Tests/
├─ AGENTS.md
├─ CaliberGame.uproject
└─ README.md
```

### Template requirements

- C++ project rather than Blueprint-only.
- Caliber plugin installed and enabled.
- One File Per Actor enabled where appropriate.
- Source-control ignore and LFS configuration.
- Minimal, readable gameplay architecture.
- Example native and Blueprint-facing component.
- Example Data Asset for tunable values.
- Example playtest scenario and validation.
- Explicit build, editor-launch, test, and package commands.
- `AGENTS.md` defining verification, file boundaries, prohibited operations, and Unreal-specific conventions.

### Project manifest

```json
{
  "schemaVersion": 1,
  "projectId": "stable-project-id",
  "displayName": "Caliber Arena",
  "engine": {
    "type": "unreal",
    "version": "pinned-supported-version"
  },
  "pluginProtocolVersion": 1,
  "sourceControl": {
    "type": "git"
  },
  "commands": {
    "buildEditor": "platform-specific configured command",
    "test": "platform-specific configured command",
    "package": "platform-specific configured command"
  }
}
```

## 17. Game understanding and memory

Caliber needs more than repository context.

### Design memory

- Creative pillars.
- Player fantasy.
- Core loop.
- Art direction.
- Control conventions.
- Difficulty and accessibility rules.
- Content constraints.
- Performance targets.
- Prohibited changes.

### Technical model

- Major modules and ownership.
- Gameplay systems and interfaces.
- Maps and important actors.
- Asset relationships.
- Blueprint/C++ boundaries.
- Input actions.
- Save/network authority rules.
- Tests and known defects.

### Updating memory

- Durable facts require a cited project source or user approval.
- Agent guesses remain hypotheses.
- Accepted changes may propose memory updates.
- Contradictions become decision requests rather than silent overwrites.
- Keep memory compact and task-relevant; do not dump the entire asset registry into every prompt.

## 18. Playtesting and evaluation

### Scenario format

Each scenario defines:

- Required map/build.
- Initial state or setup action.
- Deterministic seed when supported.
- Timed or semantic input actions.
- Expected gameplay events/state.
- Screenshot checkpoints.
- Performance budgets.
- Cleanup.

### First scenarios

- Launch project and reach playable state.
- Move, jump, and interact.
- Trigger one combat ability.
- Damage and defeat a representative enemy.
- Restart after death.
- Verify no fatal errors and acceptable frame time on the baseline machine.

### Evidence

- Build and compile result.
- Blueprint compile result.
- Data validation result.
- Runtime logs and call stacks.
- Gameplay-event trace.
- Screenshots or short clips.
- CPU/GPU/frame-time sample.
- Crash or timeout classification.

### Completion policy

The Director chooses required checks when planning. A worker cannot mark its own task complete without the independent required validation outcome.

## 19. Security and safety

### Trust boundaries

- User and Unreal Editor.
- Caliber plugin.
- Caliber Core.
- OpenCode worker processes.
- Model providers.
- Project build/test processes.
- Source-control credentials.

### Required controls

- Bind all local services to loopback or OS-local IPC.
- Use per-editor-session capability tokens.
- Rotate tokens on reconnect/restart.
- Authenticate every mutation and associate it with task and worker identity.
- Validate canonical project paths.
- Scope worker filesystem access to assigned worktrees/project resources.
- Preserve command and network approval policy.
- Redact secrets and absolute private paths from logs where practical.
- Limit MCP request size, operation count, and execution time.
- Add idempotency keys to mutation requests.
- Reject unknown protocol fields in strict production mode.
- Never expose arbitrary C++ function invocation as a general MCP tool.
- Never expose unrestricted `execute_python` or editor-console tools to the model by default.
- Keep an audit trail of approvals and destructive operations.
- Make generated-code execution risk explicit to alpha users.

### Destructive actions

Deletion is an explicit high-risk operation:

- Preview exact resources.
- Require approval unless covered by a narrowly approved plan.
- Use Unreal/source-control recovery paths.
- Delete no wildcard-selected or unresolved resource set.
- Record recoverability.

## 20. UI and interaction specification

### Prompt view

- Prompt composer.
- Current selection/context chips.
- Proposed plan.
- Agent activity summarized by task.
- Attach selected actors, assets, logs, and screenshots.
- Cancel/pause controls.

### Task graph view

- Task state and dependencies.
- Assigned agent.
- Claimed resources.
- Start time/duration.
- Waiting reason.
- Artifacts and validation.
- Retry/cancel/supersede controls.

### Active agents view

- What each agent is doing now.
- Workspace/base revision.
- Read/write scope.
- Last heartbeat.
- Whether work can continue without Unreal open.
- Attention request.

### Change review

- Intent summary.
- Text diff.
- Engine operation list.
- Changed actors/assets.
- Before/after screenshots.
- Checks and performance evidence.
- Accept, request changes, or revert.

### Conflict Center

- Competing authors.
- Resource and revisions.
- User-visible difference.
- Safe automatic resolution if available.
- Choices with consequences.
- No “force overwrite all” primary action.

### Notifications

Notify only when:

- Approval is required.
- A conflict needs a user decision.
- A long-running task completes or fails.
- Unreal must be opened or closed.
- A build/playtest produces a critical failure.

## 21. Repository plan

Keep one repository until independently released components require separation.

```text
caliber-studio/
├─ apps/
│  ├─ caliber-core/          # Rust daemon
│  └─ caliber-ui/            # Shared rich UI if/when introduced
├─ plugins/
│  └─ unreal-caliber/        # C++ Unreal plugin
├─ crates/
│  ├─ caliber-domain/        # Tasks, resources, changesets
│  ├─ caliber-protocol/      # Plugin/core wire types
│  ├─ caliber-store/         # SQLite and migrations
│  ├─ caliber-agents/        # OpenCode worker management
│  └─ caliber-mcp/           # MCP server/tools
├─ templates/
│  └─ unreal-caliber-game/
├─ schemas/
│  ├─ protocol/
│  └─ mcp/
├─ tests/
│  ├─ fixtures/
│  ├─ protocol/
│  ├─ integration/
│  └─ e2e/
├─ docs/
│  ├─ architecture/
│  ├─ decisions/
│  ├─ product/
│  ├─ protocol/
│  └─ threat-model.md
├─ AGENTS.md
├─ CALIBER_STUDIO_UNREAL_PLAN.md
└─ README.md
```

Do not split every crate immediately. Begin with a small number of modules and extract only around actual process/protocol boundaries.

## 22. Development workflow and CI

### Required checks

- Rust format, lint, unit, and integration tests.
- Unreal plugin compile against the pinned engine version.
- Protocol schema compatibility tests.
- MCP tool schema tests.
- Database migration tests.
- Fixture-project build.
- Unreal automation/data validation smoke tests.
- End-to-end task recovery and conflict tests.
- Packaging/install test.

### Live provider tests

Default CI must not depend on paid model calls. Use a deterministic fake OpenCode event/worker adapter for orchestration tests. Run a separate opt-in live-agent smoke test against a disposable fixture.

### Small milestones

Commit and push after each verified vertical increment once the repository and remote exist. Never mix unrelated refactors into feature milestones.

## 23. Verification matrix

| Area | Narrow verification |
| --- | --- |
| Protocol | Golden messages and compatibility tests |
| Task scheduler | Deterministic state-machine and lease-expiry tests |
| Resource locking | Concurrent actor/user/agent simulation |
| Text integration | Worktree patch and conflict fixtures |
| Unreal mutations | Editor automation tests on disposable map/assets |
| Transactions | Apply, undo, redo, restart, and revision checks |
| Async recovery | Kill/restart Core, worker, and Editor at each task state |
| MCP | Schema validation, idempotency, auth, timeout, and scope tests |
| Playtest | Known pass/fail fixture scenarios |
| Security | Path traversal, stale token, oversized request, arbitrary command denial |

## 24. Delivery roadmap

The schedule assumes one experienced full-time engineer and will be faster with a dedicated Unreal C++ engineer plus a Rust/product engineer. A credible solo technical alpha is approximately 14–18 focused weeks. The vertical slice follows the platform alpha.

### Phase 0 — Architecture and integration spikes

Target: 1–2 weeks

Build:

- Initialize Git, remote, CI, and repository skeleton.
- Pin the initial Unreal version.
- Create a minimal Unreal editor plugin and dock tab.
- Create a minimal Rust Core process with SQLite.
- Establish authenticated plugin-core messaging.
- Start one OpenCode session against a disposable Unreal C++ project.
- Expose one read-only and one mutating Unreal MCP tool.
- Verify plugin/editor/core/worker shutdown and restart behavior.

Exit criteria:

- Caliber dock reports a connected Core.
- `unreal_get_selection` returns the selected actor.
- A transactional MCP call moves a disposable actor and can be undone.
- One OpenCode worker can call that tool.
- No blocking architecture issue remains undocumented.

### Phase 1 — Native live editing bridge

Target: 2 weeks

Build:

- Selection/resource identity.
- Actor/property/asset event capture.
- Transform event debouncing and transaction boundaries.
- Resource revision tracking.
- User-priority edit locks.
- Core event history and basic dock status.
- Editor reconnect/reconciliation.

Exit criteria:

- Selecting, moving, rotating, scaling, and changing a material appears in Caliber history.
- User editing blocks a conflicting agent mutation.
- Unrelated agent reads continue.
- Editor restart restores consistent revisions or reports reconciliation required.

### Phase 2 — Safe single-agent feature loop

Target: 2–3 weeks

Build:

- Project manifest and template.
- OpenCode lifecycle and normalized events.
- Task record and single Worker lease.
- Text worktree creation and patch integration.
- Initial MCP tool catalog.
- Changeset review.
- Compile and focused validation.
- Safe cancellation and failure handling.

Exit criteria:

- A prompt changes C++ and one Unreal resource through a single reviewed changeset.
- The project compiles.
- The changed mechanic is playable.
- Cancellation leaves source and editor state consistent.

### Phase 3 — Durable async task system

Target: 2 weeks

Build:

- Task DAG and dependencies.
- Persistent worker leases/heartbeats.
- Pause, resume, retry, supersede, and cancel.
- Core restart recovery.
- UI task graph and attention states.
- Work that waits correctly for Unreal availability.

Exit criteria:

- A multi-step task survives closing the Caliber dock.
- Restarting Core does not duplicate a mutation.
- Work requiring Unreal waits and resumes after editor reconnection.
- User can understand why every nonterminal task is waiting or running.

### Phase 4 — Controlled multi-agent execution

Target: 2–3 weeks

Build:

- Director task planning.
- Two isolated Code Workers.
- Unreal mutation queue.
- Integrator.
- Resource claims and conflicts.
- Parallelism policy.
- Conflict Center.
- Independent Test Worker.

Exit criteria:

- Two disjoint code tasks run concurrently and integrate.
- One Unreal writer waits while the user edits the same actor.
- A stale mutation is rejected and safely re-planned.
- A conflicting binary asset change never overwrites silently.

### Phase 5 — Playtest and repair loop

Target: 2–3 weeks

Build:

- Runtime module/hooks.
- Scenario format.
- PIE control and semantic inputs.
- Structured gameplay events/state capture.
- Screenshot/log/performance artifacts.
- Defect and Repair Worker loop.
- Repeatable verification.

Exit criteria:

- A known defect is reproduced by a scenario.
- A Repair Worker changes the bounded scope.
- The scenario passes on the resulting integration revision.
- Evidence is visible in change review.

### Phase 6 — Technical alpha quality

Target: 2–3 weeks

Build:

- Installer and plugin setup.
- Compatibility diagnostics.
- Security hardening and threat-model review.
- Crash/restart recovery.
- Diagnostic bundle.
- Onboarding and sample requests.
- End-to-end automated critical paths.
- Known-limitations and local-execution disclosure.

Exit criteria:

- Ten clean runs of the core demo on fresh fixture projects.
- No known critical data-loss, credential, or unauthorized-mutation defect.
- Another developer can install and complete the workflow unaided.
- Core, workers, Unreal processes, and locks clean up reliably.

### Phase 7 — AAA-quality vertical slice

Target: 4–8 weeks after platform alpha, depending on content scope and team

Build one deliberately bounded game slice with:

- One polished player mechanic set.
- One representative enemy family.
- One small environment.
- One complete combat/interaction loop.
- Final-quality visual/audio target for a small area.
- Automated smoke and gameplay scenarios.
- Performance budgets.
- Packaged executable.
- Production diary measuring where Caliber saved or lost time.

Exit criteria:

- A new player can complete the 10–15 minute slice.
- Required automated scenarios pass.
- Target baseline machine meets defined performance budgets.
- Every major feature has traceable human/agent changes and evidence.
- The team can identify the next three highest-value Caliber capabilities from actual production use.

## 25. First 20 working days

### Days 1–2

- Initialize Git and remote.
- Add repository skeleton, CI, decision log, and threat-model stub.
- Pin the Unreal version and establish the fixture project.

### Days 3–5

- Scaffold the C++ editor plugin.
- Register a dock tab.
- Capture selected actor identity and display it in logs/UI.

### Days 6–8

- Scaffold Rust Core and SQLite migrations.
- Implement authenticated handshake and heartbeat.
- Persist editor sessions and normalized selection events.

### Days 9–10

- Implement actor inspection request/response.
- Add stable resource identity and initial revision.

### Days 11–12

- Implement a transactional actor-transform operation with expected revision.
- Verify native undo/redo and stale-revision rejection.

### Days 13–14

- Wrap inspection and transform operations as local MCP tools.
- Configure OpenCode to call them.

### Days 15–16

- Start one bounded OpenCode task.
- Normalize worker lifecycle/events into Core.
- Implement cancel and cleanup.

### Days 17–18

- Implement user-priority lock during native transform drag.
- Demonstrate an agent waiting instead of overwriting.

### Days 19–20

- Build the first end-to-end demo:
  - user selects and moves one actor;
  - agent inspects a different actor;
  - agent transactionally changes it;
  - both actions appear in history;
  - the user can undo/review safely.
- Review metrics, risks, and Phase 1 scope before expanding tools.

## 26. Prioritized backlog

### P0 — Technical alpha

- C++ editor plugin and dock.
- Rust Core and SQLite.
- Authenticated plugin-core protocol.
- Selection and resource identity.
- Resource revisions and user-priority locks.
- Transactional actor/asset mutation gateway.
- Local MCP server.
- OpenCode worker lifecycle.
- Durable tasks, leases, and cancellation.
- Git worktree integration.
- Text and engine changesets.
- Compile/validation.
- Controlled two-worker concurrency.
- Conflict Center.
- One repeatable playtest and repair scenario.
- Installer, diagnostics, and end-to-end tests.

### P1 — Strong private alpha

- Rich React task/diff panel.
- More asset/Blueprint operations.
- Source-control lock UI.
- Screenshot/clip comparison.
- Better scenario authoring.
- Performance regression view.
- Cross-project notifications.
- Optional Tauri Hub.
- Perforce integration spike.

### P2 — Production expansion

- Multiple Unreal versions.
- Perforce provider.
- BuildGraph/build-farm integration.
- Multi-machine workers.
- Team identities and remote approvals.
- Pixel Streaming preview outside Unreal.
- Technical-art/DCC adapters.
- Asset provenance pipeline.
- Broader automated gameplay input and observation.

### Explicitly deferred

- Custom renderer/physics engine.
- Console platform support.
- General-purpose Blueprint graph synthesis without bounded schemas.
- Unrestricted autonomous project-wide improvement.
- Cloud execution before local recovery is reliable.
- Real-time human collaboration beyond Unreal/source-control primitives.
- A marketplace.

## 27. Team plan

### Minimum credible team

- **Unreal/C++ engineer:** plugin, editor APIs, transactions, assets, PIE/runtime bridge.
- **Rust/systems engineer:** Core, scheduler, persistence, protocols, processes, security.
- **Product/frontend engineer or designer:** dock experience, task graph, review/conflicts, onboarding.
- **Technical designer/artist:** vertical-slice production and workflow validation.

A strong solo engineer can produce the technical alpha sequentially, but the schedule should assume limited simultaneous progress across Unreal, Rust, UX, and content.

### Ownership rule

Every milestone has one accountable owner and a checkable demonstration. Multi-agent code generation does not replace human technical ownership.

## 28. Product and engineering metrics

### Reliability

- Unauthorized mutations: target zero.
- Silent overwrites: target zero.
- Duplicate mutations after retry/restart: target zero.
- Task recovery success.
- Stale revision rejection correctness.
- Lock leak rate.
- Build/playtest success rate.

### Workflow

- Time from request to approved plan.
- Time from plan approval to playable result.
- Percentage of agent work accepted without manual repair.
- User-edit interruptions caused by agents.
- Conflicts resolved automatically versus manually.
- Time user spends waiting for agents.
- Parallel work that actually shortens critical path.

### Product value

- Time to implement the benchmark mechanic manually versus with Caliber.
- Number of iteration loops per session.
- Percentage of completed tasks followed by a playtest.
- Percentage of failures recovered inside Caliber.
- Users returning to continue the same project.

Do not collect source, prompts, screenshots, or asset contents without explicit consent.

## 29. Alpha validation scenarios

### Benchmark A — User-agent collision

- Agent plans to move Actor A.
- User begins moving Actor A first.
- Agent waits and re-reads.
- No overwrite occurs.

### Benchmark B — Parallel code work

- Worker 1 changes movement code.
- Worker 2 changes HUD code.
- Both use isolated worktrees.
- Integrator merges and compiles.

### Benchmark C — Binary asset exclusivity

- Unreal Worker has a material asset lease.
- Second worker requests the same asset.
- Second worker waits or fails cleanly.
- First save becomes a reviewable changeset.

### Benchmark D — Restart recovery

- Kill Core during a waiting approval.
- Restart.
- Task and approval restore without duplicate mutation.

### Benchmark E — Playtest repair

- Introduce a deterministic gameplay defect.
- Test Worker reproduces it.
- Repair Worker fixes bounded scope.
- Scenario passes and evidence is attached.

### Benchmark F — Manual native editing

- User selects an actor.
- Moves/rotates/scales it.
- Changes material/texture.
- Saves and undoes.
- Caliber history and resource revisions remain consistent.

## 30. Major risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Unreal APIs vary by version | Plugin churn | Pin one version and add compatibility tests before expanding. |
| Multiple agents create more conflicts than speed | Poor trust and throughput | Scope tasks, isolate text workers, serialize engine writes, measure critical-path savings. |
| Binary assets cannot merge safely | Lost work | Exclusive locks, OFPA, declarative operations, source-control authority. |
| Plugin event stream is noisy or incomplete | Incorrect revisions | Normalize transaction/save boundaries, reconcile state, build fixture tests. |
| Core restarts during mutation | Duplicate or partial work | Idempotency keys, transaction IDs, post-restart reconciliation, explicit uncertain state. |
| OpenCode API changes | Worker integration churn | Pin version and normalize behind a small adapter. |
| MCP tool catalog grows too large | Agent reliability drops | Small high-level tool set, task-specific enablement, schema/eval tests. |
| User and agent fight over objects | Product becomes unusable | User-priority locks and expected revisions. |
| Playtests are flaky | False confidence | Deterministic fixtures, semantic actions, retries only for classified infrastructure failures. |
| UI inside Unreal slows delivery | Architecture stalls | Slate status/proof first; richer embedded UI after core loop works. |
| Product looks like generic chat | Weak differentiation | Lead with async coordination, live editing, playtesting, and change safety. |
| “AAA” expectation becomes unlimited scope | No shippable milestone | Commit to a 10–15 minute vertical slice and explicit quality budgets. |

## 31. Decision gates

### Add more parallel writers only if

- Current lock/conflict behavior is reliable.
- Parallelism measurably reduces task critical path.
- Recovery from interrupted integration is tested.

### Add remote/cloud agents only if

- Local durable tasks are reliable.
- Project and credential isolation have a reviewed design.
- Large Unreal workspace/artifact transfer is economically justified.

### Add a Tauri Hub only if

- Users need cross-project monitoring or background attention outside Unreal.
- The same Core APIs can serve it without duplicating state.

### Add another engine only if

- The Unreal loop is retained and reliable.
- A coherent customer segment requires another engine.
- Engine-specific tools can preserve Caliber's safety guarantees.

### Build a Caliber runtime/engine only if

- Unreal creates a measured, repeated limitation that adapters cannot solve.
- The limitation affects core user value.
- Owning the runtime is more valuable than deeper Unreal integration.

## 32. Technical alpha definition of done

The technical alpha is complete only when:

- Caliber installs into the pinned Unreal version.
- Core and plugin authenticate and reconnect safely.
- Native selection and user edits appear in Caliber state.
- User transform/material editing continues while unrelated agents work.
- A conflicting agent mutation cannot overwrite the user.
- At least two disjoint text workers can operate asynchronously.
- Unreal writes are leased and transactional.
- Tasks, workers, approvals, and conflicts survive restart.
- One end-to-end feature changes both text and engine resources.
- The feature compiles and passes a repeatable playtest.
- Every accepted task has a reviewable changeset and evidence.
- Revert is scoped and does not destroy unrelated work.
- No known critical data-loss, secret-exposure, or unauthorized-mutation issue remains.
- Shutdown cleans up workers, child processes, editor sessions, and locks.

## 33. Vertical-slice definition of done

- 10–15 minutes of cohesive playable content.
- One polished core mechanic and complete player feedback loop.
- One representative enemy or challenge family.
- Intentional environment, lighting, VFX, audio, and UI target.
- Repeatable build and package.
- Smoke/gameplay scenarios pass.
- Performance budgets pass on the baseline machine.
- Major changes are attributable and recoverable.
- External testers can play without developer assistance.
- Production retrospective identifies actual Caliber time savings and failures.

## 34. Immediate next action

Execute Phase 0 only.

The first proof is not a polished prompt UI or many agents. It is a native Unreal selection and transaction traveling through a secure Caliber Core and MCP path:

1. Select an actor in Unreal.
2. Caliber Core receives its stable identity and revision.
3. OpenCode calls a bounded MCP tool.
4. The plugin transactionally moves a different actor.
5. The user can undo it natively.
6. If the user is already editing that actor, the agent waits instead.
7. Restarting Core does not duplicate the change.

Once this works reliably, build the durable task graph and controlled second worker.

## 35. Source decisions

- Unreal plugins: <https://dev.epicgames.com/documentation/en-us/unreal-engine/plugins-in-unreal-engine>
- Unreal Slate UI: <https://dev.epicgames.com/documentation/en-us/unreal-engine/slate-user-interface-programming-framework-for-unreal-engine>
- Unreal Interactive Tools Framework: <https://dev.epicgames.com/documentation/en-us/unreal-engine/interactive-tools-framework-in-unreal-engine>
- Unreal Multi-User Editing: <https://dev.epicgames.com/documentation/en-us/unreal-engine/multi-user-editing-overview-for-unreal-engine>
- Unreal One File Per Actor: <https://dev.epicgames.com/documentation/en-us/unreal-engine/one-file-per-actor-in-unreal-engine>
- Unreal source control: <https://dev.epicgames.com/documentation/en-us/unreal-engine/source-control-in-unreal-engine>
- Unreal Python editor scripting: <https://dev.epicgames.com/documentation/en-us/unreal-engine/scripting-the-unreal-editor-using-python>
- Unreal Automation Test Framework: <https://dev.epicgames.com/documentation/en-us/unreal-engine/automation-test-framework-in-unreal-engine>
- Unreal Data Validation: <https://dev.epicgames.com/documentation/en-us/unreal-engine/data-validation-in-unreal-engine>
- Unreal BuildGraph: <https://dev.epicgames.com/documentation/en-us/unreal-engine/buildgraph-for-unreal-engine>
- Unreal Pixel Streaming: <https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-pixel-streaming-reference>
- OpenCode SDK: <https://opencode.ai/docs/sdk/>
- OpenCode server: <https://opencode.ai/docs/server/>
- OpenCode MCP servers: <https://opencode.ai/docs/mcp-servers/>
- MCP transports: <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
