#!/usr/bin/env bash
set -euo pipefail
kit_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$kit_root/scripts/run.mjs" "$@"
