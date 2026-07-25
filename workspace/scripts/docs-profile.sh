# Per-worktree docs stack identity — source me from the repo root.
# The primary worktree uses the docs submodule itself as the supabase workdir
# (config.toml pinned by the ports patch: slot 0). An isolated worktree (see
# docs-isolate.sh) carries an UNTRACKED overlay workdir with its own project
# id + port block, so its containers, DB, and docs-api never touch another
# session's — and no user tree is ever modified.
# Sets: CONTENT_WORKDIR, CONTENT_PROJECT_ID, CONTENT_DB_CONTAINER,
#       CONTENT_API_PORT, DOCS_API_PORT, CONTENT_URL
if [ -f workspace/.docs-stack/supabase/config.toml ]; then
  CONTENT_WORKDIR=workspace/.docs-stack
else
  CONTENT_WORKDIR=submodules/supabase
fi
_cfg="$CONTENT_WORKDIR/supabase/config.toml"
CONTENT_PROJECT_ID=$(sed -n 's/^project_id = "\(.*\)"$/\1/p' "$_cfg" 2>/dev/null | head -1)
CONTENT_API_PORT=$(sed -n 's/^port = \(55[0-9][0-9][0-9]\)$/\1/p' "$_cfg" 2>/dev/null | head -1)
# fall back to the primary defaults when the submodule isn't cloned yet
CONTENT_PROJECT_ID="${CONTENT_PROJECT_ID:-eval-workspace-content}"
CONTENT_API_PORT="${CONTENT_API_PORT:-55321}"
CONTENT_DB_CONTAINER="supabase_db_${CONTENT_PROJECT_ID}"
# slot 0 (primary, 55321) -> 3001; slot k (55321+100k) -> 3001+k
DOCS_API_PORT=$(( 3001 + (CONTENT_API_PORT - 55321) / 100 ))
CONTENT_URL="http://127.0.0.1:${DOCS_API_PORT}/docs/api/graphql"
unset _cfg
