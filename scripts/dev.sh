#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required" >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required" >&2
  exit 1
fi

(cd "$ROOT/core" && cargo run) &
CORE_PID=$!
trap 'kill "$CORE_PID" 2>/dev/null || true' EXIT

cd "$ROOT/client"
if [ ! -d node_modules ]; then
  pnpm install
fi
pnpm dev

