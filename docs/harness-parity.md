# Harness parity: CaliCode vs codex / opencode / t3-code

CaliCode's agent panel is a coding-agent *harness* — chat, tool calls, approvals,
subagents. This doc compares it feature-for-feature against the leading terminal
and GUI agent harnesses, then lists a prioritized backlog.

**Important framing.** CaliCode is a *game-coding editor* (three.js scene, asset
workbench, PIE runtime), not a general terminal agent. Some features those tools
ship (Seatbelt/Landlock sandboxes, rollout JSONL, multi-provider CLI adapters)
are out of scope. This doc marks each row **fit: core / adapt / skip** so the
loop implements what actually improves CaliCode.

Sources: openai/codex (`codex-rs` source), sst/opencode docs, pingdotgg/t3code
repo + AGENTS.md, plus Claude Code, aider, and cline for context.

---

## Current CaliCode harness (baseline)

Verified in `client/src/components/editor/AgentPanel.tsx` and
`client/src/lib/useBrowserTools.ts`:

- Streaming chat (`agent.delta`), tool-call ticker, live approvals
- **Permission modes** already: `full-access` / `auto` / `auto-accept-edits` / `supervised`
- **One inline command:** `/model <provider>:<model>` (hardcoded in `send`)
- **Subagents:** planner / coder / tester / critic (`subagent_spawn`)
- **Model switch** via command + settings popover
- **Editor tool surface:** scene inspect, object add/remove, transform, script write,
  run PIE, capture frame, run tests, asset generate/preview/promote, project
  save/checkpoint, console log, select entity, test add, asset import
- `sessionId` is tracked but never persisted, listed, resumed, or forked

---

## Parity matrix

Legend — **Have** ✅ / **Partial** 🟡 / **Missing** ❌. **Fit**: core (belongs in
CaliCode), adapt (belongs but game-editor-shaped), skip (out of scope).

| Capability | codex | opencode | t3-code | CaliCode | Fit |
|---|---|---|---|---|---|
| **Slash-command system** (registry + autocomplete) | ✅ 40+ | ✅ | 🟡 quick-actions | ✅ | done |
| `/loop` autonomous continuous run | 🟡 goal+background | 🟡 run/serve | 🟡 full-access | ✅ | done ⭐ |
| `/help` | ✅ | ✅ | — | ✅ | done |
| `/clear` · `/new` | ✅ | ✅ | ✅ | ✅ | done |
| `/compact` (summarize context) | ✅ | ✅ | ✅ | ✅ real core compaction + auto-trigger | done |
| `/diff` (show changed files) | ✅ | 🟡 viewer | ✅ viewer | ✅ | done |
| `/model` picker | ✅ | ✅ | ✅ | ✅ | done |
| **Token usage / context meter** (`/usage`) | ✅ | ✅ | 🟡 | ✅ per-session totals + composer meter | done |
| **Approval / permission modes** | ✅ | ✅ granular | ✅ 3 | ✅ 5 modes + `permissions:` glob rules | done |
| **Session resume** | ✅ | ✅ | ✅ | ✅ | done |
| **Session fork** | ✅ | ✅ | 🟡 | ✅ | done |
| **Session list / history** | ✅ | ✅ | ✅ threads | ✅ | done |
| **Undo / redo** (checkpoint rewind) | 🟡 fork | ✅ snapshots | ✅ git-ref | 🟡 `project_checkpoint` tool only | adapt |
| **Custom commands** (markdown files) | ✅ `~/.codex/prompts` | ✅ `.opencode/commands` | 🟡 quick-actions | ❌ | core |
| **Plan mode** | ✅ | ✅ | ✅ | ✅ read-only tool whitelist in core | done |
| **Subagents** | ✅ | ✅ | 🟡 | ✅ 4 roles, inherit permissions, depth-capped | done |
| **MCP servers** | ✅ | ✅ | via adapters | ✅ stdio+http, project scope, tool filters | done |
| **Hooks** (lifecycle) | ✅ | 🟡 plugins | — | ❌ | adapt |
| **Skills** (on-demand) | ✅ | ✅ | — | ❌ | adapt |
| **@-file mention / context insert** | ✅ | ✅ | ✅ | ❌ | core |
| **`!`-shell run inline** | ✅ | ✅ | ✅ terminal | ❌ (has console) | adapt |
| **Themes** | ✅ | ✅ | ✅ | ❌ (fixed dark) | skip |
| **Keybind remap** | ✅ | ✅ | ✅ | ❌ | skip |
| **Native window controls** (no custom chrome) | n/a TUI | n/a | ✅ Electron | ✅ Tauri overlay | done |
| **Headless / scripted run** | ✅ `codex exec` | ✅ `opencode run` | 🟡 | 🟡 core RPC exists | adapt |
| **Sandbox (Seatbelt/Landlock)** | ✅ | 🟡 | ✅ presets | ❌ | skip |
| **Session share URL** | — | ✅ | — | ❌ | skip |

---

## Prioritized backlog (loop order)

Ranked by value × fit × tractability. Each is one loop iteration.

### Tier 1 — command surface (explicitly requested)
1. **Slash-command system** — registry + `/`-autocomplete menu in the composer.
   Convert the hardcoded `/model` into the first registered command. *client only.*
2. **`/loop <goal>`** — continuous autonomous execution: the core-owned driver
   re-sends the goal until the agent reports done or the user stops it,
   streaming progress and surviving tab reloads. *core + client.*
3. **`/help`, `/clear`, `/new`** — list commands; reset transcript; new session. *client only.*
4. **`/compact`** — summarize the transcript to reclaim context. *client + one core RPC.*
5. **`/diff`** — list files the agent changed this session (reuse checkpoint data). *client + core.*

### Tier 2 — sessions
6. **Session persistence + list + resume** — core stores sessions under
   `~/.cali`; panel gets a history picker. *core + client.*
7. **Fork** a session from any point. *core + client.*
8. **Undo/redo** wired to `project_checkpoint` as a rewind stack. *client mostly.*

### Tier 3 — extensibility
9. **Custom commands** from `~/.cali/commands/*.md` with `$ARGUMENTS`. *core + client.*
10. **Plan mode** — read-only planning turn before execution. *core + client.*
11. **MCP client** — connect external MCP tool servers into the tool surface. *core.*
12. **@-file mention** picker for context insertion. *client.*

### Skip (out of scope for a game editor)
Themes, keybind remap, OS sandbox presets, share URLs — noted for completeness.

---

## Status

- ✅ Native window controls (Tauri overlay title bar).
- ✅ **Tier 1 — command surface:** slash-command system with `/`-autocomplete;
  `/loop`, `/help`, `/clear`, `/new`, `/compact`, `/diff`, `/model`.
- ✅ **Tier 2 — sessions:** persistent transcripts under `~/.cali/sessions`
  (`session_save/list/load/fork/delete` RPCs), auto-save, clickable history
  picker, `/resume` (last), `/fork`, `/sessions`.
- ✅ **UI/UX interaction-state polish** — a 6-agent fan-out applied one house
  style (focus-visible rings, active/pressed states, ~150ms transitions,
  disabled gating, ≥28px hit targets, keyboard reachability, compositor-friendly
  meters) across 21 components; an adversarial judge scored it **PASS** against
  10 promotion criteria (2 rounds).
- ✅ **Harness gap batch, Tier 0** (docs/plans/harness-gaps.md): MCP child
  processes get a scrubbed env (no `CALI_*` keys); subagents inherit the
  parent's permission mode/rules with a depth cap instead of always running
  full-access; bounded model retry with backoff + `fallback_providers`;
  atomic `session_fork` writes.
- ✅ **Harness gap batch, Tier 1** — core: per-session token accounting from
  provider `usage` (emitted as `agent.usage` events); real context compaction
  (`session_compact` RPC + auto-trigger at `compaction.threshold`, old tool
  results pruned, middle summarized, replaced turns soft-archived in the
  session file); MCP per-project servers (`<game>/.cali/config.yaml` merged by
  id over global), per-server `tools: {include, exclude}` filters, and
  `transport: http`; `permissions:` glob rules (allow/ask/deny, last match
  wins, deny hides the tool) evaluated before mode logic; a real `plan`
  permission mode restricted to a read-only tool whitelist; `file_edit` /
  `file_grep` / `file_glob` repo-surgery tools; parallel tool-call execution
  and parallel graph nodes (cap 3).
- ✅ **Harness gap batch, Tier 1 — client:** context meter beside the composer
  + `/usage` (driven by `agent.usage`, window from `compaction.context_length`
  via `config.read`); `/compact` now calls `session_compact` (the old
  client-side transcript-nuking summary is gone) and both manual and
  auto-compaction render a transcript notice from `agent.compacted`; archived
  turns render as a collapsed row on resume; the composer's Plan option maps
  to core's real `plan` mode; MCP settings show per-server transport,
  global/project scope badge, and the read-only tool include/exclude filter;
  turns now send only the new user message when a live core session exists
  (full history only seeds new/lost sessions), so compaction actually shrinks
  the working context.
- ⏭ Next candidates: undo/redo rewind on `project_checkpoint`; then Tier 2 of
  the gap plan (context-file chain, @-mention, custom commands, hooks,
  shadow-git checkpoints, agent memory). Plus the hermes function pass
  (harness-relevant subset: goals, fanout, skills, hooks, mcp, dashboard,
  projects, chat, activity).

Added reference: **hermes** (the user's own internal harness/gateway) — fold its
UI/UX and commands into a future parity pass; treat its `.env`/secrets as
off-limits.
