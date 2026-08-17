# The shell tool

Status: **proposed.** Reopens the deferral recorded in `harness-gaps.md` §9
("**No bash tool** in this tier … revisit as Tier 3 with Hermes-style
dangerous-pattern gating") and in `devserver.rs:73-76`.

Recommendation: **one tool, `shell_run`, declared `Access::Guarded`, executed
through the confined one-shot path `terminal.rs` already owns.** No change to
`agent.rs`. No dangerous-pattern list.

---

## 0. The decision in one paragraph

The agent has 68 tools and not one of them runs a command — no `npm install`,
no build, no test suite, no `ffmpeg`, no `python`. Every other harness of this
shape (Codex, Claude Code, Hermes) has a shell, and a shell is *why* they feel
unbounded: it turns "the tools we thought of" into "the tools we thought of,
plus everything on the machine." The reason we don't have one was good when it
was written — `agent_chat` reaches core tools, so a raw command string was
arbitrary code execution with nothing underneath it. That is no longer true.
Since that note landed, `sandbox.rs` (Seatbelt: workspace-confined, `.git`
read-only, network denied by omission, secrets stripped), `hooks.rs` (layer 0,
sees the arguments, costs no tokens), `guardian.rs`, and `permissions:` rules
have all shipped. **The mitigations the deferral was waiting for are built.**
And the confined one-shot exec already exists — `terminal.rs::shell_command`
— it is simply wired to the user's terminal panel and not to the agent.

The gating question was also framed wrongly. A dangerous-pattern list over
command strings is the same mistake `auto` already outgrew: it cannot tell
`rm -rf node_modules` from `rm -rf ~`, for exactly the reason a tool-name
allowlist cannot tell a `file_write` into `main.js` from one into `~/.ssh`.
The four layers were built to make that distinction from the *arguments*. A
shell is the tool they were built for.

---

## 1. Surface

One tool. Foreground only.

```
shell_run {
  command:   string   required   the whole command line, run under $SHELL -lc
  cwd:       string   optional   relative to the workspace root; must resolve inside it
  timeoutMs: integer  optional   default 120000, max 600000
  network:   boolean  optional   default false — see §3
}
```

Returns:

```json
{
  "exitCode": 0, "signal": null, "durationMs": 8421,
  "cwd": "packages/game",
  "stdout": "…", "stderr": "…",
  "truncated": true, "outputId": "spill-…"
}
```

**No `background`, no `shell_kill`, no `shell_output` in v1.** The one process
a game needs to outlive a call is the dev server, and `devserver_*` already
owns it with port reservation, orphan reaping and its own confinement. A
second long-running process registry earns its complexity only once something
needs it; `terminal.rs` already has `Terminals::start`/`kill`/`list` to lift
if that day comes.

A run that hits `timeoutMs` kills the **process group** — not the shell — and
returns what was captured with `signal` set. Killing the shell alone leaves
`npm test`'s node children running, which is why `shell_command` already makes
the shell a group leader.

## 2. Where it slots into the gate

This is the whole wiring, and it is one field:

```rust
ToolDef {
    name: "shell_run".into(),
    kind: ToolKind::Core,
    access: Access::Guarded,   // <- everything below follows from this
    …
}
```

Because `is_destructive` answers from `core_tool_access` rather than a list,
declaring the tool `Guarded` places it correctly in all four modes with **no
edit to `agent.rs`**:

| Mode | Path | Result |
| --- | --- | --- |
| `supervised` | `requires_approval` | asks, every call |
| `auto` | not in `auto_floor` → `is_destructive` → `Gate::Judge` | the guardian reads the command |
| `full-access` | no gate | runs |
| `plan` | absent from `PLAN_MODE_TOOLS` | never dispatches |

**It must not go in `auto_floor`.** That floor is documented as the things
"decidable from the name alone" — and a shell call is the opposite: the name
says nothing, the *argument* says everything. Putting it there would also make
`auto` useless for building, which is the mode a `/loop` runs in. Layer 4 is
where it belongs, and the guardian is well suited to it: it already sees the
tool, its description, the arguments, and the user's own words, and it already
fails closed to `ASK` on anything it cannot parse.

The layers above the guardian need nothing new either, and both are stronger
here than the guardian is:

- **`permissions:` rules** glob over the tool name, so `shell_run: deny` is a
  standing off-switch the user owns and nothing reviews.
- **`pre_tool_use` hooks** get `tool_input` on stdin — the actual command
  string — and cost zero tokens, always run, and cannot be argued out of their
  answer by anything in the transcript. A house rule like "no `curl | sh`" is
  four lines of shell, not a pattern list in `agent.rs`. This is the control
  the original deferral was asking for; it already exists.

## 3. Confinement, and the one thing it costs

Reuse `terminal::shell_command` unchanged. It already gives us, at exec:

- **Workspace-confined writes** — `sandbox::workspace_policy(root, …)`, kernel
  enforced, not the advisory containment `resolve_cwd` gives.
- **`.git` and `.wt` read-only** inside every writable root.
- **Secrets stripped** — every `CALI_*` var containing `KEY`/`TOKEN`/`SECRET`
  is removed. The rest of the environment is inherited on purpose: a build
  needs `PATH`, `NODE_ENV`, a toolchain. That is a weaker posture than
  `hooks.rs`'s `env_clear()` + six-key allowlist, and correctly so — a hook is
  a line from a config file, a build is the user's own project.
- **stdin null**, so a command that prompts fails instead of hanging forever
  with nobody able to type at it.
- **Its own process group**, so the timeout reaches the whole tree.

**Network is the one real design question.** The policy denies
`network-outbound` by omission, with a loopback carve-out so a dev server can
bind. That is right for `npm run dev` and wrong for `npm install`, which is
the single most valuable thing a shell unlocks.

Answer: a per-call `network` argument, default `false`, that selects
`Network::Full` instead of `Network::Loopback`. Not a config flag and not a
blanket allowance — because an argument is *visible to every layer above*. The
guardian sees `network: true` in the arguments it judges. A hook sees it on
stdin. The approval card shows it. That turns "may this command phone home"
into a reviewable per-call fact instead of a global posture, and it means the
agent has to ask for the network rather than always having it.

**Non-macOS is unconfined.** `sandbox.rs` is best-effort by design: no
`sandbox-exec`, no confinement, spawns go out bare. We ship a macOS desktop
today, so this is acceptable — but it must be said out loud, and
`sandbox::status()` already exists so the UI can say which of the two
happened.

## 4. Output

`MAX_OUTPUT_BYTES` in `terminal.rs` is 2 MiB, which is right for a UI panel
and catastrophic for a tool result. Cap what enters the transcript at **32
KiB** and hand the rest to `spill::write`, which is the existing pattern and
already has `tool_output_read` on the other end.

Truncate **tail-biased** — keep the last ~24 KiB and the first ~8 KiB, elide
the middle with a marker. A compiler is not interesting until it fails, and it
fails at the end; head-only truncation reliably discards the only lines that
mattered.

## 5. Tests

In `tools.rs`, beside the arm, per the house rule. The ones that are load-bearing:

- `confinement_wraps_the_spawn` — argv begins with `sandbox-exec` when enabled.
- `secrets_never_reach_a_shell_command` — mirror of
  `hooks::tests::secrets_never_reach_a_hook`; this is the regression check.
- `git_stays_read_only_under_confinement` — a `git commit` in the workspace fails.
- `network_is_denied_by_default_and_opt_in_flips_the_policy`.
- `cwd_outside_the_workspace_is_refused` (`resolve_cwd`).
- `a_timeout_kills_the_process_group` — a shell that backgrounds a child and
  exits must not leave the child running.
- `output_over_the_cap_spills_and_the_result_carries_the_id`, and that the kept
  window is tail-biased.
- `shell_run_is_guarded_in_every_mode` — Prompt in supervised, Judge in auto,
  Run in full-access, refused in plan.

## 6. What this does and does not unblock

| | |
| --- | --- |
| `npm install`, dependency management | ✅ with `network: true` |
| build, typecheck, test suites | ✅ |
| `ffmpeg`, `python`, `imagemagick`, any CLI | ✅ **if installed** — `PATH` is the user's machine, we manage nothing |
| **git** | ❌ — `.git` is read-only under Seatbelt, by design |
| long-running processes | ❌ v1 — `devserver_*` covers the dev server |
| Linux / Windows confinement | ❌ — unconfined; macOS only |

**The git row is the correction.** A shell was pitched as the thing that gives
us version control for free, and it does not: the `.git` `require-not` is one
of three load-bearing properties of the sandbox profile, and it exists because
an agent that trashes the working tree is an annoyance while one that destroys
the history is a catastrophe — precisely the unattended-`/loop` case. Carving
an exception for commands that look like `git` would defeat the invariant to
save typing.

Version control wants its own typed tool group instead — `git_status`,
`git_commit`, `git_diff`, `git_log`, `git_branch` — running in-process rather
than through the sandbox, with a reviewable surface and no path to
`push --force` or history rewriting. That is the shape PlayCanvas's editor MCP
server arrived at as well (a VCS category, not a shell). Separate plan.

## 7. Cost

One `ToolDef`, one dispatch arm, one executor that calls the existing
`shell_command` and waits with a timeout, plus the tests above. `agent.rs`,
`guardian.rs`, `hooks.rs`, `approvals.rs` and `sandbox.rs` are untouched.

The `network` argument is the only genuinely new decision in it.
