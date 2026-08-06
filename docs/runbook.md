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

## Browser Agent Tools

`editor_scene_inspect`, `editor_object_add`, `editor_object_remove`,
`editor_update_transform`, `editor_script_write`, `editor_run_pie`,
`editor_capture_frame`, `editor_run_tests`, `editor_asset_generate`,
`editor_asset_preview`, `editor_promote_asset`.

## Live Loop Checks

```bash
node scripts/agent-tool-client.mjs
node scripts/agent-subagent-client.mjs
node scripts/agent-vision-client.mjs
```

`agent-vision-client.mjs` proves PIE, frame capture, and screenshot baselines
through the live agent loop. `agent-subagent-client.mjs` proves native subagent
spawning with a browser tool roundtrip.
