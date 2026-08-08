#!/usr/bin/env bash
# Build (or dev-run) the CaliCode Tauri desktop app.
#
#   scripts/desktop.sh build   # package CaliCode.app + .dmg
#   scripts/desktop.sh dev     # run the native shell against a live core
#
# Staging steps shared by both modes:
#   1. Build the client bundle          -> client/dist
#   2. Build the core release binary     -> core/target/release/cali-core
#   3. Stage the core as a Tauri sidecar -> src-tauri/binaries/cali-core-<triple>
#   4. Stage the client bundle           -> src-tauri/resources/dist
set -euo pipefail

MODE="${1:-build}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_TAURI="$ROOT/client/src-tauri"

# Host target triple (e.g. aarch64-apple-darwin) — the suffix Tauri expects on
# an externalBin, and what the shell's dev-mode resolver looks for.
TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"

echo "==> Building client bundle"
(cd "$ROOT/client" && pnpm build)

echo "==> Building core release binary"
(cd "$ROOT/core" && cargo build --release)

echo "==> Staging core sidecar (cali-core-$TRIPLE)"
mkdir -p "$SRC_TAURI/binaries"
cp "$ROOT/core/target/release/cali-core" "$SRC_TAURI/binaries/cali-core-$TRIPLE"

echo "==> Staging client dist as a bundled resource"
rm -rf "$SRC_TAURI/resources/dist"
mkdir -p "$SRC_TAURI/resources"
cp -R "$ROOT/client/dist" "$SRC_TAURI/resources/dist"

if [ "$MODE" = "dev" ]; then
  echo "==> tauri dev"
  (cd "$ROOT/client" && pnpm tauri dev)
else
  echo "==> tauri build"
  (cd "$ROOT/client" && pnpm tauri build)
  echo ""
  echo "Done. Bundles are under:"
  echo "  $SRC_TAURI/target/release/bundle/macos/CaliCode.app"
  echo "  $SRC_TAURI/target/release/bundle/dmg/"
fi
