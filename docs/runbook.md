# CaliCode Runbook

## Start

```bash
./scripts/dev.sh
```

- Editor: `http://127.0.0.1:5199`
- CaliCode core: `http://127.0.0.1:8765`
- JSON-RPC: `POST /rpc`
- Agent events: `GET /events` (SSE)

## Checks

```bash
cd core && cargo test
cd client && pnpm test
cd client && pnpm build
cd client && pnpm test:e2e
```

`pnpm test:e2e` excludes tests tagged `@live` and owns an isolated core on
`:8765`. Run `pnpm test:e2e:live` only when the configured provider key is
available. Stop the desktop app or development core before either command.

## Configuration

`~/.cali/config.yaml` stores the CaliCode model shape:

```yaml
model:
  default: gpt-4.1-mini
  provider: openai
  base_url: https://api.openai.com/v1
  api_key_env: CALI_OPENAI_API_KEY
```

Provider presets: `openai`, `codex-router`, `openrouter`, `local`. Switch from
the agent panel or with `/model provider:model`.

`codex-router` points at the local Codex Router gateway
(`http://127.0.0.1:4100/v1`) and reuses the router's managed provider
credentials, so DeepSeek and other router-enabled models work without a second
API key:

```bash
rpc '{"jsonrpc":"2.0","id":1,"method":"model_switch","params":{"provider":"codex-router","model":"deepseek-v4-flash"}}'
```

## Main RPC Methods

- `project_create`, `project_list`, `project_open`, `project_save`, `project_checkpoint`, `project_revert`
- `model_list`, `model_switch`
- `file_read`, `file_write`
- `asset_import_file`, `asset_hash_dedupe`, `asset_usage`, `asset_export_gltf`
- `test_baseline_save`, `test_baseline_compare`
- `image3d_ingest`, `image3d_assess`, `image3d_spec`, `image3d_validate`, `image3d_generate`, `image3d_review`
- `tool_register`, `tool_list`
- `agent_chat`, `agent_tool_result`, `agent_approval_response`, `agent_sessions`
- `subagent_spawn` (RPC and core agent tool for focused planner/coder/tester/visual-critic agents)
- `graph_plan`, `graph_run`, `graph_status`, `graph_list`, `graph_cancel`
- `loop_report_start`, `loop_report_iteration`, `loop_report_update`, `loop_report_open`, `loop_report_list`
- `video_contact_sheet`, `capture_persist`

## Browser Agent Tools

`editor_scene_inspect`, `editor_object_add`, `editor_object_remove`,
`editor_update_transform`, `editor_script_write`, `editor_camera_frame`, `editor_run_pie`,
`editor_capture_frame`, `editor_persist_capture`, `editor_analyze_motion`,
`editor_console_log`, `editor_console_history`, `editor_run_tests`, `editor_asset_generate`,
`editor_asset_preview`, `editor_promote_asset`.

For loop/judge evidence, prefer `editor_persist_capture({path})`: it captures
and atomically saves a real image in one browser tool round-trip. Do not copy
`editor_capture_frame` data URLs into `file_write`; that path is text-only.
Call `editor_camera_frame` first with gameplay foreground entity IDs; its
authored pose persists across PIE, captures, motion analysis, and reload, so
large decorative backdrops cannot occlude or shrink the evidence composition.
Use `editor_console_history` to verify runtime output (`editor_console_log`
only appends a message), and `editor_analyze_motion` for the labelled
multi-frame contact sheet and manifest.

## Activity And Reports

Each submitted prompt creates one activity turn. Its transcript row shows the
latest action and elapsed time; expand it for every tool call, file path, and
line count. Clicking a safe workspace-relative file opens the real CODE editor.
Edits and writes start in DIFF mode and can switch to the editable FILE view.

`/loop <goal>` creates a durable report under
`<project>/reports/loops/<loop-id>/` in JSON, Markdown, and standalone HTML.
The Reports workspace tab lists reports and polls only a selected running
report. Report file links are validated and preflighted before CODE opens them.

## Live Loop Checks

```bash
node scripts/agent-tool-client.mjs
node scripts/agent-subagent-client.mjs
node scripts/agent-vision-client.mjs
```

`agent-vision-client.mjs` proves PIE, frame capture, and screenshot baselines
through the live agent loop. `agent-subagent-client.mjs` proves native subagent
spawning with a browser tool roundtrip.
