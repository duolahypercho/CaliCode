#!/usr/bin/env bash
# Build (or dev-run) the CaliCode desktop app.
#
#   scripts/desktop.sh build    # package CaliCode.app
#   scripts/desktop.sh install  # build, update /Applications, and relaunch
#   scripts/desktop.sh dev      # run the shell against a live core
#
# Staging steps shared by both modes:
#   1. Build the client bundle        -> client/dist
#   2. Build the core release binary  -> core/target/release/cali-core
#   3. Compile the Electron shell     -> client/dist-electron
#   4. electron-builder stages 1 and 2 as extraResources (electron-builder.yml)
set -euo pipefail

MODE="${1:-build}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_DIR="$ROOT/client/release-electron"
INSTALLED_APP="/Applications/CaliCode.app"
# An ad-hoc signature ("-") is keyed to the binary's hash, so macOS treats every
# rebuild as a different app and drops its TCC grants — the developer re-approves
# Desktop/Documents access after each build, and a shell spawned in a folder that
# is no longer granted blocks forever in getcwd() rather than failing. A stable
# local identity keeps the grant across rebuilds. Create one once with
# scripts/dev-signing-identity.sh; without it this falls back to unsigned.
LOCAL_SIGNING_IDENTITY="${CALI_SIGNING_IDENTITY:-CaliCode Dev}"

case "$MODE" in
  build|dev|install) ;;
  *)
    echo "Usage: $0 {build|dev|install}" >&2
    exit 2
    ;;
esac

if [ "$MODE" = "dev" ]; then
  echo "==> Electron shell against the live core"
  exec env -C "$ROOT/client" pnpm desktop:electron
fi

echo "==> Building client bundle"
(cd "$ROOT/client" && pnpm build)

echo "==> Building core release binary"
(cd "$ROOT/core" && cargo build --release)

echo "==> Compiling the Electron shell"
(cd "$ROOT/client" && pnpm build:electron)

# Signing is electron-builder's job, not a post-hoc `codesign --deep`: an Electron
# bundle has nested helper apps and a framework that must be signed inside-out,
# and --deep signs them in the wrong order often enough to produce a bundle that
# launches once and then fails Gatekeeper.
if /usr/bin/security find-identity -v -p codesigning 2>/dev/null | grep -q "$LOCAL_SIGNING_IDENTITY"; then
  echo "==> Signing as '$LOCAL_SIGNING_IDENTITY'"
  export CSC_NAME="$LOCAL_SIGNING_IDENTITY"
else
  echo "==> No '$LOCAL_SIGNING_IDENTITY' identity; building unsigned"
  echo "    (scripts/dev-signing-identity.sh creates one; without it macOS drops"
  echo "     the app's Desktop/Documents grants on every rebuild)"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi

echo "==> electron-builder"
(cd "$ROOT/client" && pnpm exec electron-builder --config electron-builder.yml --mac dir)

# `--mac dir` writes mac-arm64/ or mac/ depending on the host arch.
BUILT_APP="$(find "$RELEASE_DIR" -maxdepth 2 -name 'CaliCode.app' -print -quit)"
if [ -z "$BUILT_APP" ]; then
  echo "Built app not found under $RELEASE_DIR" >&2
  exit 1
fi

if [ "$MODE" = "install" ]; then
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "desktop:install is only supported on macOS." >&2
    exit 1
  fi
  if [ ! -w "/Applications" ]; then
    echo "Cannot update $INSTALLED_APP because /Applications is not writable." >&2
    exit 1
  fi

  if pgrep -f "$INSTALLED_APP/Contents/MacOS/CaliCode" >/dev/null; then
    echo "==> Quitting the installed CaliCode app"
    /usr/bin/osascript -e 'tell application id "com.calicode.desktop" to quit'
    for _ in {1..50}; do
      pgrep -f "$INSTALLED_APP/Contents/MacOS/CaliCode" >/dev/null || break
      sleep 0.1
    done
    if pgrep -f "$INSTALLED_APP/Contents/MacOS/CaliCode" >/dev/null; then
      echo "CaliCode is still running. Quit it and run desktop:install again." >&2
      exit 1
    fi
  fi

  if lsof -nP -iTCP:8765 -sTCP:LISTEN >/dev/null; then
    echo "Port 8765 is already in use. Stop the existing CaliCode dev/core process and run desktop:install again." >&2
    lsof -nP -iTCP:8765 -sTCP:LISTEN >&2
    exit 1
  fi

  echo "==> Updating $INSTALLED_APP"
  /usr/bin/ditto "$BUILT_APP" "$INSTALLED_APP"

  echo "==> Opening CaliCode"
  /usr/bin/open "$INSTALLED_APP"
  echo "Updated and opened $INSTALLED_APP"
else
  echo ""
  echo "Done. Bundle is at:"
  echo "  $BUILT_APP"
fi
