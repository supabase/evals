#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
source workspace/scripts/docs-embed-env.sh

printf '%s\n' \
  'Full docs embedding rebuild' \
  'Model: text-embedding-ada-002 (1536 dimensions)' \
  'Rate: $0.10 per 1,000,000 input tokens; corpus cost is not known in advance.'
read -r -p "Type 'seed' to spend OpenAI credits and continue: " confirmation
if [ "$confirmation" != seed ]; then
  echo 'Seed cancelled.'
  exit 1
fi

(cd submodules/supabase/apps/docs && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm run embeddings:refresh)
node workspace/scripts/provenance.mjs --stamp-docs-index
