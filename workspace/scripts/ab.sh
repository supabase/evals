#!/usr/bin/env bash
# Head-to-head eval: baseline (your edit reverted) vs treatment (edit applied).
# Same eval, same experiment; the ONLY difference is your uncommitted edit.
#
# Usage: workspace/scripts/ab.sh <eval-id> <experiment> <edited-path> [more-paths...]
#   <edited-path> is a file inside a clone; its clone selects the loop + how to
#   re-sync between states:
#     submodules/supabase/apps/docs/content/…   docs loop   (re-embed via docs-index; needs `mise run docs-api` up)
#     submodules/mcp/…               mcp loop    (rebuild the local server)
#     submodules/agent-skills/…      skills loop (no re-sync; read live via symlink)
#
# The enabler patches live as [eval-workspace-*] commits below your work (see
# apply-patches.sh), so your unstaged edit is the ONLY working diff — stashing
# it for baseline can't disturb the plumbing, even on patch-owned files.
#
# Sync steps keep their normal exit semantics: if docs-index or the mcp build
# fails, the A/B aborts (and the restore trap puts your edit back). No special
# tolerance — a failing sync means the states can't be trusted.
#
# AB_DRYRUN=1 prints the resolved plan and exits (no runs, no side effects).
# AB_EVAL_CMD / AB_SYNC_CMD override the eval / sync step (testing; see ab.test.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."

[ $# -ge 3 ] || { echo "usage: workspace/scripts/ab.sh <eval-id> <experiment> <edited-path> [more-paths...]" >&2; exit 2; }
EVAL="$1"; EXP="$2"; shift 2
PATHS=("$@")

# --- keys: direct keychain reads (robust vs load-keys foreground flakiness) ---
for k in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY; do
  v="$(security find-generic-password -a "$USER" -s "eval-workspace:$k" -w 2>/dev/null || true)"
  [ -n "$v" ] && export "$k=$v"
done

# --- clone + loop from the first path ---
case "${PATHS[0]}" in
  submodules/supabase/apps/docs/content/*) LOOP=docs;   CLONE=submodules/supabase;                STRIP=submodules/supabase/;                PREFIX=submodules/supabase/apps/docs/content/ ;;
  submodules/supabase/apps/docs/*)         echo "docs A/B works on content pages (submodules/supabase/apps/docs/content/…) — other docs files aren't part of the embed loop: ${PATHS[0]}" >&2; exit 2 ;;
  submodules/mcp/*)             LOOP=mcp;    CLONE=submodules/mcp;          STRIP=submodules/mcp/;          PREFIX=submodules/mcp/ ;;
  submodules/agent-skills/*)    LOOP=skills; CLONE=submodules/agent-skills; STRIP=submodules/agent-skills/; PREFIX=submodules/agent-skills/ ;;
  *) echo "path must be under submodules/supabase/apps/docs/content/, submodules/mcp/, or submodules/agent-skills/: ${PATHS[0]}" >&2; exit 2 ;;
esac

# every path must live in this loop's editable scope; build clone-relative paths
REL=()
for p in "${PATHS[@]}"; do
  case "$p" in
    "$PREFIX"*) REL+=("${p#$STRIP}") ;;
    *) echo "all paths must be under $PREFIX (the loop chosen by ${PATHS[0]}): $p" >&2; exit 2 ;;
  esac
done

MCP="$PWD/submodules/mcp/packages/mcp-server-supabase"
CONTENT_URL="http://127.0.0.1:3001/docs/api/graphql"  # also in affected.ts / docs-api.sh / workspace README — keep in sync
RUN_ENV=()
case "$LOOP" in
  docs) RUN_ENV=( "SUPABASE_MCP_SERVER_PATH=$MCP" "SUPABASE_CONTENT_API_URL=$CONTENT_URL" ) ;;
  mcp)  RUN_ENV=( "SUPABASE_MCP_SERVER_PATH=$MCP" ) ;;
esac

sync() {
  if [ -n "${AB_SYNC_CMD:-}" ]; then bash -c "$AB_SYNC_CMD"; return; fi   # override/test hook
  case "$LOOP" in
    docs)   workspace/scripts/docs-index.sh ;;
    mcp)    ( cd submodules/mcp && pnpm build ) ;;
    skills) : ;;
  esac
}

if [ -n "${AB_DRYRUN:-}" ]; then
  echo "eval=$EVAL experiment=$EXP loop=$LOOP clone=$CLONE"
  echo "revert paths: ${REL[*]}"
  echo "run env: ${RUN_ENV[*]:-(none)}"
  exit 0
fi

: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY not in keychain — see README}"
# A previous run killed mid-baseline (SIGKILL beats any trap) leaves the edit
# in a stash marked with AB_STASH_MSG. Detect it BEFORE the no-unstaged-edit
# check below turns that into a cryptic "nothing to A/B". Print the EXACT
# stash ref: a plain `stash pop` takes the newest stash, which may be the
# user's own unrelated work sitting above the stranded one.
AB_STASH_MSG="eval-workspace ab baseline stash"
# `|| :` guards set -e/pipefail: no match (the normal case) exits grep nonzero
_stranded=$(git -C "$CLONE" stash list --format='%gd %gs' | grep -F "$AB_STASH_MSG" | awk '{print $1}' | sort -t'{' -k2 -rn) || _stranded=""
if [ -n "$_stranded" ]; then
  echo "a previous A/B was interrupted mid-baseline — your edit is stranded in a stash." >&2
  echo "recover it (exact ref; highest index first so the others keep their refs), then re-run:" >&2
  for _ref in $_stranded; do
    echo "  git -C $CLONE stash pop '$_ref'" >&2
  done
  echo "  mise run ab $EVAL ${PATHS[0]}   # (docs edits: the pop leaves the index at baseline until the next run re-embeds)" >&2
  exit 1
fi
unset _stranded

# Zero-cost eval validation BEFORE any paid sync: a schema/typo error used to
# surface only at harness discovery — after the treatment re-embed had spent.
# Skipped under the AB_EVAL_CMD test hook (no real eval dir exists there).
if [ -z "${AB_EVAL_CMD:-}" ]; then
  [ -f "evals/$EVAL/PROMPT.md" ] || { echo "no eval at evals/$EVAL (PROMPT.md missing)" >&2; exit 1; }
  ( cd apps/framework && exec pnpm exec tsx -e "
    import { parseEvalMarkdown } from '@supabase-evals/core/eval-markdown';
    import { readFileSync } from 'node:fs';
    parseEvalMarkdown(readFileSync('../../evals/' + process.argv[1] + '/PROMPT.md', 'utf8'), 'evals/' + process.argv[1] + '/PROMPT.md');
  " "$EVAL" ) || { echo "eval metadata invalid — fix evals/$EVAL/PROMPT.md before spending on runs" >&2; exit 1; }
fi
# A/B reverts tracked, unstaged working-tree edits only, via a scoped git stash.
# `stash push -- <path>` merges whole-index state, so ANY staged entry in the
# clone (even an unrelated intent-to-add) breaks it. Require a clean index.
git -C "$CLONE" diff --cached --quiet --ita-visible-in-index \
  || { echo "the $CLONE index has staged changes (see: git -C $CLONE status) — unstage them first; ab's scoped stash needs a clean index" >&2; exit 1; }
for r in "${REL[@]}"; do
  git -C "$CLONE" ls-files --error-unmatch -- "$r" >/dev/null 2>&1 \
    || { echo "not a tracked file in $CLONE: $r (ab reverts tracked edits; commit a brand-new file first, or revert it by hand)" >&2; exit 1; }
  if git -C "$CLONE" diff --quiet -- "$r"; then
    echo "no unstaged edit at $r (nothing to A/B)" >&2; exit 1
  fi
done


if [ "$LOOP" = docs ]; then
  : "${OPENAI_API_KEY:?OPENAI_API_KEY not in keychain — the docs re-embed needs it}"
  curl -sf -o /dev/null "$CONTENT_URL" || { echo "docs-api not reachable on :3001 — run \`mise run docs-api\` in another terminal first" >&2; exit 1; }
  # Refuse BEFORE spending: an empty-but-running DB would otherwise turn the
  # treatment sync into a full paid seed instead of an incremental re-embed.
  pages=$(docker exec supabase_db_eval-workspace-content psql -U postgres -d postgres -tAc 'select count(*) from public.page' 2>/dev/null || echo 0)
  [ "${pages:-0}" -gt 0 ] 2>/dev/null || { echo "docs index is not seeded (page count: ${pages:-0}) — run \`mise run docs-seed\` once first (mise run ab with no args = full readiness probe)" >&2; exit 1; }
  [ -d "$MCP/dist" ] || { echo "building local mcp (needed for search_docs routing)…"; ( cd submodules/mcp && pnpm install && pnpm build ); }
fi

RES="results/$EXP/$EVAL.json"
OUT="results-ab"; mkdir -p "$OUT"

run_eval() { # $1 = label
  sync
  if [ -n "${AB_EVAL_CMD:-}" ]; then
    RES="$RES" AB_LABEL="$1" bash -c "$AB_EVAL_CMD"          # override/test hook; must write $RES
  else
    env ${RUN_ENV[@]+"${RUN_ENV[@]}"} pnpm eval --eval "$EVAL" --experiment "$EXP" --runs 1
  fi
  [ -f "$RES" ] || { echo "no result at $RES — check the eval/experiment ids" >&2; exit 1; }
  cp "$RES" "$OUT/$EVAL.$1.json"
  # per-arm receipt: capture provenance AFTER this arm's sync, so baseline and
  # treatment records differ by exactly the edit under test (report-only).
  # Same env as the run itself, or the receipt would claim mcp_override: null
  # while the eval actually ran against the local build.
  env ${RUN_ENV[@]+"${RUN_ENV[@]}"} node workspace/scripts/provenance.mjs --embed "$OUT/$EVAL.$1.json"
}

# Restoration is ONE idempotent path: pop the stash AND re-sync, so the index/
# build never stays at baseline while the tree shows treatment. The EXIT trap
# runs it on any post-stash failure, preserving the original exit status.
STASHED=0
restore() {
  [ "$STASHED" = 1 ] || return 0
  echo "== restoring edit =="
  if git -C "$CLONE" stash pop -q; then
    STASHED=0
  else
    echo "ERROR: stash pop failed — your edit is in: git -C $CLONE stash list" >&2
    return 1
  fi
  if ! sync; then
    echo "ERROR: post-restore re-sync failed — the index/build does not reflect your edit (docs: workspace/scripts/docs-index.sh; mcp: pnpm -C submodules/mcp build)" >&2
    return 1
  fi
}
# Preserve the run's own failure status; a clean run that fails cleanup exits nonzero.
trap 'rc=$?; if ! restore && [ "$rc" -eq 0 ]; then rc=1; fi; exit $rc' EXIT
# Catchable signals route through `exit`, so the EXIT trap restores exactly
# once (never attach restore to the signals directly: signal + EXIT would
# double-pop). SIGKILL is uncatchable — that case is covered by the marked
# stash + the preflight detection above.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

echo "== treatment: edit applied (${PATHS[*]}) =="
run_eval treatment

echo "== reverting edit for baseline =="
git -C "$CLONE" stash push -q -m "$AB_STASH_MSG" -- "${REL[@]}"
STASHED=1

echo "== baseline: edit reverted =="
run_eval baseline

restore   # pop + re-sync now; the EXIT trap becomes a no-op

EVAL="$EVAL" EXP="$EXP" OUT="$OUT" node -e '
const path=require("path");
const f=(p)=>{try{return require(path.resolve(p))}catch{return null}};
const {EVAL,EXP,OUT}=process.env;
const b=f(`${OUT}/${EVAL}.baseline.json`), t=f(`${OUT}/${EVAL}.treatment.json`);
const chk=(r)=>{const c=(r&&r.checks)||[];return `${c.filter(x=>x&&x.passed).length}/${c.length}`};
const row=(l,r)=>`${l.padEnd(10)} passed=${String(r&&r.passed).padEnd(5)} checks=${chk(r).padEnd(6)} docs.calls=${((r&&r.docs&&r.docs.calls)||[]).length}`;
console.log(`\n=== A/B: ${EVAL} (${EXP}) ===`);
console.log(row("baseline",b));
console.log(row("treatment",t));
const d=((t&&t.passed)?1:0)-((b&&b.passed)?1:0);
console.log(d>0?"\n-> edit IMPROVED the eval (FAIL->PASS)":d<0?"\n-> edit REGRESSED the eval (PASS->FAIL)":"\n-> no pass/fail change (compare checks / docs.calls above)");
console.log(`saved: ${OUT}/${EVAL}.{baseline,treatment}.json`);
'
