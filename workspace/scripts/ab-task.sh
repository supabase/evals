#!/usr/bin/env bash
# mise task wrapper: ab <eval> <edited-path> [experiment=claude-sonnet-5].
# No args -> the readiness probe (which loops are runnable + how to fix gaps).
# Reorders to scripts/ab.sh's <eval> <experiment> <path>. For multiple edited
# files or other advanced use, call scripts/ab.sh directly.
set -euo pipefail
cd "$(dirname "$0")/.."

[ $# -gt 0 ] || exec scripts/ab-ready.sh
[ $# -ge 2 ] || { echo "usage: mise run ab <eval> <edited-path> [experiment]  (no args = readiness probe)" >&2; exit 2; }
exec scripts/ab.sh "$1" "${3:-claude-sonnet-5}" "$2"
