# Harness Port: memory, hooks, file-defined commands, and a loop that is a loop

Companion to `harness-gaps.md`, which listed *what* is missing against opencode
and Hermes. This one is about *shape*: why Claude Code's equivalents feel
composable and ours feel welded on, and the concrete port for each.

## The thesis

Claude Code ships **mechanism**; CaliCode ships **policy**.

Claude Code's `/loop` is a markdown skill plus one tool that owns a timer. Its
hooks are "run my shell command at this point in the turn". Its memory is a
file with a `description:` line. None of these know anything about the task —
the user and the model compose them.

CaliCode's `/loop` is a finished game-QA pipeline wearing a loop's name: it
rewrites the user's goal every iteration to mandate a three-root task graph, a
judge, PIE captures and three persisted frames, and refuses `DONE` without
them. That rigor is genuinely stronger than anything Claude Code has — and it
is not optional, which is why the harness feels like it has opinions the user
never gave it.

The port is not "add features". It is: extract the mechanism under each
existing policy, and keep the policy as an opt-in profile.

## The one pattern, four times

Every extension surface in Claude Code is the same object:

> a directory of markdown files, each with a `description:` in frontmatter,
> plus an index that carries only the descriptions until something is invoked.

| Surface | Path | Frontmatter | Loaded at start |
| --- | --- | --- | --- |
| Skills | `skills/<n>/SKILL.md` | `name`, `description` | description only |
| Commands | `commands/<n>.md` | `description`, `argument-hint` | description only |
| Agents | `agents/<n>.md` | `name`, `description`, `tools`, `model` | description only |
| Memory | `memory/<n>.md` | `name`, `description`, `metadata.type` | `MEMORY.md` index only |

Hooks are the same idea applied to behaviour instead of text: a config entry
naming a command, matched against an event and a tool name.

CaliCode already implements this pattern once, correctly, in `skills.rs` —
`parse_skill`, `scan_dir` with its symlink-escape guard, `render_index`,
scope shadowing, and `prompt_index` costing one line per entry. **Three of the
four ports below are that module applied again.**

## 1. Memory

### What Claude Code does

`~/.claude/projects/<slugified-cwd>/memory/` — per-project, keyed by the
absolute path of the repo, so memory follows a checkout without living inside
it. Nothing to gitignore, nothing leaked in a PR.

```markdown
---
name: workflow-spec-312-flake
description: e2e workflow.spec.ts:312 fails intermittently once the asset
  registry has >1 entry; two plausible causes already disproven
metadata:
  type: project
---

`e2e/workflow.spec.ts:312` … 7 failures in 12 runs …

**Two hypotheses are already disproven — do not re-run them:** …

See [[calicode-concurrent-sessions]].
```

Five decisions worth copying exactly:

1. **One fact per file.** A wrong memory is deletable without collateral.
2. **`MEMORY.md` is an index of one-liners** and is the only thing in context
   at session start. Bodies are fetched on demand. Three memories cost ~40
   tokens, not three documents.
3. **`description` is written for the recall decision, not as a summary.**
   "two plausible causes already disproven" is the sentence that stops a future
   session burning an hour. This field is the entire value of the system.
4. **`metadata.type`** — `user` / `feedback` / `project` / `reference` — because
   the four have different lifetimes and different rules for when to rewrite.
5. **`[[wiki-links]]`** between facts. A dangling link is not an error; it marks
   a fact worth writing later.

### The port

`core/src/memory.rs`, mirroring `skills.rs`:

- `~/.cali/memory/` global (`CALI_MEMORY_DIR` to isolate a test run, exactly as
  `CALI_SKILLS_DIR` does), plus `<base>/.cali/memory/` per project, where
  `<base>` follows the `game_file_base` rule — reuse
  `skills::project_skills_dir`'s logic verbatim.
- Tools: `memory_list` / `memory_read` (`Access::ReadOnly`), `memory_write` /
  `memory_forget` (`Access::Guarded` — they write to the user's disk).
- Index appended by `default_system_prompt` (`rpc.rs:1846`).

Two CaliCode-specific traps, both discovered by reading the code rather than
assumed:

- **Append the index to the volatile `## This session` block, never to
  `STATIC_SYSTEM_PROMPT`.** The comment at `rpc.rs:1929` exists for exactly
  this mistake: that const is byte-identical across every project and session
  so a provider prefix cache serves it as one shared read. Interpolating a
  per-project memory index into it re-bills ~2K tokens of static instruction on
  every turn of every session.
- **The system prompt is inserted only when the transcript is empty**
  (`agent.rs:1154`), so the index is a session-start snapshot. That is fine and
  matches Claude Code: a memory written mid-session is already in context
  because the model just wrote it, and the index refreshes on the next session.
  It also means **no compaction change is needed** — the system message sits in
  `PROTECTED_HEAD_MESSAGES` (3) and survives `compaction::apply` untouched.

Cap the index (~60 entries) and cap a body (~8 KB). A memory is a fact; a
memory that grew into a document is a bug in how it was written, and the write
tool should say so rather than store it.

## 2. Hooks — the seam everything else is built on

### What Claude Code does

Config merges from `~/.claude/settings.json` → project `.claude/settings.json`
→ `.claude/settings.local.json` → every installed plugin's `hooks/hooks.json`:

```json
{"hooks": {"PreToolUse": [
  {"matcher": "Edit|Write",
   "hooks": [{"type": "command", "command": "node check.mjs", "timeout": 5}]}
]}}
```

`matcher` is a regex over the tool name (`*` for all). Events in live use:
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`,
`SessionStart`, `SessionEnd`, `Stop`, `UserPromptSubmit`, `Notification`.

The whole protocol:

- **stdin** — JSON: `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
  `tool_name`, `tool_input`.
- **stdout** — plain text is injected as context; or JSON
  `{"decision":"block","reason":"…","systemMessage":"…"}`.
- **exit 0** proceed, **exit 2** block with stderr as the reason, **timeout**
  fails open.

### Why this is the highest-leverage item

The official `ralph-loop` plugin implements a complete autonomous loop in **one
bash file**. It is a `Stop` hook: read `transcript_path`, look for
`<promise>…</promise>` in the last assistant text block, and when it is absent
emit `{"decision":"block","reason":"<the original prompt, verbatim>"}`. The
harness re-injects and the turn continues. Zero harness changes.

That is the same capability that cost us ~350 lines inside `AgentPanel.tsx`
plus a 3,205-line `loop_report.rs` — because we have no seam, so the loop had
to be built *into* the UI.

### The port

`core/src/hooks.rs`. The chokepoint already exists: `tool_gate` in `agent.rs`.

- `PreToolUse` runs **before `guardian.rs`**. Deterministic user policy
  outranks model judgment and costs zero tokens; the guardian is the fallback
  for what policy cannot decide.
- `PostToolUse` appends to the tool result — which hands us `harness-gaps.md`
  Tier 3 #19 (post-write typecheck) for free, as a hook rather than a feature.
- `SessionStart` output is appended in `default_system_prompt`.
- `Stop` is the loop seam.
- `PreCompact` lets a user protect something before the summary call.

Two things to get right:

- **Spawn with `env_clear()`** plus a declared allowlist. Copy
  `devserver.rs:108-116`, which is correct; `mcp.rs:103` is the version that
  leaks `CALI_*_API_KEY` into a child, and is already Tier 0 #1 on the gap list.
- **First-use consent keyed on the command string**, stored in config. A hook
  is arbitrary code execution — cloning a repo must not silently grant one.

## 3. `/loop`

Claude Code has three, and the split is the point:

| | Owner | Mechanism |
| --- | --- | --- |
| Self-paced | model | `/loop` skill + `ScheduleWakeup(delaySeconds, prompt, noop, stop)` |
| Fixed interval | harness | `/loop 15m <prompt>` → a cron entry, outlives the session |
| Third-party | plugin | the `Stop` hook above |

In all three the **prompt is data, replayed verbatim**. The harness owns only
*when*. Compare `loopIterationPrompt` (`AgentPanel.tsx:232`), which rewrites the
goal every iteration with a mandated graph topology.

### The port

Move the driver out of React into core as a session-owned object —
`loop_start(goal, interval, profile)` / tick / `loop_stop`. Then:

- Replay `goal` verbatim.
- Keep the entire graph + judge + evidence gate, as `profile: "aaa"`, opt-in.
- Default profile: the model says done; the operator can interrupt.

Once it lives in core it survives the tab closing, resumes with the session,
and becomes drivable headlessly or from cron — none of which is possible while
its state is React refs (`cancelLoopRef`, `loopKnownGraphIdsRef`).

## 4. Commands and agents as files

- `~/.cali/commands/*.md` + `<project>/.cali/commands/*.md`, frontmatter
  `description` and `argument-hint`, body is the prompt, `$ARGUMENTS` / `$1..`
  substituted. Merge into `slashCommands.ts` through a `command_list` RPC,
  rendered beside the built-ins exactly as skills already are.
- `~/.cali/agents/*.md`, frontmatter `name`, `description`, `tools`, `model`.
  Then delete the hardcoded four roles at `slashCommands.ts:79` — core already
  takes the role as a free string (`tools.rs:1077`).

## Order

1. **Memory** — self-contained, felt every session, no shared-file integration.
2. **Commands + agents from disk** — hours; the loader exists.
3. **Hooks** — the multiplier. Once it lands, loop/format/policy become
   plugins instead of core changes.
4. **`/loop` into core with profiles** — the largest, and the one that removes
   "weird".

## Verification

Per `AGENTS.md`, each step: `cargo fmt --check && cargo clippy --all-targets --
-D warnings && cargo test`, then `npx tsc -b --noEmit`, `pnpm test`, and
`pnpm test:e2e --grep-invert @live` for anything the client touches.

Memory-specific coverage worth naming:

- a memory index costs one line per entry and is absent entirely when the
  directory is empty (mirrors `prompt_index_is_empty_without_usable_skills`)
- `STATIC_SYSTEM_PROMPT` still contains no per-project bytes with memories
  present — the prompt-cache invariant, asserted directly
- a memory symlinked outside its directory is skipped
- project scope shadows global on a name clash
- an oversized body is refused at write rather than truncated at read
