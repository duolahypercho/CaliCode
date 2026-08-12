# Session-scoped editor agents

CaliCode has one visible editor, attached to one task at a time. Each saved
task records its `workspaceRoot`, optional Git `worktreeId`, and branch. Opening
a task switches the file editor to that root. Calls carrying another task/root
are rejected instead of being applied to whichever editor happens to be open.

The built-in CaliCode agent uses this routing automatically. External CLI
agents use the bundled stdio MCP adapter:

```bash
node /absolute/path/to/calicode/scripts/calicode-editor-mcp.mjs
```

Register that command as an MCP server in Codex CLI, Claude Code, or another
MCP client. Launch the CLI anywhere inside the task worktree; the adapter maps
its current directory to the newest matching CaliCode task. To pin an explicit
task instead, set `CALI_SESSION_ID=session-...` or add
`--session session-...` to the adapter command.

From the repository root, the current Codex and Claude CLIs can register it
directly:

```bash
codex mcp add calicode-editor -- node "$PWD/scripts/calicode-editor-mcp.mjs"
claude mcp add --scope user calicode-editor -- node "$PWD/scripts/calicode-editor-mcp.mjs"
```

The CaliCode app and core must be running, and the target task must be open in
CaliCode. This is deliberate: an external agent can control the editor the
human is looking at, but cannot silently drive a background task's editor.

For a Git-backed project, the first message in a new task creates
`~/.cali/worktrees/<project>/<task-suffix>` on branch
`calicode/<project>/<task-suffix>`. A non-Git folder is still bound to the
task, but cannot be isolated by worktree; use separate folders if concurrent
agents need independent writes.
