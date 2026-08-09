#!/usr/bin/env bash
# Build (or dev-run) the CaliCode Tauri desktop app.
#
#   scripts/desktop.sh build    # package CaliCode.app + .dmg
#   scripts/desktop.sh install  # build, update /Applications, and relaunch
#   scripts/desktop.sh dev      # run the native shell against a live core
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
BUILT_APP="$SRC_TAURI/target/release/bundle/macos/CaliCode.app"
INSTALLED_APP="/Applications/CaliCode.app"

case "$MODE" in
  build|dev|install) ;;
  *)
    echo "Usage: $0 {build|dev|install}" >&2
    exit 2
    ;;
esac

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
mkdir -p "$SRC_TAURI/resources"
/usr/bin/ditto "$ROOT/client/dist" "$SRC_TAURI/resources/dist"

if [ "$MODE" = "dev" ]; then
  echo "==> tauri dev"
  (cd "$ROOT/client" && pnpm tauri dev)
else
  echo "==> tauri build"
  (cd "$ROOT/client" && pnpm tauri build)

  if [ "$MODE" = "install" ]; then
    if [ "$(uname -s)" != "Darwin" ]; then
      echo "desktop:install is only supported on macOS." >&2
      exit 1
    fi
    if [ ! -w "/Applications" ]; then
      echo "Cannot update $INSTALLED_APP because /Applications is not writable." >&2
      exit 1
    fi

    if pgrep -f "$INSTALLED_APP/Contents/MacOS/app" >/dev/null; then
      echo "==> Quitting the installed CaliCode app"
      /usr/bin/osascript -e 'tell application id "com.calicode.desktop" to quit'
      for _ in {1..50}; do
        pgrep -f "$INSTALLED_APP/Contents/MacOS/app" >/dev/null || break
        sleep 0.1
      done
      if pgrep -f "$INSTALLED_APP/Contents/MacOS/app" >/dev/null; then
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

    # Development builds do not have a distribution certificate. An ad-hoc
    # bundle signature still seals Info.plist and all resources, preventing
    # macOS from rejecting an app whose files were copied incompletely.
    echo "==> Signing and verifying the installed app"
    /usr/bin/codesign --force --deep --sign - "$INSTALLED_APP"
    /usr/bin/codesign --verify --deep --strict "$INSTALLED_APP"

    echo "==> Opening CaliCode"
    /usr/bin/open "$INSTALLED_APP"
    echo "Updated and opened $INSTALLED_APP"
  else
    echo ""
    echo "Done. Bundles are under:"
    echo "  $BUILT_APP"
    echo "  $SRC_TAURI/target/release/bundle/dmg/"
  fi
fi
