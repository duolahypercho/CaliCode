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

Provider presets: `openai`, `openrouter`, `local`. Switch from the agent panel
or with `/model provider:model`.

## Main RPC Methods

- `project.create`, `project.list`, `project.open`, `project.save`, `project.checkpoint`, `project.revert`
- `model.list`, `model.switch`
- `file.read`, `file.write`
- `asset.import_file`, `asset.hash_dedupe`, `asset.usage`, `asset.export_gltf`
- `test.baseline.save`, `test.baseline.compare`
- `image3d.ingest`, `image3d.assess`, `image3d.spec`, `image3d.validate`, `image3d.generate`, `image3d.review`
- `tool.register`, `tool.list`
- `agent.chat`, `agent.tool_result`, `agent.approval_response`, `agent.sessions`

## Browser Agent Tools

`editor.scene_inspect`, `editor.object_add`, `editor.object_remove`,
`editor.update_transform`, `editor.script_write`, `editor.run_pie`,
`editor.capture_frame`, `editor.run_tests`, `editor.asset_generate`,
`editor.asset_preview`, `editor.promote_asset`.

