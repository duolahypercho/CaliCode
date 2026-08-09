# CaliCode

CaliCode is a native AI game-coding harness for the web. A Rust control plane
pairs with a three.js editor: asset workbench, asset library, Play-In-Editor
(PIE) runtime, deterministic frame capture, scripted tests, and an agent panel
that drives the editor through real tool calls.

No MCP, no harness fork, and no generated Three.js code — image-to-3D
reconstruction is a Rust pipeline that emits a data-driven `.cali` asset.

## Two ways to work

**Projects** are scene documents CaliCode owns end to end, stored under
`~/.cali/projects/<slug>`. The PLAY tab runs them in the PIE viewport.

**Workspaces** are folders on disk that CaliCode edits *in place* — your own
repository, unchanged. CaliCode browses the file tree, reads and writes real
files, and runs the project's own dev server in the PLAY tab.

**Each game owns its own folder.** A workspace is attached to one game, not to
the app, so switching games in the sidebar switches the folder, the file tree,
and the dev server with it. Attach one with **ATTACH FOLDER** under the selected
game; it needs a `package.json` or a `.git`. A game with no folder attached
stays a pure scene document.

This binding is what the agent's file tools follow: `file_read`, `file_write`,
and `file_list` resolve inside the selected game's folder when it has one, and
inside `~/.cali/projects/<slug>` when it does not.

|                | Project              | Workspace                     |
| -------------- | -------------------- | ----------------------------- |
| Lives at       | `~/.cali/projects`   | anywhere                      |
| Owned by       | CaliCode             | you                           |
| Content        | scene JSON           | real source files             |
| PLAY renders   | the PIE viewport     | the workspace's own dev server |
| Attached to    | —                    | exactly one game              |

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
