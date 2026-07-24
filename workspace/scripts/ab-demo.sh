#!/usr/bin/env bash
# Guided, self-cleaning LIVE demonstration of the docs A/B loop — the fastest
# way to see (and trust) the whole mechanism:
#
#   1. plants an un-guessable fact in ONE local docs page: a fictional package
#      `@supabase/pinniped` for the fictional "Nimbus" runtime (append-only edit)
#   2. installs a matching throwaway eval (demo/canary-eval/) that PASSES only
#      if the agent names that package
#   3. runs the real head-to-head (workspace/scripts/ab.sh): treatment (fact
#      embedded in the local index) vs baseline (fact removed + re-embedded)
#   4. expected result: baseline FAIL 0/1 -> treatment PASS 1/1 — proof that a
#      local docs edit alone moves an eval through search_docs
#   5. cleans up completely: guide reverted, canary de-embedded, eval removed
#
# Cost: 2 model runs (claude-sonnet-5) + a few embedding cents. Asks first.
set -euo pipefail
cd "$(dirname "$0")/../.."

GUIDE=submodules/supabase/apps/docs/content/guides/auth/choosing-a-server-package.mdx
EVAL_ID=investigate-workspace-canary-nimbus-package
EVAL_DST=evals/$EVAL_ID

fail() { echo "not ready: $1" >&2; echo "run \`mise run ab\` (no args) for the readiness probe + fix commands" >&2; exit 1; }

# --- keys: direct keychain reads (load-keys can be flaky in foreground shells) ---
for k in ANTHROPIC_API_KEY OPENAI_API_KEY; do
  v="$(security find-generic-password -a "$USER" -s "eval-workspace:$k" -w 2>/dev/null || true)"
  [ -n "$v" ] && export "$k=$v"
done

# --- hard preflight (same gates the A/B itself needs) ---
[ -e submodules/supabase/.git ] || fail "supabase not cloned"
[ -n "${ANTHROPIC_API_KEY:-}" ] || fail "ANTHROPIC_API_KEY missing"
[ -n "${OPENAI_API_KEY:-}" ] || fail "OPENAI_API_KEY missing"
docker exec supabase_db_eval-workspace-content true 2>/dev/null || fail "content DB not running"
pages=$(docker exec supabase_db_eval-workspace-content psql -U postgres -d postgres -tAc 'select count(*) from public.page' 2>/dev/null || echo 0)
[ "${pages:-0}" -gt 0 ] 2>/dev/null || fail "docs index not seeded"
curl -sf -o /dev/null http://127.0.0.1:3001/docs/api/graphql || fail "docs-api not serving on :3001"
git -C submodules/supabase diff --quiet -- "${GUIDE#supabase/}" || fail "demo guide has local edits (demo needs a clean file): ${GUIDE}"
[ ! -e "$EVAL_DST" ] || fail "$EVAL_DST already exists — remove it first"

echo "This runs a live A/B: 2 claude-sonnet-5 runs + a few embedding cents, ~3-5 min."
read -r -p "Type 'demo' to proceed: " confirmation
[ "$confirmation" = demo ] || { echo "cancelled."; exit 0; }

# --- plant the canary (append-only; reverted by the cleanup trap) ---
cleanup() {
  echo "== demo cleanup: reverting canary, de-embedding, removing throwaway eval =="
  git -C submodules/supabase checkout -- "${GUIDE#supabase/}" 2>/dev/null || true
  rm -rf "$EVAL_DST"
  workspace/scripts/docs-index.sh >/dev/null 2>&1 \
    || echo "WARNING: cleanup re-embed failed — run \`mise run docs-index\` to de-embed the canary" >&2
}
trap cleanup EXIT

cat >> "$GUIDE" <<'EOF'

## Nimbus workers

- You're on a **Supabase-managed cron/queue worker** (the internal "Nimbus" runtime) → use **`@supabase/pinniped`**, the dedicated helper for Nimbus workers.
EOF
mkdir -p "$EVAL_DST"
cp demo/canary-eval/PROMPT.md demo/canary-eval/EVAL.ts "$EVAL_DST/"

echo "== canary planted in $GUIDE; running the head-to-head =="
workspace/scripts/ab.sh "$EVAL_ID" claude-sonnet-5 "$GUIDE"

echo
echo "What you just saw: the ONLY difference between the two runs was that one"
echo "local docs page contained the planted fact. treatment PASS + baseline FAIL"
echo "means the agent found it via search_docs against YOUR local index — the"
echo "edit->embed->eval loop works end to end. Results: results-ab/$EVAL_ID.*.json"
