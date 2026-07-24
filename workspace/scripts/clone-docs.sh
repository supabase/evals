#!/usr/bin/env bash
# Seed the docs submodule (submodules/supabase): a sparse+partial checkout of
# the supabase monorepo (apps/docs + the packages it imports), pinned by the
# evals gitlink. ~90s / ~1GB instead of the multi-GB full monorepo.
#
# The submodule is deliberately `update = none` in .gitmodules: a recursive
# `git submodule update --init` (or a --recurse-submodules clone) would
# materialize the ENTIRE monorepo tree — sparse-checkout cannot be injected
# before the atomic clone+checkout. So this script owns the seed: clone
# without checkout, configure sparse, then an explicit checkout of the pin.
#
# Re-runs refresh the sparse path set only; they never move HEAD (your marker
# commits and local work stay put — pin bumps go through `mise run update`).
set -euo pipefail
cd "$(dirname "$0")/../.."

SUB=submodules/supabase
URL=${SUPABASE_REMOTE:-$(git config -f .gitmodules "submodule.$SUB.url")}

FRESH=0
if [ -e "$SUB/.git" ]; then
  echo "$SUB already seeded; refreshing sparse checkout"
else
  FRESH=1
  # the gitlink placeholder is an empty dir on fresh checkouts; clone into it
  git clone --filter=blob:none --no-checkout "$URL" "$SUB"
  git -C "$SUB" sparse-checkout init --cone
fi

git -C "$SUB" sparse-checkout set \
  apps/docs \
  examples \
  packages/ai-commands packages/api-types packages/build-icons \
  packages/common packages/config packages/dev-tools \
  packages/eslint-config-supabase packages/icons packages/shared-data \
  packages/tsconfig packages/ui packages/ui-patterns \
  patches supabase

if [ "$FRESH" = 1 ]; then
  # check out exactly the pinned SHA (blob filter fetches content on demand)
  WANT=$(git rev-parse "HEAD:$SUB")
  git -C "$SUB" cat-file -e "$WANT^{commit}" 2>/dev/null || git -C "$SUB" fetch -q origin "$WANT"
  git -C "$SUB" checkout -q "$WANT"
  echo "seeded $SUB at $(git -C "$SUB" rev-parse --short HEAD) (the evals pin)"
fi

# corepack: the monorepo pins its own pnpm (packageManager) — see docs-api.sh
(cd "$SUB" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --filter docs... --frozen-lockfile)
