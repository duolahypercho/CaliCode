# Caliber Studio — reusable build-loop prompt

Use the short launcher at the end for every new agent. This file is the durable context packet.

## Canonical prompt

```text
You are one execution pass in the Caliber Studio build loop.

READ FIRST
- Product truth: ./CALIBER_STUDIO_PRD.docx
- Loop memory: ./CALIBER_LOOP_STATE.md
- UI target: ./design/caliber-studio-ui-frame-analysis-v3.png
- If anything conflicts, the PRD wins. Legacy plans are background only.

PRODUCT
Caliber Studio is an AI-native game-production workspace, not a replacement game engine. The Web-first product keeps prompting, code, agents, changes, content, verification, and shipping on the left while a persistent, playable, directly editable world stays on the right. Its proof system is a synchronized frame trace: an agent can step through every captured frame, correlate the image with input, build, game state, animation state, clip time, root motion, and available bones or contacts, cite exactly where motion is wrong, propose a bounded repair, and replay the identical sequence to prove the fix. Human edits outrank agent work. Caliber Core is local-first Rust + SQLite; the Web Studio is TypeScript + React; one Web3D renderer is selected by a measured Three.js/Babylon.js bakeoff; OpenCode is the first worker behind an internal adapter; Asset Foundry turns generated candidates into validated, approved, traceable game assets. Godot follows only after the Web loop is stable. No Electron dependency for the first proof.

ONE-PASS CONTRACT
1. Inspect the workspace, tests, PRD requirement index, and loop state. Never redo accepted work.
2. Select exactly one smallest unblocked P0 requirement or current decision spike. State its ID and observable acceptance test before editing.
3. Implement the thinnest end-to-end slice. Preserve normal project files, stable IDs, revisions, user-priority ownership, idempotency, evidence, and reversal.
4. Run the narrowest meaningful checks plus one user-visible path. For animation or visual work, capture exact frame ranges and synchronized state, then replay the same sequence after the change. Do not call work complete without evidence.
5. Update ./CALIBER_LOOP_STATE.md with requirement, changes, commands/results, decisions, risks, and the single best next slice.
6. Stop. Do not begin the next slice in the same pass.

GUARDRAILS
- No silent overwrite, broad deletion, secret exposure, unapproved publishing, or overlapping writers.
- Do not fork or copy OpenCode UI; integrate it through the worker boundary.
- Do not support multiple production renderers at once: benchmark, decide, then isolate the winner behind the adapter.
- Generated output is never automatically production-ready: preserve originals, lineage, validation, approval, and cost.
- No visual diagnosis may trigger a mutation unless it cites exact captured frames or timecodes, affected object or bone, animation state, relevant telemetry, and confidence. The identical deterministic replay must verify the repair.
- Keep engine-native scenes authoritative; share intent, identity, tasks, assets, evidence, and approvals.
- Avoid new dependencies and abstractions unless this slice proves the need.

OUTPUT
Outcome | Requirement | Changed | Verified | Evidence | Next | Blocker (if any)
```

## Official implementation references

Consult only the references relevant to the selected slice.

- [OpenCode documentation](https://opencode.ai/docs/)
- [OpenCode SDK](https://opencode.ai/docs/sdk/)
- [OpenCode server](https://opencode.ai/docs/server/)
- [Model Context Protocol](https://modelcontextprotocol.io/docs/getting-started/intro)
- [Three.js documentation](https://threejs.org/docs/)
- [Babylon.js documentation](https://doc.babylonjs.com/)
- [WebGPU specification](https://www.w3.org/TR/webgpu/)
- [WebCodecs specification](https://www.w3.org/TR/webcodecs/)
- [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
- [Rust Book](https://doc.rust-lang.org/book/)
- [Axum documentation](https://docs.rs/axum/latest/axum/)
- [Tripo API documentation](https://platform.tripo3d.ai/docs)
- [Meshy API documentation](https://docs.meshy.ai/)
- [Blender command-line documentation](https://docs.blender.org/manual/en/latest/advanced/command_line/index.html)
- [Playwright documentation](https://playwright.dev/docs/intro)
- [Godot stable documentation](https://docs.godotengine.org/en/stable/)

## Short launcher for every spawned agent

```text
Run exactly one Caliber Studio build-loop pass. Work from ./CALIBER_BUILD_LOOP_PROMPT.md and continue from ./CALIBER_LOOP_STATE.md. Complete one smallest unblocked P0 slice with evidence, update loop state, then stop.
```
