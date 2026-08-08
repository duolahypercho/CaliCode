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
| **Slash-command system** (registry + autocomplete) | ✅ 40+ | ✅ | 🟡 quick-actions | ❌ (only `/model`) | **core** |
| `/loop` autonomous continuous run | 🟡 goal+background | 🟡 run/serve | 🟡 full-access | ❌ | **core** ⭐ |
| `/help` | ✅ | ✅ | — | ❌ | core |
| `/clear` · `/new` | ✅ | ✅ | ✅ | ❌ | core |
| `/compact` (summarize context) | ✅ | ✅ | ✅ | ❌ | core |
| `/diff` (show changed files) | ✅ | 🟡 viewer | ✅ viewer | ❌ | core |
| `/model` picker | ✅ | ✅ | ✅ | ✅ | done |
| **Approval / permission modes** | ✅ | ✅ granular | ✅ 3 | 🟡 4 modes, no enforcement doc | adapt |
| **Session resume** | ✅ | ✅ | ✅ | ❌ | core |
| **Session fork** | ✅ | ✅ | 🟡 | ❌ | adapt |
| **Session list / history** | ✅ | ✅ | ✅ threads | ❌ | core |
| **Undo / redo** (checkpoint rewind) | 🟡 fork | ✅ snapshots | ✅ git-ref | 🟡 `project_checkpoint` tool only | adapt |
| **Custom commands** (markdown files) | ✅ `~/.codex/prompts` | ✅ `.opencode/commands` | 🟡 quick-actions | ❌ | core |
| **Plan mode** | ✅ | ✅ | ✅ | ❌ | adapt |
| **Subagents** | ✅ | ✅ | 🟡 | ✅ 4 roles | done |
| **MCP servers** | ✅ | ✅ | via adapters | ❌ | adapt |
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
2. **`/loop <goal>`** — continuous autonomous execution: re-send the goal each
   turn until the agent reports done or a max-iteration cap, streaming progress
   and stoppable. *client only (loops `agent_chat`).*
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
- ⏭ Next candidates: undo/redo rewind on `project_checkpoint`; then Tier 3
  (custom commands, plan mode, MCP, @-mention). Plus the hermes function pass
  (harness-relevant subset: goals, fanout, skills, hooks, mcp, dashboard,
  projects, chat, activity).

Added reference: **hermes** (the user's own internal harness/gateway) — fold its
UI/UX and commands into a future parity pass; treat its `.env`/secrets as
off-limits.
