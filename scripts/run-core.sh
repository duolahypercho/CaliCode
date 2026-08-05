#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../core"
exec ./target/debug/cali-core
