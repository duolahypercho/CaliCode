# CaliCode Harness Gap-Closing Plan (vs opencode + Hermes)

## Context

CaliCode's harness (agent loop, skills+MCP, graph engineer, sessions, checkpoints) was compared feature-for-feature against **sst/opencode** and **NousResearch/hermes-agent** (assumption: "hermes" = the open-source hermes-agent; no local Hermes repo exists on this machine — `docs/harness-parity.md`'s "user's own internal harness/gateway" note is reconciled as a local deployment of it). Three inventory agents produced: a full CaliCode surface map with file:line anchors, and full harness feature inventories of both references. The repo's own `docs/harness-parity.md` backlog (Tier 3: custom commands, plan mode, @-mention outstanding) is folded in.

Per user decision: **tiered plan — core batch first**; identity misfits (messaging bridges, voice/TTS/STT, GitHub bots, enterprise SSO, billing/subscriptions, pets, OS sandboxes, cloud share) are listed as out-of-scope, not planned.

## Complete gap list

**Legend:** [O] = opencode has it, [H] = Hermes has it, [B] = both.

### Tier 0 — correctness/security fixes in what already exists (do first, small)

1. **MCP children inherit the full parent env** incl. `CALI_*_API_KEY` (`core/src/mcp.rs:103-110` has no `env_clear`). The scrub pattern + pinning test already exist at `core/src/devserver.rs:108-116,326` — apply the same: `env_clear()` + declared `cfg.env` + safe baseline (PATH/HOME/LANG/LC_ALL/TMPDIR/SHELL). [B do this]
2. **Subagents always run `full-access`** (`core/src/tools.rs:601`), escaping a supervised parent. Fix: inherit the parent's permission mode (never wider), route approval requests to the parent's session events; graph judge/build nodes keep explicit modes. Add `subagent_depth` cap (opencode default 1; ours: 2) and a fan-out cap. [B]
3. **No model retry** — one transient 500 kills the turn (`core/src/agent.rs:99`). Bounded retry w/ exponential backoff on 429/5xx/network (3 attempts), then optional `fallback_providers` chain (Hermes: turn-scoped, primary restored next user msg). [B]
4. **`sessions::fork` non-atomic write** (`core/src/sessions.rs:226`) — use the existing temp+rename path (`sessions.rs:124-126`).

### Tier 1 — core batch (this plan's implementation scope)

5. **Token accounting** [B]: parse `usage` from the SSE stream in `core/src/model.rs` (stream_options include_usage for OpenAI-compat), accumulate per session in `AgentSession`, expose in `agent.delta`/session records, surface as `/usage` + a context meter in AgentPanel. Prereq for #6.
6. **Auto-compaction in core** [B]: current `/compact` (client-side, `AgentPanel.tsx:459-486`) nukes the whole transcript into 5-8 bullets. Replace with a core `session_compact` RPC using the Hermes phase design: (a) prune old tool results >200 chars, (b) protect first 3 + tail messages (tool-pair aligned), (c) one structured summary (Goal/Progress/Decisions/Files/Next steps) via the model, (d) in-place with soft archive of old turns in the session file. Auto-trigger at 75% of `context_length` (config `compaction: {auto, threshold, reserved}` à la opencode). New module `core/src/compaction.rs`.
7. **MCP upgrades** [B]: (a) per-project servers — optional `mcp_servers:` in `<game folder>/.cali/config.yaml` merged per-id over global, project `enabled:false` can disable a global server; (b) per-server `tools: {include: [], exclude: []}` fnmatch filtering in `tool_defs()` (`mcp.rs:471-496`); (c) `transport: http` (streamable HTTP) as a second `McpClient` variant — stdio stays default.
8. **Permission rules** [O]: keep the 4 modes; add config `permissions: {"<tool-glob>": "allow"|"ask"|"deny"}` (last-match-wins, per-project overridable) evaluated before mode logic in `requires_approval` (`agent.rs:410`); `deny` hides the tool from defs. Make **plan mode real**: a `plan` core mode where only read-only tools are dispatchable (whitelist in `is_destructive`'s module), not a UI alias for supervised (`AgentPanel.tsx:41-51`).
9. **Repo-surgery tools** [B]: the agent has no edit/grep/glob — only whole-file `file_write` (2 MB read /8 MB write caps). Add core tools `file_edit` (exact string replacement, opencode semantics: unique match or fail), `file_grep` (regex over game_file_base, ripgrep-style output caps), `file_glob` (pattern → mtime-sorted paths). All resolve through existing `game_file_base` + `workspace::safe_resolve` (`tools.rs:24-43`) so secret patterns/dotfile rules keep applying. **No bash tool** in this tier — CaliCode deliberately avoids arbitrary exec (`devserver.rs:75` comment); revisit as Tier 3 with Hermes-style dangerous-pattern gating.
10. **Parallel execution** [B]: (a) agent loop executes a turn's tool_calls concurrently (`join_all`, keep result order) instead of the sequential `for` (`agent.rs:133`) — browser tools already multiplex via oneshots; (b) graph engine runs all `ready_nodes()` concurrently up to `MAX_PARALLEL_NODES=3` instead of `ready.first()` (`graph.rs:1400`) — `CaptureListener` is already session-scoped so evidence attribution survives; per-node cancel flags stay.

### Tier 2 — context & extensibility (planned, next batch)

11. **Context-file chain** [B]: extend `skills_block` (`rpc.rs:683`) to first-match `CALICODE.md → AGENTS.md → CLAUDE.md` in the game folder, plus global `~/.cali/CALICODE.md`; Hermes-style injection scan (ignore-previous phrasing, invisible Unicode) before inlining; `/init` command generating CALICODE.md from the project.
12. **@-file mention** [O, backlog #12]: `@` fuzzy-search over game_file_base (new `file_search` RPC), inserts file content as a user-message attachment block.
13. **Custom slash commands** [B, backlog #9]: `~/.cali/commands/*.md` + `<project>/.cali/commands/*.md`, frontmatter (description), `$ARGUMENTS`/`$1..` substitution, merged into `slashCommands.ts` registry via a `command_list` RPC.
14. **Shell hooks** [B]: config-declared `hooks: {pre_tool_call: [...], post_tool_call: [...], session_end: [...]}`; stdin JSON, stdout JSON (`{"decision":"block","reason":...}` Claude-Code-compat), exit 2 = block, fail-open, first-use consent allowlist keyed on command string (Hermes) stored in config.
15. **Undo/redo + checkpoint completeness**: `checkpoint_list` RPC (dir listing already exists on disk), auto-checkpoint before first destructive tool per turn, `/undo` `/redo` as a rewind stack in the client; extend coverage to workspace files via an opencode-style internal shadow-git snapshot repo under `~/.cali/snapshots/<workspace-id>/` (workspace repos are untouched).
16. **Agent memory** [H]: per-project `MEMORY.md` (agent notes, ~2200 chars) + global `USER.md`, injected as frozen snapshot in the volatile prompt tier; `memory` core tool (add/replace/remove, over-limit error forces consolidation); optional write-approval staging.

### Tier 3 — power features (listed; plan later)

17. Model layer: `api_mode: anthropic_messages` adapter, aux-model slots (cheap model for monitor/title/compaction summaries), prompt `cache_control`, provider fallback UI. [B]
18. Approval-gated `terminal` tool with Hermes dangerous-pattern detector + hardline blocklist; package-script-only remains the default. [B]
19. Post-write checks: run the workspace's own typecheck/lint after `file_write`/`file_edit` and append diagnostics to the tool result (adapted from opencode LSP-diagnostics/formatters). [B]
20. Tool-loop guardrails (repeat-failure soft warnings) [H]; headless `cali run` CLI + local stats [B]; session export to markdown/JSON (no cloud share) [O]; skills hub install-from-URL with security scanner + provenance [H]; agent-authored skills (`/learn`, staged) [H].

### Out of scope (identity misfits — not planned)

Messaging bridges, voice/TTS/STT, computer-use, GitHub/GitLab bots, enterprise SSO/managed config, subscriptions/billing/proxy, A2A/ACP, mDNS/remote web, egress MITM proxy, OS sandboxes (parity doc marks skip), themes/keybinds, pets.

## Implementation plan (Tier 0 + Tier 1)

Execution mirrors the proven pattern from the last cycle: parallel module builders with disjoint file ownership → integrators for shared files (`main.rs`, `rpc.rs`, `tools.rs`, `agent.rs`, `AgentPanel.tsx`) → verify sweep + harsh blueprint-fidelity re-score (threshold 90).

**Wave A — Tier 0 fixes** (4 small parallel agents, disjoint):
- `mcp.rs` env scrub (+ test mirroring `devserver.rs:326`)
- `tools.rs` subagent permission inheritance + depth cap (+ tests); approval events routed with parent session id
- `model.rs` retry/backoff (+ fallback config in `config.rs`) (+ tests with a fake server)
- `sessions.rs` atomic fork (+ test)

**Wave B — Tier 1 core** (module builders, then integrators):
- `core/src/compaction.rs` (new): prune/boundary/summarize/apply pipeline + token estimation; consumes usage totals
- `model.rs`+`agent.rs`: usage parsing, per-session accounting, `session_compact` RPC + auto-trigger
- `mcp.rs`+`config.rs`: project-scope merge, include/exclude filters, http transport client
- `agent.rs`: permission rules engine + real plan mode; parallel tool_calls
- `tools.rs`: `file_edit`/`file_grep`/`file_glob` (+ dispatch, destructive classification: edit yes, grep/glob no)
- `graph.rs`: parallel ready-node execution with cap + tests
- Client: context meter + `/usage`, compaction UX (auto-compact toast, soft-archive rendering), MCP settings additions (per-project badge, tool filters), plan-mode toggle wired to core mode

**Verification:**
- `cd core && cargo build && cargo test && cargo clippy` (zero warnings), `cd client && npx tsc --noEmit && npx vitest run && npx vite build`
- Boot smoke: `./scripts/dev.sh`, curl new RPCs (`session_compact`, mcp filters visible in `mcp_list`)
- Targeted: env-scrub test proves no `CALI_*` reaches a fake MCP server; subagent test proves supervised parent ⇒ non-full-access child; retry test survives one injected 500; parallel-graph test proves two independent nodes overlap; plan-mode test proves `file_write` is refused
- Final harsh reviewer re-scores Tier 0+1 implementation vs this plan, punch list loop until ≥90

**Docs:** update `docs/harness-parity.md` matrix + Status, README "Extending CaliCode" (per-project MCP, tool filters).
