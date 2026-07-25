#!/usr/bin/env bash
# Copy a seeded docs index (page + page_section, embeddings + checksums) from
# another local stack's DB container into THIS worktree's. Zero OpenAI spend:
# the checksums come along, so the next docs-index re-embeds only your edits.
#
# usage: workspace/scripts/docs-copy-index.sh [source-container]
#        default source: the primary worktree's supabase_db_eval-workspace-content
set -euo pipefail
cd "$(dirname "$0")/../.."
source workspace/scripts/docs-profile.sh

src="${1:-supabase_db_eval-workspace-content}"
dst="$CONTENT_DB_CONTAINER"
[ "$src" != "$dst" ] || { echo "source and destination are the same container ($dst) — pass a sibling's container name" >&2; exit 1; }
docker exec "$src" true 2>/dev/null || { echo "source container not running: $src (docs-up in that worktree first, or pass another source)" >&2; exit 1; }
docker exec "$dst" true 2>/dev/null || { echo "this worktree's stack is not running: $dst — run: mise run docs-up" >&2; exit 1; }

pages=$(docker exec "$src" psql -U postgres -d postgres -tAc 'select count(*) from public.page')
[ "${pages:-0}" -gt 0 ] || { echo "source index is empty ($src) — nothing to copy" >&2; exit 1; }

# dump to a temp file (a straight pipe would hide a mid-stream pg_dump failure)
tmp=$(mktemp /tmp/docs-index-copy.XXXXXX.sql)
trap 'rm -f "$tmp"' EXIT
docker exec "$src" pg_dump -U postgres -d postgres --data-only -t public.page -t public.page_section > "$tmp"

docker exec "$dst" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
  -c 'TRUNCATE public.page, public.page_section RESTART IDENTITY CASCADE'
docker exec -i "$dst" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$tmp"
docker exec "$dst" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "
  select setval(pg_get_serial_sequence('public.page','id'), coalesce(max(id),1)) from public.page;
  select setval(pg_get_serial_sequence('public.page_section','id'), coalesce(max(id),1)) from public.page_section;"

got=$(docker exec "$dst" psql -U postgres -d postgres -tAc 'select count(*) from public.page')
[ "$got" = "$pages" ] || { echo "copy incomplete: source $pages pages, destination $got" >&2; exit 1; }
echo "copied $got pages -> $dst (\$0.00 — the next docs-index re-embeds only pages your tree changed)"
