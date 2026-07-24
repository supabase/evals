#!/usr/bin/env bash
# A/B readiness probe: which loops can you head-to-head right now, what's
# missing, and the exact command to fix each gap. `mise run ab` with no args
# lands here. Read-only; never mutates anything.
set -euo pipefail
cd "$(dirname "$0")/../.."

NEXT=""
ok()   { printf '  [ok] %s\n' "$1"; }
miss() { printf '  [--] %s\n' "$1"; NEXT="${NEXT}  $2\n"; }
have_key() { security find-generic-password -a "$USER" -s "eval-workspace:$1" >/dev/null 2>&1 || { [ -f .env ] && grep -qE "^$1=.+" .env; }; }

echo "A/B readiness — mise run ab <eval-id> <edited-path> [experiment=claude-sonnet-5]"

echo
echo "skills loop (edit submodules/agent-skills/skills/…):"
if [ -e submodules/agent-skills/.git ]; then ok "agent-skills submodule initialized"; else miss "agent-skills submodule not initialized" "mise run setup"; fi
if have_key ANTHROPIC_API_KEY; then ok "ANTHROPIC_API_KEY present"; else miss "ANTHROPIC_API_KEY missing" "mise run store-key ANTHROPIC_API_KEY"; fi

echo
echo "mcp loop (edit submodules/mcp/packages/…):"
if [ -e submodules/mcp/.git ] && [ -d submodules/mcp/packages/mcp-server-supabase/dist ]; then
  ok "local mcp submodule initialized + built"
else
  miss "local mcp submodule not initialized/built" "mise run mcp-build"
fi

echo
echo "docs loop (edit submodules/supabase/apps/docs/content/… pages):"
if [ -e submodules/supabase/.git ]; then ok "supabase (apps/docs) cloned"; else miss "supabase not cloned" "mise run clone-docs"; fi
if docker exec supabase_db_eval-workspace-content true 2>/dev/null; then
  ok "content DB running"
  pages=$(docker exec supabase_db_eval-workspace-content psql -U postgres -d postgres -tAc 'select count(*) from public.page' 2>/dev/null || echo 0)
  if [ "${pages:-0}" -gt 0 ] 2>/dev/null; then ok "index seeded ($pages pages)"; else miss "index empty" "mise run docs-seed   # one-time full embed (OpenAI \$; asks to confirm)"; fi
else
  miss "content DB not running" "mise run docs-up"
fi
if curl -sf -o /dev/null http://127.0.0.1:3001/docs/api/graphql; then ok "docs-api serving :3001"; else miss "docs-api not serving" "mise run docs-api   # keep it running in a separate terminal"; fi
if have_key OPENAI_API_KEY; then ok "OPENAI_API_KEY present"; else miss "OPENAI_API_KEY missing" "mise run store-key OPENAI_API_KEY"; fi

echo
if [ -n "$NEXT" ]; then
  echo "Next (for the loop you want):"
  printf '%b' "$NEXT" | awk '!seen[$0]++'
else
  echo "All loops ready."
fi
echo
echo "Then: make ONE edit (tracked file, unstaged), pick an eval (ls evals/), run:"
echo "  mise run ab <eval-id> <edited-path>"
echo "Wiring self-test (free): mise run ab-test · guided live demo: mise run ab-demo"
