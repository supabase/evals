#!/usr/bin/env bash
# Serve the docs content GraphQL API locally (standalone adapter) for search_docs.
# Point evals at it: SUPABASE_CONTENT_API_URL=http://127.0.0.1:3001/docs/api/graphql
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/load-keys.sh
set -a
source supabase/apps/docs/.env.development
set +a
eval "$(supabase status --workdir supabase -o env)"
: "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"
NODE_ENV=development \
NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$PUBLISHABLE_KEY" \
OPENAI_API_KEY="$OPENAI_API_KEY" \
exec pnpm --dir supabase/apps/docs exec tsx \
  --conditions=react-server \
  --tsconfig tsconfig.json \
  ../../../scripts/docs-content-api.ts
