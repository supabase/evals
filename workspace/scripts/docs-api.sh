#!/usr/bin/env bash
# Serve the docs content GraphQL API locally (standalone adapter) for search_docs.
# Port + stack come from this worktree's docs profile (docs-profile.sh);
# point evals at it: SUPABASE_CONTENT_API_URL=$CONTENT_URL
set -euo pipefail
cd "$(dirname "$0")/../.."

source workspace/scripts/docs-profile.sh
source workspace/scripts/load-keys.sh
set -a
source submodules/supabase/apps/docs/.env.development
set +a
eval "$(supabase status --workdir "$CONTENT_WORKDIR" -o env)"
: "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"
# Runs the locally installed tsx binary directly (no `pnpm exec`: NODE_OPTIONS
# must reach only the server process — pnpm's own node chokes on the loader
# hook during pnpmfile probing). Entry path is relative to apps/docs (4 levels
# up to the evals root). The Sentry stub hook no-ops the route handler's
# telemetry calls (see sentry-stub.mjs).
STUB_REGISTER=$PWD/workspace/scripts/sentry-stub-register.mjs
cd submodules/supabase/apps/docs
[ -x node_modules/.bin/tsx ] || { echo "tsx not installed — run: mise run clone-docs" >&2; exit 1; }
PORT="$DOCS_API_PORT" \
NODE_ENV=development \
NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$PUBLISHABLE_KEY" \
OPENAI_API_KEY="$OPENAI_API_KEY" \
NODE_OPTIONS="--import $STUB_REGISTER${NODE_OPTIONS:+ $NODE_OPTIONS}" \
exec node_modules/.bin/tsx \
  --conditions=react-server \
  --tsconfig tsconfig.json \
  ../../../../workspace/scripts/docs-content-api.ts
