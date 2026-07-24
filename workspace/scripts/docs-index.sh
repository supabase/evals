#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
source workspace/scripts/docs-embed-env.sh

pnpm --dir supabase/apps/docs run embeddings
node workspace/scripts/provenance.mjs --stamp-docs-index
