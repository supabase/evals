#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
source workspace/scripts/patches-lib.sh
SUPABASE_REMOTE="${SUPABASE_REMOTE:-$(repo_remote supabase)}"

if [ -e supabase/.git ]; then
  echo "supabase/ already cloned; refreshing sparse checkout"
elif [ -e supabase ]; then
  echo "ERROR: supabase/ exists but is not a Git clone" >&2
  exit 1
else
  git clone --filter=blob:none --no-checkout "$SUPABASE_REMOTE" supabase
  git -C supabase sparse-checkout init --cone
fi

git -C supabase sparse-checkout set \
  apps/docs \
  examples \
  packages/ai-commands packages/api-types packages/build-icons \
  packages/common packages/config packages/dev-tools \
  packages/eslint-config-supabase packages/icons packages/shared-data \
  packages/tsconfig packages/ui packages/ui-patterns \
  patches supabase

git -C supabase checkout
pnpm --dir supabase install --filter docs... --frozen-lockfile
