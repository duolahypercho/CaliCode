<!-- startup-kit:intake status=confirmed -->

# Project Intake

## 1. Product

- One user: an AI-first game maker who wants to build, playtest, and iterate on web games without leaving one workspace.
- One job: turn a prompt, an image, or a scene edit into a verified three.js game asset or scene.
- One primary workflow: describe or import an asset in the agent panel or workbench, generate/edit it in the three.js editor, promote it into the scene, run PIE, capture frames, run tests, and inspect pass/fail results.
- Product type: tool/dashboard.
- Product / app name: Cali.

## 2. Scope

- Must-have features (v1):
  - Native three.js editor with scene graph, inspector, script editor, console, and viewport.
  - Rust core with JSON-RPC transport, local model gateway, project store, checkpoints, and test baselines.
  - Asset workbench with procedural generation, import, preview, asset PIE, and promotion.
  - Game-only asset library with tags, search, thumbnails, usage tracking, and dedupe.
  - PIE with fixed 60 Hz loop and frame capture every 3rd/4th frame into a filmstrip.
  - Scripted tests plus screenshot baselines with Rust perceptual hashing.
  - Native agent panel with model switching, tool calls, approvals, and streaming progress.
  - Rust image-to-3D pipeline producing a data-driven `.cali` asset.
- Out of scope (for now): auth, payments, marketing, Electron/Tauri, analytics, deployment targets, binary `.cali` encoding, non-web engines.
- Deadline / milestone: MVP now.

## 3. Style

- Direction: default SF Pro.
- Custom brand: none.
- Color scheme: both (system).
- Backgrounds allowed: no (tool UI).

## 4. Architecture

- Architecture: monorepo split (opt-in, required because the Rust core is an always-on local service separate from the browser editor).
- If monorepo, why: always-on backend for agent orchestration, project storage, and PIE baselines.
- Starting state: greenfield.
- Chosen path: custom split repo (`core/` Rust service + `client/` Vite app), no startup-kit scaffold because the target stack is Rust + Vite, not Next.js + Supabase.
- Hosting: local `core` on `127.0.0.1:8765`, browser client served by Vite.

## 5. Data Model

- Database: filesystem under `~/.cali/projects/<slug>/`.
- Core entities and fields:
  - `Project` — id/slug, title, version, entities, scripts, assets, tests, settings.
  - `Entity` — id, name, kind, transform, material, light, script refs.
  - `Asset` — id, name, type, source, tags, usage, thumbnail.
  - `CaliAsset` — schemaVersion, provenance, seed, assessment, detailInventory, componentTree, materials, runtime, reviewHistory.
  - `ModelConfig` — default, provider, baseUrl, presets, env keys.
  - `TestResult` — id, name, pass, logs, captures, baseline.
- Relationships / uniqueness: assets referenced by entities via `assetId`; project slug unique.
- Access rules: single local user; no accounts.

## 6. Auth

N/A.

## 7. Payments

N/A.

## 8. Integrations & External Services

- OpenAI-compatible model endpoint — agent and AI image generation — stub behind env var (`CALI_OPENAI_API_KEY`, `CALI_OPENAI_BASE_URL`).
- No MCP.

## 9. Launch Surfaces

- SEO: no.
- Analytics: no.
- Legal: no.

## 10. Deployment & Environments

- Hosting: local Rust core + Vite dev client.
- Custom domain: no.
- Environments: local development only.
- Env vars / secrets needed (NAMES ONLY):
  - `CALI_OPENAI_API_KEY`
  - `CALI_OPENAI_BASE_URL`
  - `CALI_MODEL`

## 11. Existing Code

Greenfield. No existing frontend or backend.

## 12. Gap Analysis

N/A (greenfield); conventions adopted from startup-kit are documented in the UI System section of the project plan.

## 13. Plan

- [ ] Phase 0: repo, intake, shared schemas.
- [ ] Phase 1: Rust core.
- [ ] Phase 2: React editor.
- [ ] Phase 3: PIE and tests.
- [ ] Phase 4: image-to-3D.
- [ ] Phase 5: integration and preflight.

## 14. Out Of Scope

- Next.js/Supabase startup-kit scaffold.
- Auth, billing, analytics, marketing, packaging.
- Binary `.cali` encoding.
- Unity/Unreal/Godot adapters.

