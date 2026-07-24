#!/usr/bin/env bash
# mise task wrapper: ab <eval> <edited-path> [experiment=claude-sonnet-5].
# No args -> the readiness probe (which loops are runnable + how to fix gaps).
# Reorders to ab.sh's <eval> <experiment> <path>. For multiple edited
# files or other advanced use, call workspace/scripts/ab.sh directly.
set -euo pipefail
cd "$(dirname "$0")/../.."

[ $# -gt 0 ] || exec workspace/scripts/ab-ready.sh
[ $# -ge 2 ] || { echo "usage: mise run ab <eval> <edited-path> [experiment]  (no args = readiness probe)" >&2; exit 2; }
# A path in $3 means the caller tried multiple edited files — $3 is the
# EXPERIMENT slot here, and a path there would only fail after the paid sync.
if [ $# -ge 3 ] && [ -e "$3" ]; then
  echo "'$3' looks like an edited path, but the third argument is the experiment." >&2
  echo "for multiple edited files call the script directly:" >&2
  echo "  workspace/scripts/ab.sh $1 <experiment> $2 $3${4:+ ...}" >&2
  exit 2
fi
exec workspace/scripts/ab.sh "$1" "${3:-claude-sonnet-5}" "$2"
