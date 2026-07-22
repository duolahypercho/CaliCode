# Caliber Studio — Multi-Engine AI Game Creation Plan

Status: Definitive master plan v4  
Date: July 21, 2026  
Planning horizon: Web private alpha through Godot, Unity, and Unreal adapters  
Supersedes: The original web-first plan and the Unreal-only plan

## 1. Executive decision

Caliber Studio will be an AI-native, multi-engine game creation environment.

It will combine five things in one production loop:

1. Prompting, code, tasks, and asynchronous agents on the left.
2. A directly editable game viewport on the right.
3. An Asset Foundry that generates, imports, improves, validates, and tracks game assets.
4. A Style and Immersion system that keeps assets, rendering, camera, animation, audio, and interaction coherent.
5. Engine adapters that connect the same Caliber control plane to Web, Godot, Unity, and Unreal projects.

Caliber will not build a renderer, physics engine, animation engine, or universal replacement for every game editor. It will own the creative control plane around those engines:

- Project understanding and memory.
- Human and agent task coordination.
- Safe scene and code changes.
- Asset generation and production processing.
- Automated playtesting and performance evaluation.
- Review, provenance, recovery, and publishing workflows.

The platform order is:

1. Web3D first.
2. Godot second.
3. Unity third.
4. Unreal fourth.
5. Web2D as an additional template after the Web3D foundation is stable.

This order does not make Unreal or Unity unimportant. It prevents Caliber from becoming a single-engine plugin before its actual product loop has been proven.

The first product proof is:

> A creator chooses or defines an immersive visual style, describes a small game environment, Caliber generates and processes visually consistent assets, agents build the scene and gameplay asynchronously, the creator directly edits objects in the live viewport, Caliber keeps the project smooth against a measurable performance budget, and the creator publishes a playable URL.

## 2. Product definition

### One-line description

Caliber is the AI production studio for creating, editing, testing, and shipping games across modern game engines.

### The product promise

A user should be able to move continuously between intent and direct manipulation:

- Describe a mechanic or environment.
- Watch Caliber decompose the work.
- See coding, scene, asset, and testing agents work independently.
- Click an object and adjust its transform, material, texture, behavior, or metadata.
- Generate or import a better asset without breaking scene references.
- Play the game immediately.
- Review the exact changes made by humans and agents.
- Publish or export the result.

### What Caliber owns

- The durable task graph.
- The unified change and revision model.
- The project knowledge graph.
- The asset catalog and asset lineage.
- Provider routing for asset generation.
- Engine adapter contracts.
- Agent permissions and work isolation.
- Quality and performance gates.
- Versioned Style Packs and renderer bindings.
- Immersion profiles covering camera, feedback, animation, audio, and atmosphere.
- Playtest orchestration.
- Human review and approval.

### What game engines own

- Rendering.
- Physics.
- Audio playback.
- Native scene and resource formats.
- Engine-specific scripting and build pipelines.
- Platform-specific packaging.
- Native editor features when an external editor is being used.

### What Caliber does not promise

- One prompt producing a complete AAA-sized game.
- Perfect automatic conversion of a finished project between engines.
- Every AI-generated model being production-ready without processing.
- One universal scene format replacing engine-native formats.
- Photoreal hero assets without art direction or human review.
- Supporting four engines at production quality on day one.

## 3. Why Web comes first

Web is the correct first proving ground because it gives Caliber:

- Instant preview without launching an external editor.
- Direct ownership of the editing experience.
- Fast hot reload.
- Shareable builds through a URL.
- Straightforward screenshot, input, and performance automation.
- A low-friction onboarding path.
- A controlled environment for proving human-agent concurrency.
- Native use of glTF and GLB assets.

Web is not being chosen because every future game should be browser-only.

Web is the fastest way to prove the Caliber workflow. Godot, Unity, and Unreal projects will later use their own native runtime and editor surfaces while connecting to the same Core, Asset Foundry, agent system, and protocols.

### Web quality position

The first Web target is a polished desktop-browser 3D vertical slice, not a massive open world.

The reference experience should have:

- Coherent art direction.
- High-quality lighting and materials.
- Smooth camera and input.
- Progressive asset loading.
- Stable frame pacing.
- A measurable scene budget.
- A short but complete gameplay loop.

The first art direction should be stylized or semi-stylized. It is more achievable for a small team, more tolerant of generated geometry, easier to keep consistent, and more practical for browser performance. Photorealism becomes a later quality tier.

## 4. Engine roadmap and capability tiers

### Tier A — Web3D

Web3D is the reference Caliber implementation.

It receives the complete experience first:

- Embedded editor viewport.
- Object selection and transform gizmos.
- Inspector and material editing.
- Asset generation and drag-to-place.
- Game-code editing and hot reload.
- Multi-agent work.
- Playtesting.
- Performance telemetry.
- One-click preview publishing.

Web3D uses a renderer-adapter layer. The first two candidates are:

- Three.js WebGPURenderer for highly customized visual styles, TSL shaders, node materials, post-processing, and optional WebXR.
- Babylon.js for a more integrated game-engine feature set, PBR rendering, physics integration, animation, particles, and tooling.

Both prefer WebGPU and retain a WebGL 2 fallback path. A project selects exactly one renderer backend when it is created. Caliber does not mix Three.js and Babylon.js inside one shipped game.

The first ten working days compare Three.js and Babylon.js using the same scene, Style Pack, assets, direct-edit operations, and performance capture. One becomes the reference alpha renderer. The second is implemented after the complete alpha loop is stable unless the bakeoff demonstrates that both can be maintained without delaying the product.

### Tier B — Godot

Godot is the first native-engine adapter because:

- The editor is extensible.
- Scene files are largely text-based.
- Editor plugins can add docks, inspectors, importers, and 3D gizmos.
- Command-line and headless workflows are available.
- GLB and glTF fit the Asset Foundry pipeline.
- The engine is open source and accessible to indie creators.

Caliber will live inside Godot through an editor plugin and will use Godot's native viewport rather than streaming it into the Web Studio.

### Tier C — Unity

Unity receives a C# editor extension after the adapter protocol and Asset Foundry have stabilized.

Unity support focuses on:

- Selection and hierarchy events.
- Serialized scene and prefab changes.
- Asset Database integration.
- Undo transactions.
- Play Mode automation.
- Build and test tools.

### Tier D — Unreal

Unreal receives a C++ editor plugin after Caliber has proven its workflow on Web and Godot.

Unreal support focuses on:

- Native viewport and Details panel integration.
- Transactional actor and asset changes.
- Source-control-aware binary asset handling.
- One File Per Actor where applicable.
- Play In Editor, automation, validation, and build tools.

### Web2D

Web2D is a separate template, likely using Phaser, after Web3D is stable.

It shares:

- Caliber Core.
- Agent orchestration.
- Asset Foundry.
- Task and change models.
- Publishing.

It does not force 2D and 3D games into the same runtime abstraction.

## 5. Target user and first outcome

### Initial user

A technically curious solo creator or small game team that wants to build a polished prototype without manually coordinating every code, content, and testing task.

### Initial game scope

The first reference project should contain:

- One compact 3D environment.
- One controllable character.
- One traversal or combat mechanic.
- One objective.
- One enemy or hazard type.
- One interaction system.
- Sound effects and a basic music layer.
- A title, pause, and completion state.
- Five to ten minutes of polished play.

### First external claim

Caliber can help a small team produce a visually coherent, performant Web3D vertical slice significantly faster while preserving direct creative control.

The claim is not that Caliber replaces an experienced game team.

## 6. Core user journeys

### Journey A — Start from an idea

1. The user creates a Web3D project.
2. Caliber asks for genre, camera, art direction, target device, and scope.
3. Caliber creates a short design brief and a project style bible.
4. A Director agent proposes a task graph and asset list.
5. The user approves or edits the plan.
6. Asset and code agents begin independent work.
7. The first playable graybox appears.

### Journey B — Directly edit the game

1. The user clicks an object in the right-side viewport.
2. Caliber shows its name, stable ID, transform, components, materials, source asset, and current revision.
3. The user moves, rotates, scales, duplicates, or deletes it with native controls.
4. The user changes a texture or material in the inspector.
5. The change is immediately visible.
6. The operation appears in the history and supports undo.
7. Agents working on the same resource pause and re-read the new revision.

### Journey C — Generate a prop

1. The user selects a location or placeholder.
2. The user asks for a prop matching the project style.
3. Asset Foundry creates a structured brief using the style bible and target budget.
4. A provider generates several candidates.
5. Caliber shows turntables, estimated cost, triangle count, materials, and texture memory.
6. The user selects a candidate.
7. Caliber runs optimization, validation, collision, LOD, and format processing.
8. The approved asset replaces the placeholder without losing transform or gameplay references.

### Journey D — Build an environment

1. The user asks for an environment, such as an abandoned observatory.
2. Caliber decomposes it into a modular kit, hero props, dressing props, surfaces, lighting, effects, and audio.
3. Asset agents create or source each category.
4. An Environment agent assembles the kit.
5. A Performance agent measures the scene.
6. Caliber suggests or automatically applies approved LOD, instancing, texture, and lighting optimizations.
7. The user edits the final composition directly.

### Journey E — Async collaboration

1. The user requests a new mechanic and a visual environment pass.
2. The Director creates separate code, scene, asset, and test tasks.
3. Workers receive isolated scopes.
4. The user continues editing an unrelated object.
5. Completed work becomes a reviewable changeset.
6. The Integrator checks revisions, tests, performance, and conflicts.
7. The user accepts, revises, or rejects each changeset.

### Journey F — Playtest and repair

1. Caliber launches the game in an instrumented preview.
2. A Test agent sends input and observes frames, logs, state, and performance.
3. The agent records a reproducible failure.
4. A Repair task is created with evidence.
5. The fix is implemented in isolation.
6. The original scenario and regression suite run again.

### Journey G — Publish

1. Caliber builds an optimized Web release.
2. Automated checks validate loading, frame rate, broken links, licenses, and asset budgets.
3. The user reviews the release report.
4. Caliber publishes a preview URL.
5. The build remains reproducible from the project manifest.

## 7. Product surfaces

### Surface 1 — Caliber Web Studio

The initial primary interface.

Default layout:

- Left 34 percent: prompt, plan, code, tasks, agents, and changes.
- Right 66 percent: live editable game viewport.
- Far-right contextual drawer: selected-object inspector.
- Bottom expandable tray: Asset Foundry, console, performance, and playtests.

The viewport remains the visual focus.

### Surface 2 — Engine-native panels

Godot, Unity, and Unreal receive native Caliber panels.

These panels show:

- Prompt and task thread.
- Agent status.
- Changesets.
- Asset Foundry.
- Test results.

The engine's own viewport, hierarchy, inspector, and undo system remain authoritative for direct editing.

### Surface 3 — Caliber Hub

A later cross-project application for:

- Projects.
- Shared style bibles.
- Asset libraries.
- Provider credentials.
- Team status.
- Remote tasks.
- Build and publishing history.

This can use Tauri for local desktop packaging. Electron is not required.

## 8. High-level architecture

Caliber is divided into six layers.

### Layer 1 — Studio clients

- Web Studio.
- Godot plugin.
- Unity extension.
- Unreal plugin.
- Later Tauri Hub.

### Layer 2 — Caliber Core

A Rust service that owns:

- Projects.
- Durable tasks.
- Agent workers.
- Event log.
- Revisions and locks.
- Changesets.
- Asset metadata.
- Provider jobs.
- Playtests.
- Builds.
- Permissions.

### Layer 3 — Agent runtime

OpenCode sessions act as coding and tool-using workers.

Caliber, not OpenCode, owns:

- Scheduling.
- Task state.
- Worker leases.
- Resource scopes.
- Approvals.
- Retries.
- Cost limits.
- Final integration.

### Layer 4 — Engine adapters

Each adapter converts Caliber operations into engine-native transactions.

- Web adapter in TypeScript.
- Godot adapter initially in GDScript.
- Unity adapter in C#.
- Unreal adapter in C++.

### Layer 5 — Asset Foundry

A provider-neutral service for:

- Image generation.
- 3D generation.
- Retexturing.
- Mesh processing.
- Rigging and animation.
- Audio generation later.
- Validation.
- Conversion.
- Provenance.
- Engine import.

### Layer 6 — Artifact and source storage

- Git for code and text project data.
- Git LFS or Perforce for approved large assets, depending on project scale.
- Content-addressed local storage for generated candidates and intermediate files.
- Optional object storage for team and cloud workflows.
- SQLite for local metadata and event state.

## 9. Technology choices

### Language by responsibility

There is no single correct language for the entire product.

| Responsibility | Choice | Reason |
|---|---|---|
| Caliber Core | Rust | Reliability, concurrency, local service performance, controlled memory use |
| Web Studio | TypeScript and React | Product UI, browser APIs, ecosystem, fast iteration |
| Web3D runtime/editor | TypeScript plus selected Three.js or Babylon.js adapter | WebGPU/WebGL, glTF, PBR, custom styles, scene control |
| Godot plugin | GDScript first | Fastest native editor integration |
| Unity plugin | C# | Native Unity editor language |
| Unreal plugin | C++ | Native Unreal editor integration |
| Agent workers | OpenCode sessions | Coding and tool execution |
| Durable local state | SQLite | Simple transactional local-first persistence |
| Live client events | Authenticated WebSocket | Bidirectional low-latency editor events |
| Agent tool calls | MCP | Typed, bounded, inspectable operations |
| Large artifacts | HTTP or file handles | Avoid moving binary data through MCP |
| Desktop packaging | Tauri later | Small shell around the Web Studio and Rust Core |

### Why not Electron

Electron is not required for the first product.

- The Web Studio runs in a normal browser during development.
- A local Rust bridge provides safe filesystem and process access.
- Hosted projects can connect to a hosted Core.
- Tauri can package the Studio later when desktop distribution is useful.

The game canvas itself is Web-based for Web projects. Packaging the editor in Electron or Tauri does not determine game performance; scene budgets, rendering, asset processing, and runtime architecture do.

## 10. Caliber Core responsibilities

Core is the durable source of truth for the production workflow.

### Project service

- Create and open projects.
- Store engine type and adapter version.
- Resolve project paths.
- Track target profiles.
- Track project capabilities.

### Event service

- Append immutable project events.
- Rebuild derived state.
- Stream events to clients.
- Preserve actor, source, time, task, and correlation IDs.

### Task service

- Store task DAGs.
- Track prerequisites.
- Lease work to agents.
- Retry interrupted tasks.
- Pause and resume.
- Store artifacts and evidence.

### Change service

- Create changesets.
- Validate expected revisions.
- Track affected resources.
- Record previews and diffs.
- Apply, reject, or revert.

### Lock service

- Hold short user-edit leases.
- Hold agent resource leases.
- Hold exclusive binary-asset locks.
- Expire abandoned locks.
- Explain waiting and contention.

### Agent service

- Start and stop OpenCode workers.
- Assign roles and scopes.
- Enforce tool permissions.
- Limit concurrency and cost.
- Capture logs and outputs.

### Asset service

- Run provider jobs.
- Download results immediately.
- Track lineage and provider metadata.
- Invoke processors.
- Run quality gates.
- Import approved variants.

### Playtest service

- Launch targets.
- Send input.
- Capture screenshots and state.
- Record logs and performance.
- Produce reproducible reports.

### Build service

- Run development, test, and release builds.
- Publish Web previews.
- Store manifests and artifacts.
- Attach results to changesets.

## 11. Core domain model

Every important object receives a stable Caliber ID.

### Project

- ID.
- Name.
- Engine.
- Web renderer when applicable.
- Adapter version.
- Target profile.
- Style Pack ID and pinned version.
- Project style bible.
- Immersion profile.
- Repository.
- Active branch or workspace.

### Resource

A resource can be:

- Source file.
- Scene.
- Entity or engine object.
- Material.
- Texture.
- Mesh.
- Animation.
- Audio file.
- Build target.
- Design document.

Each resource has:

- Stable ID.
- Engine-native locator.
- Revision.
- Content hash where applicable.
- Owner or active lease.
- Dependency edges.

### Task

- ID.
- Goal.
- Role.
- Dependencies.
- Resource scope.
- Acceptance criteria.
- Status.
- Attempt.
- Worker lease.
- Evidence.
- Changeset.

### Changeset

- ID.
- Task.
- Base revisions.
- Operations.
- Files.
- Generated artifacts.
- Validation result.
- Performance delta.
- Risk level.
- Approval state.

### Asset

- Stable asset ID.
- Category.
- Style tags.
- Source and lineage.
- Provider and model version.
- License record.
- Original artifact.
- Processed variants.
- Quality tier.
- Engine imports.
- Usage references.

### Playtest

- Scenario.
- Build.
- Input script.
- State checkpoints.
- Screenshots.
- Logs.
- Performance samples.
- Result.

## 12. Engine adapter contract

The adapter contract is capability-based.

An adapter reports what it supports rather than pretending every engine behaves identically.

### Required capabilities

- Connect and authenticate.
- Report project status.
- Enumerate scenes and resources.
- Report selection.
- Inspect a selected object.
- Apply a transactional changeset.
- Support undo or compensating reversal.
- Import an approved asset.
- Launch and stop a playtest.
- Capture logs and screenshots.
- Validate the project.
- Build the project.

### Optional capabilities

- Native transform gizmo hooks.
- Material graph editing.
- Runtime state inspection.
- Visual scripting.
- Terrain tools.
- Animation graph tools.
- Network simulation.
- Platform packaging.

### Adapter rules

- Every mutation includes expected resource revisions.
- Every mutation includes an idempotency key.
- Mutations are grouped into engine-native undo transactions.
- Adapters reject unsupported operations explicitly.
- Adapters return structured errors.
- Adapters never silently reinterpret a request.
- Live drag events do not travel through MCP.
- Large assets do not travel through MCP.

### No fake universal scene

Caliber will not attempt to store every engine feature in one common scene format.

Caliber stores:

- Intent.
- Stable identities.
- Semantic roles.
- Relationships.
- Asset references.
- Task history.
- Engine-native locators.

The actual detailed scene remains engine-native.

This prevents the shared model from becoming a lowest-common-denominator engine.

## 13. Web3D implementation

### Renderer-adapter strategy

Caliber defines one Web renderer contract for editor-facing operations:

- Create and destroy a scene.
- Map renderer nodes to stable Caliber IDs.
- Raycast and select.
- Read and apply transforms.
- Read and apply supported material parameters.
- Load approved assets.
- Apply a renderer-specific Style Pack binding.
- Enter Edit, Play, and Review modes.
- Capture frames and performance metrics.
- Serialize and restore the renderer-native scene document.

The contract covers Caliber workflows, not every renderer feature. Renderer-specific capabilities remain available through namespaced extensions.

### Three.js candidate

Three.js is strongest when Caliber needs:

- Highly customized shaders and materials.
- TSL shader authoring across WebGPU and WebGL backends.
- Node-based post-processing.
- Artistic or experimental rendering.
- A minimal rendering layer that Caliber can shape directly.
- Optional WebXR experiences later.

Three.js requires Caliber to assemble more surrounding game systems, including physics integration, gameplay architecture, navigation, animation-state conventions, and production tooling.

### Babylon.js candidate

Babylon.js is strongest when Caliber needs:

- A more integrated game-engine feature set.
- PBR, cameras, animation, particles, audio, and physics integration.
- Direct scene graph control.
- Faster delivery of conventional game mechanics.
- Existing engine tooling and debugging surfaces.

Babylon.js still permits custom materials and rendering, but Caliber must verify that Style Packs can reach the required artistic range without renderer-specific friction.

### Renderer selection rule

The alpha bakeoff scores:

- Visual fidelity.
- Style-Pack expressiveness.
- WebGPU and WebGL fallback reliability.
- Direct-edit API quality.
- glTF and compressed-asset behavior.
- Loading and streaming.
- Frame time and memory.
- Physics and animation integration effort.
- Playtest automation.
- Bundle size.
- Team development speed.

One renderer wins the reference alpha. The renderer choice is stored in the project manifest and cannot be casually changed after renderer-native scenes and shaders are created.

### Web project structure

A Web project contains:

- Engine-owned scene documents with stable Caliber IDs.
- TypeScript gameplay code.
- Asset manifests.
- Input mappings.
- Target profile.
- Style Pack ID and pinned version.
- Renderer-specific style binding.
- Immersion profile.
- Tests.
- Build configuration.

The Web adapter owns the concrete scene schema. It is not reused as the Godot or Unreal scene schema.

### Studio/runtime separation

The editable game runs in a sandboxed frame or worker-controlled preview boundary.

The Studio communicates with it through a typed bridge for:

- Selection.
- Raycast hits.
- Transform edits.
- Inspector reads and writes.
- Scene reload.
- Play mode.
- Metrics.
- Screenshots.

Game code cannot directly access Caliber credentials or host filesystem APIs.

### Edit modes

Edit:

- Selection and gizmos enabled.
- Scene changes persist.
- Game simulation paused or controlled.

Play:

- Game owns input.
- Runtime state changes do not automatically persist.
- Performance telemetry is active.

Review:

- A proposed changeset is overlaid.
- Added, changed, and removed objects are highlighted.
- The user can accept or reject.

### Web publishing

The release pipeline produces:

- Hashed static files.
- Asset manifest.
- Compressed textures and meshes.
- Loading screen.
- Browser compatibility report.
- Source map policy.
- Build metadata.

A preview can be hosted on a static CDN.

## 14. Godot implementation

### Plugin approach

Start with a GDScript editor plugin because it is fast to develop and sufficient for:

- Dock UI.
- Selection events.
- Inspector integration.
- Scene tree inspection.
- UndoRedo transactions.
- Asset imports.
- Playtest and export commands.
- WebSocket communication with Core.

Use GDExtension only where profiling proves native code is required.

### Godot responsibilities

- Preserve the native 2D and 3D editors.
- Use Godot's selected node as the Caliber selection.
- Map node and resource paths to stable Caliber IDs.
- Import approved GLB assets and associated textures.
- Track scene and resource revisions.
- Run engine-native validation and export.

### Godot constraints

- Pin one stable Godot minor version for the first adapter.
- Treat external resource paths carefully.
- Avoid editing the same scene file simultaneously from two workers.
- Prefer isolated scenes and inherited scene composition.
- Test Web exports separately because they use different browser and threading constraints.

## 15. Unity and Unreal strategy

Unity and Unreal are not parallel MVPs.

They begin after the Web and Godot adapter contract is stable.

### Unity

- C# editor package.
- Native selection and Undo APIs.
- Asset Database hooks.
- Scene and prefab-aware resource scopes.
- Play Mode and Test Framework integration.
- Separate worktrees for code changes.
- Exclusive ownership for fragile shared scenes.

### Unreal

- C++ editor plugin.
- Slate-based Caliber panel.
- Native transactions.
- Actor and asset inspection.
- Play In Editor automation.
- Source control and binary asset locks.
- One File Per Actor where useful.
- Separate handling for C++, Blueprint, level, and binary content tasks.

### Adapter expansion gate

An engine adapter is not started until:

- The adapter protocol has passed two implementations.
- Asset imports are provider-neutral.
- Human-agent conflict handling is proven.
- Playtest reports use an engine-neutral evidence schema.
- The team can maintain the existing adapters without slowing the core product.

## 16. Human-agent concurrency

The user must never feel locked out of their own game.

### User priority

When a user starts editing an object:

1. The client requests a short edit lease.
2. The resource revision is rechecked.
3. The user operation begins.
4. Conflicting agent mutations wait.
5. The user transaction completes.
6. The revision increments.
7. Waiting agents receive the new state and decide whether to rebase.

### Resource scopes

Scopes may include:

- File.
- Scene.
- Entity.
- Component.
- Material.
- Asset.
- Gameplay system.
- Build configuration.

An agent receives the smallest practical scope.

### Optimistic concurrency

Safe text and structured operations use expected revisions.

If the revision changed:

- The operation is rejected.
- The agent receives the current resource.
- The task is rebased or escalated.

### Exclusive ownership

Use exclusive leases for:

- Binary assets.
- Fragile shared scenes.
- Engine resources without meaningful merge semantics.
- Final release configuration.

### Visible collaboration

The UI shows:

- Which agent is working.
- What resources it owns.
- What it is waiting on.
- Whether the user is blocking it.
- Whether a changeset needs review.

## 17. Multi-agent orchestration

### Initial roles

Director:

- Turns requests into tasks.
- Defines acceptance criteria.
- Chooses dependencies.
- Does not directly mutate the project.

Code Worker:

- Changes gameplay or tools code.
- Runs narrow tests.
- Works in an isolated Git worktree.

Scene Worker:

- Applies structured scene changes.
- Uses engine adapter tools.
- Cannot modify unrelated code.

Asset Worker:

- Creates briefs.
- Requests candidates.
- Runs Asset Foundry processing.
- Does not approve production assets.

Environment Worker:

- Assembles modular kits.
- Places props.
- Tunes dressing within a scene scope.

Test Worker:

- Runs builds and playtests.
- Collects evidence.
- Is read-only with respect to production resources.

Performance Worker:

- Measures budgets.
- Proposes optimization changes.
- Requires approval for visible quality reductions.

Integrator:

- Reviews changesets.
- Checks revisions and conflicts.
- Runs required tests.
- Applies approved work.

Repair Worker:

- Receives a reproducible failure.
- Implements the smallest fix.
- Re-runs the scenario.

### Initial concurrency limit

Start with:

- One Director.
- One Scene or engine-writing worker.
- Up to two code workers on disjoint systems.
- One Asset worker.
- One read-only Test or Performance worker.
- One Integrator.

More agents do not automatically mean faster work. Concurrency expands only after collision and integration metrics are healthy.

### Durable task states

- Draft.
- Ready.
- Leased.
- Running.
- Waiting.
- Needs review.
- Integrating.
- Completed.
- Failed.
- Cancelled.

### Worker lifecycle

- Core creates a lease.
- Worker heartbeats.
- Lease expires after failure or disconnect.
- Work artifacts remain attached to the task.
- A replacement worker can resume from the last safe checkpoint.

### Changes, not chat transcripts

The durable product record is:

- Task.
- Decisions.
- Resource scope.
- Changeset.
- Evidence.
- Approval.

Chat remains useful context but is not the production source of truth.

## 18. Asset Foundry product

Asset Foundry is a core Caliber product, not a button that forwards prompts to a model provider.

It must make generated and imported content usable in an actual game.

### Asset categories

- Concept images.
- Mood boards.
- Sprites and sprite sheets.
- UI elements and icons.
- Decals.
- Skyboxes and environment maps.
- Materials and tileable textures.
- Static 3D props.
- Modular environment kits.
- Characters and creatures.
- Rigs and animation clips.
- Visual effects source assets.
- Sound effects, music, and voice later.

### Asset quality tiers

Placeholder:

- Fast.
- Cheap.
- Used for layout and mechanic testing.
- Not eligible for release.

Production:

- Passes target-profile geometry, material, texture, naming, collision, and visual gates.
- Approved for normal game use.

Hero:

- Receives explicit art direction.
- May require manual DCC work.
- Uses the highest visual and review bar.

AI output always enters as a candidate. It never becomes Production or Hero solely because a provider marked the job successful.

## 19. Asset generation pipeline

### Stage 1 — Brief

Caliber produces a structured brief:

- Asset purpose.
- Scene and gameplay context.
- Style Pack ID and pinned version.
- Shape language.
- Art style.
- Palette.
- Material definition.
- Scale.
- Camera distance.
- Target platform.
- Triangle and texture budget.
- Rigging or animation needs.
- Negative constraints.
- Reference images.

### Stage 2 — Candidate generation

The provider adapter creates multiple candidates.

For expensive jobs:

- Generate low-cost previews first.
- Select one or two.
- Request high-quality output only for selected candidates.

### Stage 3 — Intake

Core immediately downloads:

- Original model.
- Textures.
- Preview images.
- Provider metadata.
- Task parameters.
- Model version.
- Cost.
- Terms or license snapshot reference.

Provider URLs are not treated as permanent storage.

### Stage 4 — Structural processing

Depending on asset type:

- Format normalization.
- Coordinate and unit normalization.
- Pivot correction.
- Normal and tangent repair.
- UV validation or unwrap.
- Topology cleanup.
- Decimation or remeshing.
- LOD generation.
- Material consolidation.
- Texture channel normalization.
- Texture compression.
- Collision generation.
- Skeleton validation.
- Rigging.
- Animation retargeting.

### Stage 5 — Visual QA

Caliber creates:

- Neutral-light turntable.
- In-style-light turntable.
- Wireframe preview.
- Material-channel preview.
- In-engine thumbnail.
- Side-by-side reference comparison.

Automated vision review can flag problems, but a user or authorized art reviewer approves Production and Hero assets.

### Stage 6 — Technical QA

The asset is checked against its target profile.

Failed checks produce actionable reasons, not a generic failure.

### Stage 7 — Approval

The reviewer can:

- Approve.
- Request another variant.
- Change the brief.
- Send to repair.
- Downgrade to Placeholder.
- Reject and archive.

### Stage 8 — Engine import

The engine adapter:

- Creates native resources.
- Applies import settings.
- Preserves stable Caliber identity.
- Generates engine-specific variants.
- Records the resulting native locators.

### Stage 9 — Runtime monitoring

Caliber records:

- Where the asset is used.
- Draw calls.
- Texture memory.
- Load cost.
- LOD behavior.
- Performance regressions.

An individually valid asset can still fail a scene-level budget.

## 20. Provider strategy

### First provider — Tripo

Tripo is the first 3D generation adapter because its current API surface includes:

- Text-to-model.
- Image-to-model.
- Multiview-to-model.
- Image generation.
- Texturing.
- Mesh segmentation and completion.
- Smart low-poly processing.
- Pre-rig checks and rigging.
- Animation retargeting.
- Format conversion.

Caliber must still benchmark actual quality, latency, price, terms, and failure rate before making Tripo the default for every asset class.

### Second provider — Meshy

Meshy is the first benchmark and fallback provider because its API covers:

- Text and image to 3D.
- Multi-image generation.
- Retexturing.
- Remeshing.
- Rigging and animation.
- Format conversion.

Caliber should compare providers by asset class rather than selecting one global winner.

### Local processing — Blender

Blender command-line processing can provide deterministic local steps such as:

- Format conversion.
- Scene cleanup.
- Decimation.
- Baking.
- Thumbnail and turntable rendering.
- Validation scripts.

Blender is a processor, not the Caliber user interface.

### Existing assets

Caliber must support:

- User uploads.
- Studio-owned asset libraries.
- Purchased marketplace assets.
- Open-license libraries.
- Existing project assets.

Caliber records the source and license; it does not assume that an imported asset may be redistributed.

### Provider adapter interface

Every provider adapter implements:

- Capabilities.
- Submit job.
- Poll or receive completion.
- Cancel where supported.
- Estimate cost.
- Fetch outputs.
- Normalize errors.
- Record model version.
- Record license context.

Provider secrets remain in Core or the operating-system keychain and never enter game code or browser-exposed project files.

### Provider routing

Routing can consider:

- Asset category.
- Art style.
- Quality tier.
- Target budget.
- Provider benchmark score.
- Expected latency.
- Cost ceiling.
- Privacy policy.
- Current availability.

The Asset Worker requests an outcome from Asset Foundry. It does not directly choose arbitrary provider endpoints in production.

## 21. Asset lineage and provenance

Every asset keeps a lineage graph.

### Required metadata

- Stable asset ID.
- Style Pack ID and version used for generation and approval.
- Original brief.
- References.
- Prompts and negative prompts.
- Provider.
- Provider model version.
- Seed where available.
- Input artifact hashes.
- Output artifact hashes.
- Generation time.
- Cost.
- Processing steps.
- Tool and processor versions.
- Human edits.
- License and source.
- Approval identity and time.
- Imported engine variants.

### Why provenance matters

- Reproduce or improve an asset.
- Replace a provider.
- Audit commercial rights.
- Explain why two variants differ.
- Avoid losing source files.
- Identify assets affected by a bad model or processor version.
- Preserve attribution requirements.

### Source-control policy

- Candidate generations live in the content-addressed artifact store.
- Only approved source and engine-ready assets enter project source control.
- Generated caches do not enter Git.
- Large approved files use Git LFS or the project's binary-asset system.

## 22. Asset quality gates

### Geometry

- Valid file parse.
- Non-empty mesh.
- No unexpected disconnected fragments.
- Correct orientation.
- Correct physical scale.
- Useful pivot.
- Valid normals and tangents.
- No degenerate triangles beyond tolerance.
- Manifold requirements where relevant.
- Triangle count within profile.
- LODs present when required.
- Collision appropriate to gameplay.

### UV and textures

- UV set exists where required.
- Overlap allowed only when intentional.
- Texel density within style guidance.
- No severe seams.
- Correct color-space assignment.
- Required PBR channels present.
- Texture dimensions and formats valid.
- Texture memory within profile.
- No embedded provider watermarks.

### Materials

- Material count within budget.
- PBR values in plausible ranges.
- No unsupported shader features for the target.
- Transparent materials explicitly justified.
- Web fallback tested.

### Rigging and animation

- Skeleton hierarchy valid.
- Bone count within profile.
- Skin weights normalized.
- Deformation turntable passes.
- Root motion policy correct.
- Animation clips named and bounded.
- Retarget pose documented.

### Visual consistency

- Matches the pinned Style Pack and project style bible.
- Matches palette and material language.
- Appropriate silhouette.
- Appropriate detail density.
- Looks correct at gameplay camera distance.
- Does not visually duplicate a protected or imported reference too closely.

### Engine validation

- Imports without errors.
- Renders correctly.
- Survives save and reload.
- Preserves materials.
- Preserves animation where applicable.
- Does not produce new console errors.

## 23. Style, immersion, and environment quality system

Good environments are built as systems, not generated as one enormous mesh.

### Style Pack definition

A Style Pack is a versioned production contract shared by humans, agents, Asset Foundry, the renderer, and validation.

It contains:

- Style name, ID, version, and authorship.
- Visual references and permitted reference usage.
- Shape language.
- Color palette and contrast hierarchy.
- Surface and material language.
- Edge, bevel, damage, and wear rules.
- Detail and texel-density rules.
- Asset-generation prompt templates.
- Negative generation constraints.
- Approved material archetypes.
- Lighting and atmosphere presets.
- Shader and post-processing definitions.
- Camera and motion rules.
- Animation timing and exaggeration rules.
- Particle and effect language.
- Audio palette and mix guidance.
- UI treatment.
- Target profiles and style-specific performance limits.
- Automated and human review criteria.
- Renderer and engine compatibility.

Projects pin a Style Pack version. Updating a pack creates a reviewable migration rather than silently changing every asset or scene.

### Renderer bindings

The semantic Style Pack remains renderer-neutral, but executable rendering details are adapter-specific.

A Three.js binding can contain:

- TSL and node-material definitions.
- WebGPURenderer post-processing nodes.
- Lighting-rig construction.
- Fog, sky, tone mapping, and color settings.
- Renderer feature and fallback rules.

A Babylon.js binding can contain:

- PBR and node-material definitions.
- Post-process pipeline settings.
- Lighting-rig construction.
- Fog, sky, tone mapping, and color settings.
- Engine feature and fallback rules.

Godot, Unity, and Unreal later receive their own bindings. A Style Pack is considered supported on an engine only after its binding passes reference-scene visual and performance checks.

### Initial Style Packs

The alpha should ship one deeply polished pack, not ten shallow presets.

Recommended first pack:

Stylized Atmospheric Adventure:

- Strong readable silhouettes.
- Hand-authored-looking surfaces.
- Controlled PBR response.
- Warm and cool lighting contrast.
- Volumetric-feeling fog implemented within the Web budget.
- Expressive particles.
- Smooth third-person camera.
- Environmental spatial audio.

Two packs follow after the pipeline is proven:

Cinematic Science Fiction:

- Metallic and composite surfaces.
- Emissive accents.
- Restrained bloom.
- Dense atmosphere.
- Strong diegetic interface cues.

Painterly Dreamscape:

- Simplified geometry.
- Painterly textures.
- Custom edge and color treatment.
- Stylized depth and atmosphere.
- More experimental Three.js shader treatment where appropriate.

Anime, retro PS1, voxel, photoreal, horror, noir, and user-authored packs remain later extensions.

### Style creation workflow

1. Define references and exclusions.
2. Produce the semantic Style Pack.
3. Build a small reference scene.
4. Implement one renderer binding.
5. Generate representative prop, architecture, character, effect, and UI candidates.
6. Tune lighting, camera, animation, and audio together.
7. Validate the scene on the target profile.
8. Lock version 1 of the pack.
9. Require every later asset to declare compatibility.

### Immersion profile

Immersion is broader than graphical fidelity.

Every project defines:

- Camera perspective and movement language.
- Input acceleration, smoothing, and dead-zone rules.
- Character responsiveness.
- Interaction distance and feedback.
- Animation transition quality.
- Environmental reactivity.
- Spatial audio behavior.
- Music transition behavior.
- Weather and atmosphere behavior.
- Haptic feedback where available.
- Loading and transition strategy.
- Diegetic versus screen-space UI.
- Accessibility constraints.

### Immersion quality gates

- Input feels responsive at the target frame rate.
- Camera motion is stable and comfortable.
- Important actions have visual, audio, and animation feedback.
- Environmental loops do not visibly repeat too often.
- Zone transitions avoid disruptive loading.
- Spatial audio matches visible sources and spaces.
- Effects reinforce gameplay instead of obscuring it.
- UI treatment matches the world and remains readable.
- Low-quality rendering preserves gameplay clarity and style identity.

WebXR can become a renderer capability later. The first meaning of immersive is a convincing, responsive screen-based game; it does not require a headset.

### Environment decomposition

- Terrain or structural base.
- Modular architecture kit.
- Large composition shapes.
- Hero landmarks.
- Medium props.
- Small dressing props.
- Surface materials and decals.
- Foliage.
- Lighting.
- Atmosphere and fog.
- Effects.
- Audio zones.
- Navigation and collision.

### Project style bible

The project style bible is the human-readable view of its pinned Style Pack plus project-specific decisions:

- Visual references.
- Shape language.
- Palette.
- Material response.
- Edge and bevel language.
- Damage and wear rules.
- Detail density.
- Texel density.
- Lighting direction.
- Contrast hierarchy.
- Camera and post-processing rules.

Asset prompts inherit the Style Pack and project style bible. Individual workers cannot invent unrelated art directions. Deviations require an explicit style proposal and review.

### Modular kit workflow

1. Graybox the space.
2. Identify repeatable modules.
3. Generate or model kit candidates.
4. Validate snapping dimensions and pivots.
5. Approve the kit.
6. Assemble the major forms.
7. Add hero assets.
8. Dress with controlled variation.
9. Add lighting and atmosphere.
10. Run performance and navigation tests.

### Environment review

Review at:

- Establishing camera.
- Gameplay camera.
- Close interaction distance.
- Worst-case performance camera.
- Low-quality fallback.

## 24. Performance and smoothness

Smoothness is a release criterion, not a final optimization pass.

### Target profiles

Each project chooses an explicit profile.

Initial profile:

Web Desktop High:

- Modern desktop browser.
- WebGPU preferred.
- WebGL 2 fallback.
- 1080p reference viewport.
- 60 frames per second target.
- Stable frame pacing.
- Progressive loading.

Later profiles:

- Web Laptop Balanced.
- Web Mobile.
- Godot Desktop.
- Unity Desktop or Mobile.
- Unreal Desktop or Console.

### Per-scene budgets

The profile defines:

- Triangle budget.
- Visible object budget.
- Draw-call budget.
- Material and shader budget.
- Texture memory budget.
- Animation budget.
- Physics-body budget.
- Particle budget.
- Audio-voice budget.
- Initial download budget.
- Time-to-interactive budget.

Exact numbers are calibrated against the reference hardware and vertical slice during Phase 1. Caliber should not hard-code invented universal limits.

### Web optimization pipeline

- GLB and glTF as runtime interchange.
- Mesh compression where supported.
- KTX2 or Basis texture compression.
- Mipmaps.
- LODs.
- Instancing for repeated props.
- Frustum and occlusion strategies.
- Light baking where appropriate.
- Shader variant control.
- Lazy scene and asset loading.
- Audio compression and streaming.
- Bundle splitting.

### Continuous performance checks

Every integrated changeset can report:

- Average frame rate.
- Low-percentile frame time.
- CPU and GPU frame estimates where available.
- Draw calls.
- Visible triangles.
- Texture memory estimate.
- JavaScript heap.
- Initial bytes.
- Time to first playable frame.
- Input latency indicators.

Visible quality reductions require user review.

## 25. Project understanding and memory

Caliber maintains several forms of memory.

### Design memory

- Game pillars.
- Mechanics.
- Controls.
- Player fantasy.
- Art direction.
- Scope limits.

### Technical memory

- Architecture decisions.
- Engine and adapter versions.
- Important systems.
- Build commands.
- Test commands.
- Performance profile.

### Scene memory

- Important entities.
- Semantic roles.
- Spatial regions.
- Dependencies.
- Gameplay references.

### Asset memory

- Style.
- Lineage.
- Quality tier.
- Usage.
- License.
- Performance cost.

### Decision memory

- Accepted proposals.
- Rejected approaches.
- Reasons.
- Owner.
- Date.

Memory is structured and reviewable. Agents do not rely only on old chat history.

## 26. MCP and live protocol

### Protocol split

Use authenticated WebSocket for:

- Selection changes.
- Transform drag lifecycle.
- Inspector updates.
- Agent and task status.
- Play mode events.
- Logs and performance samples.

Use MCP for bounded agent tools.

Use files or HTTP artifact handles for:

- Models.
- Textures.
- Screenshots.
- Videos.
- Builds.
- Large logs.

### Initial project tools

- project.status
- project.capabilities
- project.search
- resource.inspect
- resource.dependencies

### Initial scene tools

- scene.list
- scene.inspect
- scene.selection
- scene.apply_changeset
- scene.validate
- scene.save

### Initial asset tools

- asset.search
- asset.inspect
- asset.generate_candidates
- asset.get_job
- asset.process
- asset.validate
- asset.approve
- asset.import
- asset.replace_reference

### Initial playtest tools

- playtest.start
- playtest.send_input
- playtest.capture
- playtest.read_state
- playtest.stop
- playtest.report

### Initial build tools

- build.development
- build.release
- build.report
- publish.preview

### Safety rules

- All mutation tools require an approved task scope.
- High-risk changes can require explicit human approval.
- Asset generation has per-task and per-project cost ceilings.
- Idempotency prevents duplicate provider jobs and duplicate mutations.
- Tool output is structured and size bounded.

## 27. Persistence and storage

### SQLite

Stores:

- Projects.
- Events.
- Tasks.
- Leases.
- Revisions.
- Locks.
- Changesets.
- Agent runs.
- Asset metadata.
- Provider jobs.
- Playtests.
- Build records.

### Event log

Important state changes append events before derived state updates.

This enables:

- Crash recovery.
- Audit history.
- Task resumption.
- UI event streaming.
- Debugging.

### Artifact store

Artifacts are content-addressed by hash.

It supports:

- Deduplication.
- Immutable originals.
- Processor caching.
- Lineage.
- Local storage first.
- Optional remote object storage.

### Source control

Code workers use Git worktrees.

Scene and asset policy varies by engine:

- Web and Godot favor text-based isolated files.
- Unity requires scene and prefab-aware coordination.
- Unreal binary assets require explicit locks.

Caliber does not attempt blind automatic merging of binary assets.

## 28. Security, privacy, licensing, and cost

### Local trust boundary

- Core binds to loopback by default.
- Clients authenticate with short-lived tokens.
- Provider keys remain in the operating-system keychain.
- Game previews run in a sandbox.
- Agent shell access is restricted by project scope.

### Generated file safety

- Validate MIME type and file signature.
- Enforce size limits.
- Parse in isolated worker processes where practical.
- Reject path traversal.
- Do not execute scripts embedded in imported asset packages.

### Licensing

Every imported or generated asset records:

- Source.
- Account or plan context.
- Terms version or reference.
- Commercial-use status claimed by the provider.
- Attribution requirements.
- Redistribution restrictions.
- Human review state.

Provider terms can change. Caliber records provenance but does not replace legal review.

### Cost controls

- Estimate before generation.
- Show candidate and final costs separately.
- Set daily and project ceilings.
- Require approval above threshold.
- Cache identical requests.
- Cancel abandoned jobs where supported.
- Report cost per approved asset.

### Privacy

Projects can mark content as:

- Local only.
- External provider allowed.
- Specific providers allowed.
- Team cloud allowed.

Workers cannot upload protected project assets without policy permission.

## 29. UI specification

### Left workspace

Tabs:

- Create.
- Code.
- Tasks.
- Agents.
- Changes.

Create contains the main conversation and structured project plan.

It also contains:

- Renderer selection for Web projects.
- Style Pack selection and version.
- Target profile.
- Immersion profile.
- Reference game brief.

Code contains:

- File tree.
- Editor.
- Diff.
- Diagnostics.
- Agent ownership indicators.

Tasks contains the dependency graph and acceptance criteria.

Agents contains active, waiting, failed, and completed workers.

Changes contains reviewable human and agent changesets.

### Right viewport

The viewport supports:

- Click selection.
- Box selection later.
- Transform gizmos.
- Duplicate and delete.
- Drag asset from Asset Foundry.
- Focus selection.
- Edit, Play, and Review modes.
- Performance overlay.
- Agent-change highlights.

### Inspector

The selected object shows:

- Name and stable ID.
- Transform.
- Components.
- Mesh.
- Materials and textures.
- Collision.
- Scripts.
- Tags and semantic role.
- Source asset and lineage.
- Revision and active owner.

### Asset Foundry tray

Views:

- Brief.
- Candidate grid.
- Compare.
- Processing.
- Validation.
- Library.
- Usage.

Candidate cards show:

- Turntable.
- Provider.
- Cost.
- Status.
- Geometry summary.
- Texture summary.
- Style score.
- Technical gate result.

### Status language

Use clear production states:

- Generating.
- Processing.
- Needs review.
- Blocked by your edit.
- Failed validation.
- Ready to import.
- Performance regression.

Do not hide failures behind conversational prose.

## 30. Repository plan

The recommended monorepo shape is:

    apps/
      studio-web/
      caliber-core/
      local-bridge/
    packages/
      protocol/
      adapter-sdk/
      web-renderer-contract/
      web-renderer-three/
      web-renderer-babylon/
      web-editor/
      web-runtime-sdk/
      style-system/
      immersion-system/
      asset-foundry-client/
      ui/
    adapters/
      godot/
      unity/
      unreal/
    crates/
      core-domain/
      event-store/
      task-engine/
      agent-runtime/
      asset-foundry/
      artifact-store/
      playtest/
      build-service/
    processors/
      blender/
      gltf/
      textures/
      validation/
    templates/
      web-3d-starter/
      web-2d-starter/
      godot-starter/
    schemas/
      events/
      tools/
      assets/
      playtests/
    tests/
      protocol/
      golden-projects/
      adapter-contract/
      performance/
    docs/
      adr/
      product/
      protocols/
      runbooks/

### Repository principles

- One monorepo initially.
- Protocol schemas versioned independently.
- Engine adapters depend on protocol contracts, not Core internals.
- Generated provider clients are isolated.
- Golden projects are small and deterministic.
- Large generated candidates stay outside Git.

## 31. Testing and verification

### Core

- Domain unit tests.
- Event replay tests.
- Lease expiry tests.
- Crash recovery tests.
- Idempotency tests.
- Permission tests.

### Adapter contract

Every adapter must pass:

- Connect.
- Capability negotiation.
- Selection.
- Inspection.
- Transaction.
- Revision conflict.
- Undo.
- Save and reopen.
- Asset import.
- Playtest.
- Validation.
- Build.

### Web Studio

- Component tests.
- Browser interaction tests.
- Selection and gizmo tests.
- Hot-reload tests.
- Preview sandbox security tests.

### Asset Foundry

- Provider response contract tests.
- Job retry tests.
- Output download tests.
- Hash and lineage tests.
- Geometry validation fixtures.
- Texture validation fixtures.
- Processor determinism tests.
- License metadata tests.
- Cost-limit tests.

### Playtesting

- Deterministic input scenarios where possible.
- Screenshot checkpoints.
- State assertions.
- Console error assertions.
- Performance thresholds.

### Golden project

Maintain one small Web3D project containing:

- Static props.
- Character.
- Animation.
- Physics.
- Materials.
- UI.
- Audio.
- Loading.
- One generated asset.
- One pinned Style Pack and reference render.
- Camera, environmental audio, and interaction feedback.

Every change to Core, protocol, editor, or asset processing runs against it.

## 32. Delivery roadmap

The roadmap is sequential by product risk, not by excitement.

### Phase 0 — Architecture and quality spikes

Duration: 2 weeks.

Deliver:

- Repository initialized.
- Architecture decisions recorded.
- Three.js versus Babylon.js reference test using the same GLB scene and semantic Style Pack.
- Web renderer contract drafted.
- Rust Core can stream an event to the browser.
- Web viewport selection and transactional transform.
- Tripo test job downloaded and rendered.
- GLB intake report.
- Initial target profile.
- Stylized Atmospheric Adventure Style Pack version 0.
- Initial immersion profile.

Exit gate:

- The reference renderer is selected from recorded evidence, and one generated object is selected, edited, undone, saved, reloaded, and rendered smoothly with the reference Style Pack in the Web Studio.

### Phase 1 — Web editor foundation

Duration: 4 weeks.

Deliver:

- Project creation.
- Selected renderer adapter.
- Web scene schema.
- Hierarchy.
- Viewport.
- Transform gizmos.
- Inspector.
- Undo and history.
- Edit and Play modes.
- Hot reload.
- Style Pack loading and pinned versions.
- Renderer-specific style binding.
- Initial camera and feedback profile.
- Local build.
- Core persistence.

Exit gate:

- A user can build a small scene without using source code for basic placement and material operations.

### Phase 2 — Safe AI and multi-agent loop

Duration: 4 weeks.

Deliver:

- OpenCode worker lifecycle.
- Director and Code Worker.
- Scene Worker.
- Task DAG.
- Leases and heartbeats.
- Resource revisions.
- User-priority locks.
- Changeset review.
- Initial MCP tools.
- Crash recovery.

Exit gate:

- Two disjoint agents and the user work concurrently without lost edits.

### Phase 3 — Asset Foundry alpha

Duration: 5 weeks.

Deliver:

- Style-aware asset brief.
- Tripo adapter.
- Meshy benchmark adapter.
- Candidate comparison.
- Artifact store.
- Lineage.
- Blender processor.
- GLB validation.
- Texture processing.
- Target profiles.
- Approval and import.
- Asset replacement.

Exit gate:

- A generated prop passes the Production gate and replaces a placeholder while preserving scene references.

### Phase 4 — Immersion, playtest, performance, and publishing

Duration: 5 weeks.

Deliver:

- Instrumented play mode.
- Input automation.
- Screenshot and state capture.
- Performance dashboard.
- Camera, input, animation-transition, feedback, and environmental-audio checks.
- Streaming-zone transitions.
- Style-reference visual captures.
- Release build.
- CDN preview.
- Reference vertical slice.
- Alpha onboarding and recovery.

Exit gate:

- A new user creates, edits, tests, and publishes the reference scope without engineering assistance.

### Phase 5 — Godot adapter

Duration: 6 to 8 weeks.

Deliver:

- Godot editor plugin.
- Adapter contract.
- Selection and inspection.
- Transaction and undo.
- GLB import.
- Scene changesets.
- Playtest.
- Validation.
- Desktop and Web export.

Exit gate:

- The same Caliber task, asset, and review concepts work in a native Godot project.

### Phase 6 — Unity adapter

Duration: 8 to 10 weeks after the adapter gate.

### Phase 7 — Unreal adapter

Duration: 10 to 14 weeks after the adapter gate.

### Schedule reality

For a focused team of three to four experienced engineers, the Web private alpha is approximately 18 to 22 calendar weeks.

For one experienced full-time engineer, expect approximately 30 to 44 focused weeks because Web editing, agent orchestration, asset processing, renderer integration, immersion, and product polish are separate systems.

Godot, Unity, and Unreal should not be counted inside the Web alpha schedule.

## 33. First 30 working days

### Days 1–5

- Initialize Git and the monorepo.
- Choose package and Rust workspace conventions.
- Record architecture decisions.
- Define protocol envelope and IDs.
- Draft the Web renderer contract.
- Build Three.js and Babylon.js comparison scenes.
- Define reference hardware and Web target profile.
- Draft the Stylized Atmospheric Adventure Style Pack.
- Draft the reference immersion profile.

Success:

- The same GLB scene and semantic Style Pack render in both candidates with captured visual, performance, loading, and editing results.

### Days 6–10

- Choose the Web engine.
- Pin the winning renderer in the project manifest.
- Implement its Style Pack binding.
- Implement selection.
- Implement transform gizmos.
- Implement inspector read and write.
- Implement transaction and undo.
- Persist and reload the scene.

Success:

- User edits survive refresh and undo behaves correctly.

### Days 11–15

- Implement Rust Core skeleton.
- Add SQLite migrations.
- Add event append and replay.
- Add authenticated WebSocket.
- Add resource revisions.
- Add idempotent scene mutation.

Success:

- Core restarts without losing scene history or duplicating a mutation.

### Days 16–20

- Start one OpenCode worker.
- Add Director task creation.
- Add one bounded scene MCP tool.
- Add one bounded code task.
- Add worktree management.
- Add changeset review.

Success:

- An agent edits an unowned object while the user edits another.

### Days 21–25

- Add Asset Foundry job schema.
- Include the pinned Style Pack and asset target profile in every generation brief.
- Add provider secret storage.
- Submit one Tripo image-to-model job.
- Download outputs.
- Store lineage.
- Render a turntable.
- Produce a first geometry and texture report.

Success:

- A provider result is visible in Candidate Compare and cannot enter the scene until approved.

### Days 26–30

- Normalize the selected GLB.
- Fix scale and pivot.
- Create collision.
- Enforce a simple triangle and texture budget.
- Import into the scene.
- Replace a placeholder.
- Measure the updated scene.
- Publish a local release build.

Success:

- Prompt to approved, editable, budget-checked in-game asset works end to end.

## 34. Initial prioritized backlog

### P0 — Must prove

- Browser-based Web3D Studio.
- Three.js versus Babylon.js renderer decision.
- Versioned Style Pack.
- One production renderer binding.
- Object selection.
- Transform and material editing.
- Undo.
- Rust Core persistence.
- Task DAG.
- One OpenCode worker.
- Revision conflicts.
- User-priority edit lease.
- Changeset review.
- Tripo candidate generation.
- GLB intake and validation.
- Asset approval and import.
- Performance overlay.
- Camera, interaction, and environmental-audio immersion baseline.
- Local release build.

### P1 — Private alpha

- Two disjoint workers.
- Asset lineage.
- Blender processing.
- Texture compression.
- LOD generation.
- Playtest automation.
- Preview hosting.
- Project style bible.
- Style Pack editor and migration review.
- Visual reference-scene regression captures.
- Modular environment workflow.
- Crash recovery UI.
- Cost controls.

### P2 — After usage evidence

- Meshy production routing.
- Second Web3D renderer adapter.
- Additional Style Packs.
- Team collaboration.
- Cloud Core.
- Tauri Hub.
- Web2D template.
- Godot adapter.
- Audio generation.
- Character animation workflow.
- Shared asset library.

### P3 — Later

- Unity adapter.
- Unreal adapter.
- Photoreal quality profile.
- Remote GPU workers.
- Marketplace integrations.
- Procedural terrain pipeline.
- Console build orchestration.

## 35. Team plan

### Minimum serious Web alpha team

- Product and AI systems lead.
- Senior Web3D and graphics engineer.
- Rust and infrastructure engineer.
- Technical artist or tools artist, at least part time.

### Godot phase

Add or contract:

- Godot tools engineer.

### Unity phase

Add:

- Unity editor-tools engineer.

### Unreal phase

Add:

- Unreal C++ editor-tools engineer.

### Why technical art is early

The asset pipeline cannot be judged only by API success or triangle counts. A technical artist defines style, material, topology, LOD, rigging, and performance standards and distinguishes a visually acceptable asset from a merely valid file.

## 36. Product and engineering metrics

### Creation

- Time to first playable scene.
- Prompt-to-visible-change latency.
- Time from asset brief to approved in-game asset.
- Percentage of actions completed without leaving Caliber.

### Assets

- Candidate-to-approval rate.
- Repair rate.
- Average variants per approved asset.
- Cost per approved asset.
- Percentage of approved assets passing engine import first time.
- Style consistency review score.

### Agents

- Task completion rate.
- Human correction rate.
- Conflict rate.
- Rebase rate.
- Mean blocked time.
- Duplicate-operation count.

### Reliability

- Crash-free sessions.
- Recovery success.
- Lost-edit count.
- Build success.
- Adapter contract pass rate.

### Game quality

- Frame-time budget pass rate.
- Time to interactive.
- Scene budget violations.
- New runtime errors.
- Playtest scenario pass rate.
- Style-reference visual regression rate.
- Camera and input comfort failures.
- Missing interaction-feedback count.
- Audio-zone validation pass rate.

### North-star metric

Weekly number of user-approved, playtested, performance-passing game improvements.

This measures completed production work rather than prompts sent or tokens consumed.

## 37. Alpha validation scenarios

### Scenario A — Direct editing

- Select an object.
- Move it.
- Change a texture.
- Undo both changes.
- Redo.
- Save.
- Reload.
- Verify stable identity and revision.

### Scenario B — User versus agent

- Agent proposes an edit to an object.
- User begins editing first.
- Agent waits.
- User commits.
- Agent re-reads and rebases.
- No edit is lost.

### Scenario C — Multi-agent

- Code Worker changes player movement.
- Asset Worker generates a prop.
- Scene Worker places existing lighting.
- Test Worker observes.
- All changes integrate with explicit scopes.

### Scenario D — Asset generation

- Create a style-aware brief.
- Generate multiple candidates.
- Reject one.
- Process one.
- Fail an over-budget result.
- Repair it.
- Approve it.
- Import it.

### Scenario E — Asset replacement

- Place a placeholder.
- Attach gameplay interaction.
- Replace its visual asset.
- Preserve transform, identity, and behavior.

### Scenario F — Performance

- Add enough content to violate a budget.
- Show the regression.
- Identify the largest contributors.
- Apply an approved optimization.
- Verify the target again.

### Scenario G — Recovery

- Stop Core during a provider job.
- Restart.
- Resume or reconcile the job.
- Do not charge for a duplicate request.
- Preserve task and artifact history.

### Scenario H — Publish

- Build release.
- Load in a clean browser profile.
- Play the full loop.
- Record performance.
- Publish preview.
- Reproduce build from manifest.

### Scenario I — Style and immersion

- Load the pinned Style Pack and renderer binding.
- Compare the reference scene against approved captures.
- Verify camera and input behavior.
- Verify interaction feedback.
- Verify environmental and spatial audio.
- Verify a streamed zone transition.
- Run the low-quality fallback.
- Preserve visual identity, comfort, readability, and performance.

## 38. Definition of done

### Web technical alpha

- The Studio runs in a supported desktop browser.
- One renderer is selected from the Three.js and Babylon.js bakeoff and isolated behind the Web renderer contract.
- The right viewport is directly editable.
- Selection, transforms, materials, undo, save, and reload work.
- At least two agents can work on disjoint tasks.
- Human edits take priority.
- Core survives restart.
- Changesets are reviewable and reversible.
- One provider-generated 3D asset passes the full pipeline.
- Approved assets preserve lineage.
- One versioned Style Pack drives assets, renderer settings, camera, effects, and audio guidance.
- The reference scene passes visual regression against the Style Pack.
- The complete reference game passes its immersion profile checks.
- The reference game meets its performance profile.
- Automated playtests capture evidence.
- A release build can be published to a preview URL.

### Asset Foundry alpha

- Provider jobs are asynchronous and resumable.
- Secrets are protected.
- Costs are estimated and limited.
- Originals are immutable.
- Candidate comparison works.
- Geometry, materials, textures, collision, and engine import are validated.
- Production approval is explicit.
- Replacement preserves scene references.
- Provider or processor failure is actionable.

### Godot adapter alpha

- Native plugin connects to Core.
- Selection and inspection work.
- Changes use native undo.
- Revision conflicts are safe.
- Approved GLB assets import.
- Playtest and validation reports use the shared schema.
- A small project builds successfully.

## 39. Major risks and mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| Supporting four engines too early | No engine feels reliable | Ship Web, then Godot, then expand |
| Shipping two Web renderers before the product loop works | Double maintenance delays the alpha | Bake off both, ship one reference renderer, add the second after alpha |
| Universal scene abstraction | Engine features are lost | Store semantic graph plus engine-native scenes |
| Generated assets look inconsistent | Game feels like random AI output | Pinned Style Pack, references, variant review, technical artist |
| Styles become superficial prompt presets | Games still feel visually incoherent | Versioned Style Packs spanning rendering, assets, camera, animation, audio, and validation |
| Visual effects harm comfort or clarity | Immersion decreases | Immersion profile, camera and input tests, restrained post-processing |
| Provider output is technically poor | Bad performance and deformation | Processing and quality gates before import |
| Single-provider dependency | Outage, price, or quality risk | Provider adapter interface and benchmarks |
| Web project is visually good but slow | Product misses its promise | Performance profile and continuous scene budgets |
| Agent edits overwrite the user | Loss of trust | User-priority leases, revisions, transactions, undo |
| Too many agents create integration overhead | Work becomes slower | Conservative concurrency and scoped ownership |
| Asset licensing is unclear | Commercial risk | Provenance, terms reference, review, no silent redistribution |
| Candidate storage explodes | High local and cloud cost | Content hashes, retention policy, approved-only source control |
| Photoreal expectations arrive too early | Unbounded art workload | Start stylized or semi-stylized and define quality tiers |
| Browser security is weak | Credential or filesystem exposure | Sandboxed preview and local Core trust boundary |

## 40. Decision gates

### Gate 1 — Three.js or Babylon.js

Choose based on:

- Visual result.
- Style Pack expressiveness.
- Shader and post-processing flexibility.
- WebGPU and fallback reliability.
- Loading.
- Editing API quality.
- Physics, animation, camera, audio, and gameplay integration effort.
- Profiling.
- Bundle and memory cost.
- Licensing.
- Team productivity.

Deadline: End of working day 10.

### Gate 2 — First 3D provider

Benchmark Tripo and Meshy on the same:

- Prop.
- Modular environment piece.
- Stylized character.
- Material request.

Score:

- Brief adherence.
- Geometry.
- Texture quality.
- Style consistency.
- Processing burden.
- Latency.
- Cost.
- Terms.

Deadline: Before Asset Foundry is called production-ready.

### Gate 3 — Godot start

Begin only when Web alpha proves:

- Safe concurrency.
- Provider-neutral assets.
- Adapter contract.
- Playtest evidence.
- Stable Core.

### Gate 4 — Unity and Unreal

Begin only with:

- User demand.
- Maintenance capacity.
- A proven native-adapter pattern.
- An engine-specific engineer.

## 41. Immediate next action

Build one thin vertical proof before scaffolding the whole repository:

1. Load the same attractive GLB environment in Three.js WebGPURenderer and Babylon.js WebGPU.
2. Apply the same semantic Style Pack through two small renderer bindings.
3. Capture visual output, loading, frame time, memory, bundle cost, and implementation effort.
4. Select the reference renderer and record the decision.
5. Click a prop and read its stable ID.
6. Move it with a gizmo and commit an undoable transaction.
7. Start one background OpenCode worker.
8. Have it change a different object through one bounded Caliber MCP tool.
9. Submit one style-aware Tripo image-to-model prop request.
10. Download and display the candidate in Asset Foundry.
11. Report triangle count, materials, textures, scale, estimated memory, and style compatibility.
12. Approve and import it.
13. Add camera feel, interaction feedback, atmosphere, and environmental audio from the immersion profile.
14. Run visual, immersion, and performance captures before and after.
15. Restart Core and prove there are no duplicate edits or provider jobs.

This proof tests the actual product:

- Direct editing.
- Agent work.
- Asset creation.
- Quality control.
- Style consistency.
- Immersion.
- Performance.
- Durability.

## 42. Official source decisions

### Web engine and formats

- Three.js WebGPURenderer: https://threejs.org/manual/en/webgpurenderer.html
- Three.js post-processing: https://threejs.org/manual/en/post-processing.html
- Three.js WebXR: https://threejs.org/manual/en/webxr-basics.html
- Three.js glTF loader: https://threejs.org/docs/#examples/en/loaders/GLTFLoader
- Babylon.js WebGPU: https://doc.babylonjs.com/setup/support/webGPU/
- Babylon.js glTF import: https://doc.babylonjs.com/features/featuresDeepDive/importers/glTF/
- Babylon.js PBR: https://doc.babylonjs.com/features/featuresDeepDive/materials/using/introToPBR/
- Khronos glTF: https://www.khronos.org/gltf/

### Godot

- Editor plugins: https://docs.godotengine.org/en/stable/tutorials/plugins/editor/index.html
- Import plugins: https://docs.godotengine.org/en/stable/tutorials/plugins/editor/import_plugins.html
- 3D gizmo plugins: https://docs.godotengine.org/en/stable/tutorials/plugins/editor/3d_gizmos.html
- 3D formats: https://docs.godotengine.org/en/stable/tutorials/assets_pipeline/importing_3d_scenes/available_formats.html
- Web exports: https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html
- Command line: https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html

### Asset providers

- Tripo OpenAPI introduction: https://docs.tripo3d.ai/get-started/introduction.html
- Tripo model generation: https://docs.tripo3d.ai/model-generation/text-to-model-v3-0-v3-1.html
- Tripo smart low poly: https://docs.tripo3d.ai/mesh-editing/smart-low-poly-p-v2-0-20251225.html
- Tripo rigging: https://docs.tripo3d.ai/animation/rig-v2-5-20260210.html
- Tripo terms: https://www.tripo3d.ai/terms
- Meshy API: https://docs.meshy.ai/en/api

### Agent and tool protocol

- OpenCode MCP servers: https://opencode.ai/docs/mcp-servers/
- OpenCode SDK: https://opencode.ai/docs/sdk/
- OpenCode server: https://opencode.ai/docs/server/
- MCP transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

## 43. Final product statement

Caliber is not a Web engine, Godot fork, Unity replacement, Unreal replacement, or asset-generation wrapper.

Caliber is the production system that connects:

- Human creative direction.
- Direct visual editing.
- Asynchronous agents.
- Engine-native execution.
- High-quality asset creation.
- Versioned visual styles and renderer bindings.
- Camera, animation, audio, atmosphere, and interaction immersion.
- Technical art processing.
- Performance control.
- Playtesting.
- Review and shipping.

Web proves the complete loop first. Godot proves that the loop transfers to a native open engine. Unity and Unreal then extend the same production system to larger professional workflows.

The lasting moat is not access to a model provider or a renderer. It is the accumulated project understanding, asset lineage, Style Packs, immersion profiles, quality system, engine adapters, safety model, and evidence-driven production loop.
