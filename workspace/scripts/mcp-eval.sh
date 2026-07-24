#!/usr/bin/env bash
# Run evals against the local mcp build (mise task `mcp-eval` builds it first).
# Add SUPABASE_CONTENT_API_URL=<url> for a local docs index (Phase 2).
set -euo pipefail
cd "$(dirname "$0")/../.."

SUPABASE_MCP_SERVER_PATH="submodules/mcp/packages/mcp-server-supabase" exec workspace/scripts/eval.sh "$@"
