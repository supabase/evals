# Shared preamble for the paid docs-embed paths (docs-index.sh, docs-seed.sh):
# fail-closed patch check, key loading, docs env, local-stack credentials, and
# the OpenAI preflight. Source from the repo root (the callers cd there first);
# not executable on its own.
if ! git -C supabase apply --reverse --check "$PWD/workspace/patches/supabase-docs-index-fail-closed.patch" 2>/dev/null; then
  echo 'ERROR: fail-closed index patch is not applied; run workspace/scripts/apply-patches.sh' >&2
  exit 1
fi

source workspace/scripts/load-keys.sh
set -a
source supabase/apps/docs/.env.development
set +a
eval "$(supabase status --workdir supabase -o env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$PUBLISHABLE_KEY"
export SUPABASE_SECRET_KEY="$SECRET_KEY"
: "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"
workspace/scripts/openai-preflight.sh   # fail fast if the key can't run embeddings
# Deliberately allow embedding without prod-only sources (e.g. lint-warnings,
# which needs DOCS_GITHUB_APP_*). Sources gate their own skip on this flag.
export DOCS_EMBED_ALLOW_MISSING_SOURCES=1
