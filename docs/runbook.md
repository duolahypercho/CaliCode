# Cali Runbook

## Start

```bash
./scripts/dev.sh
```

- Editor: `http://127.0.0.1:5199`
- Rust core: `http://127.0.0.1:8765`
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

`~/.cali/config.yaml` mirrors the Hermes model shape:

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

## Browser Agent Tools

`editor.scene_inspect`, `editor.object_add`, `editor.object_remove`,
`editor.update_transform`, `editor.script_write`, `editor.run_pie`,
`editor.capture_frame`, `editor.run_tests`, `editor.asset_generate`,
`editor.asset_preview`, `editor.promote_asset`.
