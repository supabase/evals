#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
source workspace/scripts/docs-embed-env.sh

# corepack: the docs monorepo pins its own pnpm (packageManager), newer than
# evals' mise-pinned pnpm — see docs-api.sh
(cd submodules/supabase/apps/docs && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm run embeddings)
node workspace/scripts/provenance.mjs --stamp-docs-index
