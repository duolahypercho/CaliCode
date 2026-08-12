#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE_PORT="${CALI_PORT:-8765}"
CLIENT_PORT="${CALI_CLIENT_PORT:-5199}"
CORE_PID=""
CORE_LISTENER_PID=""
CLIENT_PID=""

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required" >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required" >&2
  exit 1
fi

if ! [[ "$CORE_PORT" =~ ^[0-9]+$ ]] || ! ((10#$CORE_PORT >= 1 && 10#$CORE_PORT <= 65535)); then
  echo "CALI_PORT must be an integer between 1 and 65535 (got '$CORE_PORT')" >&2
  exit 1
fi
if ! [[ "$CLIENT_PORT" =~ ^[0-9]+$ ]] || ! ((10#$CLIENT_PORT >= 1 && 10#$CLIENT_PORT <= 65535)); then
  echo "CALI_CLIENT_PORT must be an integer between 1 and 65535 (got '$CLIENT_PORT')" >&2
  exit 1
fi

port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1
  else
    return 1
  fi
}

if port_in_use "$CORE_PORT"; then
  echo "Core port $CORE_PORT is already in use. Stop the existing CaliCode core/app or choose CALI_PORT." >&2
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$CORE_PORT" -sTCP:LISTEN >&2 || true
  fi
  exit 1
fi
if port_in_use "$CLIENT_PORT"; then
  echo "Client port $CLIENT_PORT is already in use. Stop the existing Vite server or choose CALI_CLIENT_PORT." >&2
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$CLIENT_PORT" -sTCP:LISTEN >&2 || true
  fi
  exit 1
fi

kill_tree() {
  local pid="$1"
  local child
  if ! kill -0 "$pid" 2>/dev/null; then
    return
  fi
  if command -v pgrep >/dev/null 2>&1; then
    while read -r child; do
      [ -n "$child" ] || continue
      kill_tree "$child"
    done < <(pgrep -P "$pid" 2>/dev/null || true)
  fi
  kill "$pid" 2>/dev/null || true
}

stop_tree() {
  local pid="$1"
  kill_tree "$pid"
  local attempts=0
  while kill -0 "$pid" 2>/dev/null && [ "$attempts" -lt 50 ]; do
    sleep 0.1
    attempts=$((attempts + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  local status="$?"
  trap - EXIT INT TERM
  if [ -n "$CLIENT_PID" ]; then
    stop_tree "$CLIENT_PID"
    wait "$CLIENT_PID" 2>/dev/null || true
  fi
  if [ -n "$CORE_PID" ]; then
    stop_tree "$CORE_PID"
    wait "$CORE_PID" 2>/dev/null || true
  fi
  if [ -n "$CORE_LISTENER_PID" ] && [ "$CORE_LISTENER_PID" != "$CORE_PID" ]; then
    stop_tree "$CORE_LISTENER_PID"
    wait "$CORE_LISTENER_PID" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [ ! -d "$ROOT/client/node_modules" ]; then
  (cd "$ROOT/client" && pnpm install)
fi

echo "==> Starting CaliCode core on 127.0.0.1:$CORE_PORT"
(
  cd "$ROOT/core"
  exec env CALI_PORT="$CORE_PORT" CALI_CLIENT_PORT="$CLIENT_PORT" cargo run
) &
CORE_PID=$!

echo "==> Waiting for core health"
ready=0
for _ in {1..100}; do
  if ! kill -0 "$CORE_PID" 2>/dev/null; then
    echo "Core exited before becoming ready. Check the startup error above." >&2
    exit 1
  fi
  if curl --fail --silent --show-error --max-time 1 "http://127.0.0.1:$CORE_PORT/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.2
done
if [ "$ready" -ne 1 ]; then
  echo "Core did not become ready on port $CORE_PORT within 20 seconds." >&2
  exit 1
fi

if command -v lsof >/dev/null 2>&1; then
  CORE_LISTENER_PID="$(lsof -t -nP -iTCP:"$CORE_PORT" -sTCP:LISTEN | awk 'NR == 1 { print; exit }')"
fi
echo "==> Core is ready; starting Vite on 127.0.0.1:$CLIENT_PORT"

cd "$ROOT/client"
env CALI_PORT="$CORE_PORT" CALI_CLIENT_PORT="$CLIENT_PORT" pnpm dev &
CLIENT_PID=$!
wait "$CLIENT_PID"
