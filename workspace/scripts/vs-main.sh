#!/usr/bin/env bash
# Treatment-only screen: run eval(s) in YOUR edited world and diff against the
# latest published result on evals main (the bot refreshes of
# apps/web/src/data/{regression-,}eval-results.json).
#
# No baseline arm, no stashes, no git mutation anywhere — safe to run from
# multiple sessions/worktrees at once. Docs edits additionally want this
# worktree's own stack (workspace/scripts/docs-isolate.sh) when other sessions
# also run docs; mcp/skills edits are per-worktree by construction.
#
# The published arm ran in the scheduled CI world (published mcp package, prod
# docs index, model state at refresh time). A flip here is a SCREEN, not
# causal proof — confirm with a paired A/B (mise run ab) before claiming
# causality. The receipt records the exact published provenance available:
# result commit, its parent (the harness revision the scheduled run merged
# onto), commit time, experiment, and attempts.
#
# usage: workspace/scripts/vs-main.sh <eval-id> [<eval-id>...] [--experiment <id>] [--runs N]
#   default experiment: claude-code-sonnet-5 (the refreshed suites' flagship)
#   default runs: the published row's attempts (usually 1)
#
# VSMAIN_EVAL_CMD / VSMAIN_NO_FETCH / VSMAIN_SKIP_SYNC: test hooks (vs-main.test.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."

EXP=claude-code-sonnet-5; RUNS=""; COMPARE=1; EVALS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --experiment) EXP="${2:?--experiment needs a value}"; shift 2 ;;
    --runs) RUNS="${2:?--runs needs a value}"; shift 2 ;;
    --no-compare) COMPARE=0; shift ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) EVALS+=("$1"); shift ;;
  esac
done
[ ${#EVALS[@]} -gt 0 ] || { echo "usage: workspace/scripts/vs-main.sh <eval-id> [...] [--experiment <id>] [--runs N] [--no-compare]" >&2; exit 2; }

for k in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY; do
  v="$(security find-generic-password -a "$USER" -s "eval-workspace:$k" -w 2>/dev/null || true)"
  [ -n "$v" ] && export "$k=$v"
done

OUT=results-vs-main; mkdir -p "$OUT"

# --- resolve published baselines (free; refuses before any spend) ---
# --no-compare: skip entirely — run YOUR world with the same sync/receipts,
# no published row required (custom evals aren't in the published set).
if [ "$COMPARE" = 1 ]; then
[ -n "${VSMAIN_NO_FETCH:-}" ] || git fetch -q origin main
EXP="$EXP" OUT="$OUT" node - "${EVALS[@]}" <<'EOF'
const fs = require("fs");
const { execFileSync } = require("child_process");
const { EXP, OUT } = process.env;
const evals = process.argv.slice(2);
const files = [
  "apps/web/src/data/regression-eval-results.json",
  "apps/web/src/data/eval-results.json",
];
const best = {};       // eval -> {row, meta} freshest matching row
const seen = {};       // eval -> Set(experiments) for the refusal message
for (const f of files) {
  let rows;
  try { rows = JSON.parse(execFileSync("git", ["show", `origin/main:${f}`], { maxBuffer: 1 << 28 }).toString()); }
  catch { continue; }
  const [commit, parent, committedAt] =
    execFileSync("git", ["log", "origin/main", "-1", "--format=%H %P %cI", "--", f]).toString().trim().split(" ");
  for (const r of rows) {
    if (!evals.includes(r.eval)) continue;
    (seen[r.eval] ??= new Set()).add(r.experiment);
    if (r.experiment !== EXP) continue;
    const meta = { file: f, commit, parent, committedAt };
    if (!best[r.eval] || new Date(committedAt) > new Date(best[r.eval].meta.committedAt))
      best[r.eval] = { row: r, meta };
  }
}
let missing = false;
for (const e of evals) {
  if (!best[e]) {
    missing = true;
    const alts = [...(seen[e] ?? [])];
    console.error(alts.length
      ? `no published ${EXP} result for ${e} on origin/main (published experiments: ${alts.join(", ")})`
      : `no published result for ${e} on origin/main at all — vs-main needs a published baseline; use mise run ab`);
    continue;
  }
  const { row, meta } = best[e];
  fs.writeFileSync(`${OUT}/${e}.published.json`, JSON.stringify({ ...row, vsMainBaseline: meta }, null, 1) + "\n");
}
process.exit(missing ? 1 : 0);
EOF
fi

# --- zero-cost eval validation (same gate as ab.sh) ---
if [ -z "${VSMAIN_EVAL_CMD:-}" ]; then
  : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY not in keychain — see README}"
  for e in "${EVALS[@]}"; do
    [ -f "evals/$e/PROMPT.md" ] || { echo "no eval at evals/$e (PROMPT.md missing)" >&2; exit 1; }
    ( cd apps/framework && exec pnpm exec tsx -e "
      import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
      import { readFileSync } from 'node:fs';
      parseEvalMarkdown(readFileSync('../../evals/' + process.argv[1] + '/PROMPT.md', 'utf8'), 'evals/' + process.argv[1] + '/PROMPT.md');
    " "$e" ) || { echo "eval metadata invalid — fix evals/$e/PROMPT.md before spending on runs" >&2; exit 1; }
  done
fi

# --- sync YOUR world, treatment only: no reverts, nothing to restore ---
MCP="$PWD/submodules/mcp/packages/mcp-server-supabase"
source workspace/scripts/docs-profile.sh
RUN_ENV=(); DIRTY=()
if [ -z "${VSMAIN_SKIP_SYNC:-}" ]; then
  if [ -e submodules/mcp/.git ] && [ -n "$(git -C submodules/mcp status --porcelain)" ]; then
    DIRTY+=(mcp)
    echo "== mcp tree dirty: building local server =="
    ( cd submodules/mcp && pnpm build )
    RUN_ENV+=( "SUPABASE_MCP_SERVER_PATH=$MCP" )
  fi
  if [ -e submodules/supabase/.git ] && [ -n "$(git -C submodules/supabase status --porcelain -- apps/docs/content)" ]; then
    DIRTY+=(docs)
    : "${OPENAI_API_KEY:?OPENAI_API_KEY not in keychain — the docs re-embed needs it}"
    curl -sf -o /dev/null "$CONTENT_URL" || { echo "docs-api not reachable on :$DOCS_API_PORT — run \`mise run docs-api\` in another terminal first (isolated worktrees: workspace/scripts/docs-isolate.sh, then docs-up + docs-copy-index)" >&2; exit 1; }
    pages=$(docker exec "$CONTENT_DB_CONTAINER" psql -U postgres -d postgres -tAc 'select count(*) from public.page' 2>/dev/null || echo 0)
    [ "${pages:-0}" -gt 0 ] 2>/dev/null || { echo "docs index is not seeded (page count: ${pages:-0}) — mise run docs-seed, or free from a sibling: workspace/scripts/docs-copy-index.sh" >&2; exit 1; }
    [ -d "$MCP/dist" ] || { echo "building local mcp (needed for search_docs routing)…"; ( cd submodules/mcp && pnpm install && pnpm build ); }
    echo "== docs tree dirty: re-embedding changed pages =="
    workspace/scripts/docs-index.sh
    RUN_ENV+=( "SUPABASE_MCP_SERVER_PATH=$MCP" "SUPABASE_CONTENT_API_URL=$CONTENT_URL" )
  fi
  if [ -e submodules/agent-skills/.git ] && [ -n "$(git -C submodules/agent-skills status --porcelain)" ]; then
    DIRTY+=(skills)   # read live via symlink; no sync step
  fi
  if [ ${#DIRTY[@]} -eq 0 ]; then
    [ "$COMPARE" = 1 ] && echo "note: no local edits detected in submodules/{mcp,supabase/apps/docs/content,agent-skills} — this compares your pinned world against published" \
                       || echo "note: no local edits detected in submodules/{mcp,supabase/apps/docs/content,agent-skills} — this runs your pinned world as-is"
  fi
fi

# --- run treatment + report, one eval at a time ---
FAILED=0
for e in "${EVALS[@]}"; do
  runs="$RUNS"
  # published attempts drive the default only in compare mode (a stale
  # published.json from an earlier compare run must not leak in)
  [ -n "$runs" ] || { [ "$COMPARE" = 1 ] && runs=$(node -pe 'require(`./${process.env.OUT}/${process.argv[1]}.published.json`).attempts || 1' "$e" 2>/dev/null) || true; }
  [ -n "$runs" ] || runs=1
  RES="results/$EXP/$e.json"
  echo "== treatment: $e ($EXP, runs=$runs, edits: ${DIRTY[*]:-none}) =="
  if [ -n "${VSMAIN_EVAL_CMD:-}" ]; then
    RES="$RES" EVAL="$e" bash -c "$VSMAIN_EVAL_CMD"
  else
    env ${RUN_ENV[@]+"${RUN_ENV[@]}"} pnpm eval --eval "$e" --experiment "$EXP" --runs "$runs" || { echo "eval run failed: $e" >&2; FAILED=1; continue; }
  fi
  [ -f "$RES" ] || { echo "no result at $RES — check the eval/experiment ids" >&2; FAILED=1; continue; }
  cp "$RES" "$OUT/$e.treatment.json"
  env ${RUN_ENV[@]+"${RUN_ENV[@]}"} node workspace/scripts/provenance.mjs --embed "$OUT/$e.treatment.json"

  EVAL="$e" EXP="$EXP" OUT="$OUT" DIRTY="${DIRTY[*]:-none}" COMPARE="$COMPARE" node -e '
const path=require("path");
const f=(p)=>{try{return require(path.resolve(p))}catch{return null}};
const {EVAL,EXP,OUT,DIRTY,COMPARE}=process.env;
const b=COMPARE==="1"?f(`${OUT}/${EVAL}.published.json`):null, t=f(`${OUT}/${EVAL}.treatment.json`);
const chk=(r)=>{const c=(r&&r.checks)||[];return `${c.filter(x=>x&&x.passed).length}/${c.length}`};
const row=(l,r,extra)=>`${l.padEnd(10)} passed=${String(r&&r.passed).padEnd(5)} checks=${chk(r).padEnd(6)} docs.calls=${String(((r&&r.docs&&r.docs.calls)||[]).length).padEnd(3)} ${extra||""}`;
console.log(`\n=== vs-main: ${EVAL} (${EXP}) ===`);
if (b) {
  const m=b.vsMainBaseline||{};
  const age=m.committedAt?Math.round((Date.now()-new Date(m.committedAt))/864e5):"?";
  console.log(row("published",b,`main@${(m.commit||"").slice(0,7)} ${String(m.committedAt||"").slice(0,10)} (${age}d old, attempts ${b&&b.attempts})`));
  console.log(row("treatment",t,`your world (edits: ${DIRTY})`));
  const d=((t&&t.passed)?1:0)-((b&&b.passed)?1:0);
  console.log(d>0?"-> IMPROVED vs published (FAIL->PASS)":d<0?"-> REGRESSED vs published (PASS->FAIL)":"-> no pass/fail change (compare checks / docs.calls)");
  console.log(`screen only: the published arm ran in the scheduled CI world — confirm causal claims with: mise run ab ${EVAL} <edited-path>`);
  console.log(`saved: ${OUT}/${EVAL}.{published,treatment}.json`);
} else {
  console.log(row("treatment",t,`your world (edits: ${DIRTY})`));
  console.log(`no comparison (--no-compare): result + provenance receipt only`);
  console.log(`saved: ${OUT}/${EVAL}.treatment.json`);
}
'
done
exit "$FAILED"
