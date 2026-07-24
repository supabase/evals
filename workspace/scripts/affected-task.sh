#!/usr/bin/env bash
# Which evals does a change affect? Maps changed skill/docs/mcp paths to a
# ready-to-run eval command. e.g. mise run affected apps/docs/content/guides/auth/x.mdx
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"

cd apps/framework && exec node --import tsx/esm "$ROOT/workspace/scripts/affected.ts" "$@"
