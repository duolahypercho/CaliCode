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
# An ad-hoc signature ("-") is keyed to the binary's hash, so macOS treats every
# rebuild as a different app and drops its TCC grants — the developer re-approves
# Desktop/Documents access after each build, and a shell spawned in a folder that
# is no longer granted blocks forever in getcwd() rather than failing. A stable
# local identity keeps the grant across rebuilds. Create one once with
# scripts/dev-signing-identity.sh; without it this falls back to ad-hoc.
LOCAL_SIGNING_IDENTITY="${CALI_SIGNING_IDENTITY:-CaliCode Dev}"
if [ -z "${CODESIGN_IDENTITY:-}" ] && [ -z "${APPLE_SIGNING_IDENTITY:-}" ] \
  && /usr/bin/security find-identity -v -p codesigning 2>/dev/null | grep -q "$LOCAL_SIGNING_IDENTITY"; then
  SIGNING_IDENTITY="$LOCAL_SIGNING_IDENTITY"
else
  SIGNING_IDENTITY="${CODESIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:--}}"
fi

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

sign_and_verify_app() {
  if [ "$(uname -s)" != "Darwin" ]; then
    return 0
  fi
  if [ ! -d "$1" ]; then
    echo "Built app not found at $1" >&2
    return 1
  fi
  echo "==> Signing and verifying $1"
  /usr/bin/codesign --force --deep --sign "$SIGNING_IDENTITY" "$1"
  /usr/bin/codesign --verify --deep --strict "$1"
}

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
  if ! (cd "$ROOT/client" && pnpm tauri build); then
    # create-dmg uses Finder AppleEvents only to position icons. Fresh shells,
    # CI runners, and locked-down Macs may deny that cosmetic automation even
    # though the signed app and disk image contents are valid. Preserve the
    # styled path when permission exists, then retry without Finder scripting.
    echo "==> Finder layout automation unavailable; retrying CI-safe DMG packaging" >&2
    (cd "$ROOT/client" && CI=true pnpm tauri build)
  fi
  # Tauri's ad-hoc linker signature does not seal Info.plist or resources.
  # Re-sign the exact built bundle so a plain desktop:build leaves a strict
  # verifiable app. A configured identity is preserved; '-' is for local dev.
  sign_and_verify_app "$BUILT_APP"

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

    sign_and_verify_app "$INSTALLED_APP"

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
