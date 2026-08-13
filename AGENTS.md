# AGENTS.md

Working agreement for anyone — human or agent — changing CaliCode.

CaliCode is a native AI game-coding harness: a Rust control plane paired with a
three.js editor and an agent panel that drives that editor through real tool
calls. Read `README.md` for what the product does; this file is about how the
repo works.

## Layout

| Path             | What lives there                                                         |
| ---------------- | ------------------------------------------------------------------------ |
| `core/`          | Rust control plane. JSON-RPC over HTTP + SSE. Owns projects, sessions, agent loop, assets, MCP, skills. |
| `client/`        | Vite + React + TypeScript editor. Three.js viewport, agent panel, workspace tabs. |
| `client/src-tauri/` | macOS desktop shell. Bundles the core release binary as a sidecar.     |
| `shared/schemas/` | `project.schema.json`, `cali-asset.schema.json` — the contracts both sides honour. |
| `scripts/`       | `dev.sh` (run both halves), `desktop.sh` (package the app), live agent clients. |
| `docs/`          | `runbook.md` (operations), `verification.md` (what proves each feature works), plans, templates. |

Core modules map to features one-to-one: `agent.rs`, `rpc.rs`, `store.rs`,
`sessions.rs`, `assets.rs`, `image3d.rs`, `graph.rs`, `mcp.rs`, `skills.rs`,
`workspace.rs`, `devserver.rs`, `config.rs`.

## Run it

```bash
./scripts/dev.sh          # core on :8765 + client on :5199, from the repo root
```

The client proxies `/rpc` and `/events` to core, so only `:5199` is opened in a
browser. Both ports are overridable (`CALI_PORT`, `CALI_CLIENT_PORT`).

```bash
pnpm desktop:build        # from client/ — packages CaliCode.app (+ .dmg)
pnpm desktop:dev          # native shell against a live core
```

## Verify before you claim done

Run these from `client/` unless noted, in this order. Everything must be green.

```bash
cd core && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd client && npx tsc -b --noEmit
cd client && pnpm test                 # vitest
cd client && pnpm test:e2e             # playwright; see the port rule below
```

CI runs exactly this (`.github/workflows/ci.yml`), plus `pnpm build`. Clippy
warnings are errors — do not leave any.

**The port rule.** Core binds a fixed `:8765`, and Playwright deliberately
refuses to reuse a running core (`reuseExistingServer: false`) so the suite
never touches your real projects. Anything already holding `:8765` — a
`dev.sh` session, the packaged `CaliCode.app` — must be stopped first:

```bash
osascript -e 'quit app "CaliCode"'     # macOS, if the desktop app is running
```

**E2E isolation.** The suite points core at `client/.e2e-projects` and
`client/.e2e-config.yaml` via `CALI_PROJECTS_DIR` / `CALI_CONFIG`, and the
`pretest:e2e` hook wipes both. Always invoke it as `pnpm test:e2e` — calling
`playwright test` directly skips that wipe and lets state leak between runs.

`@live`-tagged specs need a real provider key (`CALI_OPENAI_API_KEY`); CI and
local runs exclude them with `--grep-invert @live`.

**Visual specs.** Screenshot baselines are per-platform. Development is macOS,
CI is Ubuntu, so Linux baselines can only be produced by the
`visual-baselines` workflow (`gh workflow run visual-baselines.yml`) and
committed from its artifact. Never hand-edit them.

## Conventions

**Comments explain constraints, not mechanics.** Write a comment when the code
cannot show *why* — an invariant, a failure it prevents, a platform quirk.
Never narrate what the next line does or justify the change to a reviewer;
that noise dies the moment the commit lands. Match the density of the file
you are in.

**Rust.** `cargo fmt` is the formatter, no exceptions. Every RPC method is one
arm in `rpc.rs` dispatch plus a unit test near its implementation. There are
72 methods today; keep names `snake_case` and grouped by subject
(`project_*`, `session_*`, `asset_*`, `graph_*`, `image3d_*`, `model_*`).

**TypeScript.** `strict` is on and there is no ESLint config — `tsc -b
--noEmit` plus review is the gate. Prefer named exports, no default exports
outside route-level components. Types shared with core live in
`src/lib/types.ts`.

**Design system.** Colours come only from semantic tokens defined in
`index.css` (`surface-0..3`, `ink-strong|ink|ink-subtle|ink-faint`,
`line|line-strong`, `raised`, `danger-soft`), never raw hex, so light and dark
stay in sync. Chrome uses the system sans; `.font-mono` (Space Mono) is for
code and the wordmark. **No hover border-colour changes** — hover is a
background tint, selection is a background fill. **Keyboard focus is the one
exception**: `index.css` draws a single unlayered `--focus-ring` outline for
every control, so never add a `focus-visible:ring-*` utility beside it and
never suppress it with `outline-none`; a control inside a clipping scroller
takes `.focus-ring-inset`. `ui/focusRing.test.tsx` enforces both. Icons are
`lucide-react` at `strokeWidth` ~1.7.

**Persistence is automatic.** There is no SAVE button: editing `project` state
debounces into `project_save`. Anything that loads a project from core must
register it as already-saved so hydration never writes back.

**Secrets.** API keys are read from the environment (`CALI_<PROVIDER>_API_KEY`)
and never written to `~/.cali/config.yaml`. Do not add a code path that
persists one.

## Accessibility and test contracts

E2E specs depend on these; changing them means changing the specs in the same
commit:

- exactly one `Toggle games sidebar` button exists per sidebar state
- the search dialog exposes `textbox` named `Search games`
- the sidebar resize separator is named `Resize games sidebar`
- the composer exposes `Permission mode`, `Active model`, `Agent prompt`
- a per-game hover action named `New chat in <title>`
- the empty transcript carries `[data-empty-game-hint]` containing the slug

## Extending without touching source

- **Skills** — markdown + YAML frontmatter (`name`, `description`) dropped in
  the skills directory (`CALI_SKILLS_DIR`).
- **MCP servers** — configured in `~/.cali/config.yaml`; their tools join agent
  sessions automatically.
- **Asset library** — one file in `client/src/lib/assetLibrary/repos/`
  exporting `repo: AssetRepo`. A glob picks it up; no index edit.
- **Model catalog** — models and their reasoning-effort levels come from
  models.dev through `@opencode-ai/models` (see `src/lib/modelMeta.ts`), cached
  for a day with the package's bundled snapshot as the offline fallback. Do not
  hardcode model lists.

## State on disk

| Path                          | Contents                                  |
| ----------------------------- | ----------------------------------------- |
| `~/.cali/config.yaml`         | model/provider config, MCP servers        |
| `~/.cali/projects/<slug>/`    | project documents                         |
| `~/.cali/sessions/`           | saved transcripts                         |
| `client/.e2e-projects/`       | throwaway; wiped by `pretest:e2e`         |

Current baseline: 267 Rust tests, 257 client unit tests across 25 files.
