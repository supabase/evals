#!/usr/bin/env bash
# Run evals against the local mcp build (mise task `mcp-eval` builds it first).
# Add SUPABASE_CONTENT_API_URL=<url> for a local docs index (Phase 2).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

[ -e evals/.env ] || { echo "evals/.env missing — run: mise run setup" >&2; exit 1; }
source scripts/load-keys.sh
cd evals && SUPABASE_MCP_SERVER_PATH="$ROOT/mcp/packages/mcp-server-supabase" pnpm eval "$@"
