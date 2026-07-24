#!/usr/bin/env bash
# Serve the docs content GraphQL API locally (standalone adapter) for search_docs.
# Point evals at it: SUPABASE_CONTENT_API_URL=http://127.0.0.1:3001/docs/api/graphql
set -euo pipefail
cd "$(dirname "$0")/../.."

source workspace/scripts/load-keys.sh
set -a
source submodules/supabase/apps/docs/.env.development
set +a
eval "$(supabase status --workdir submodules/supabase -o env)"
: "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"
# corepack, cwd inside the submodule: the docs monorepo pins its OWN pnpm
# (packageManager, 11.x) which differs from evals' mise-pinned pnpm — corepack
# resolves the nearest packageManager upward from cwd. Entry path is relative
# to apps/docs (4 levels up to the evals root). The Sentry stub hook no-ops
# the route handler's telemetry calls (see sentry-stub.mjs).
STUB_REGISTER=$PWD/workspace/scripts/sentry-stub-register.mjs
cd submodules/supabase/apps/docs
NODE_ENV=development \
NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$PUBLISHABLE_KEY" \
OPENAI_API_KEY="$OPENAI_API_KEY" \
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
NODE_OPTIONS="--import $STUB_REGISTER${NODE_OPTIONS:+ $NODE_OPTIONS}" \
exec corepack pnpm exec tsx \
  --conditions=react-server \
  --tsconfig tsconfig.json \
  ../../../../workspace/scripts/docs-content-api.ts
