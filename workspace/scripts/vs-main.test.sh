#!/usr/bin/env bash
# Zero-cost self-test of vs-main.sh: fakes the eval run (VSMAIN_EVAL_CMD),
# reads REAL published baselines from origin/main (no fetch, no model spend,
# no docker). Requires origin/main to exist locally (any clone has it).
set -euo pipefail
cd "$(dirname "$0")/../.."

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 (want[$3] got[$2])"; fi; }

export VSMAIN_NO_FETCH=1 VSMAIN_SKIP_SYNC=1

# a real published eval id (regression suite; stable) — resolved dynamically so
# the test doesn't rot when the published set changes
EVAL=$(node -pe 'JSON.parse(require("child_process").execFileSync("git",["show","origin/main:apps/web/src/data/regression-eval-results.json"],{maxBuffer:1<<28})).find(r=>r.experiment==="claude-code-sonnet-5").eval')

# --- unknown eval refused pre-spend, nonzero exit ---
out=$(bash workspace/scripts/vs-main.sh no-such-eval-xyz 2>&1; echo "rc=$?")
ck "unknown eval refused" "$(printf '%s' "$out" | grep -c 'no published result for no-such-eval-xyz')" "1"
ck "unknown eval exits nonzero" "$(printf '%s' "$out" | grep -c 'rc=1')" "1"

# --- unknown experiment lists the published ones ---
out=$(bash workspace/scripts/vs-main.sh "$EVAL" --experiment bogus-model 2>&1; echo "rc=$?")
ck "unknown experiment refused" "$(printf '%s' "$out" | grep -c "no published bogus-model result for $EVAL")" "1"
ck "alternatives listed" "$(printf '%s' "$out" | grep -c 'published experiments:.*claude-code-sonnet-5')" "1"

# --- happy path: fake eval run -> delta table + receipts ---
export VSMAIN_EVAL_CMD='mkdir -p "$(dirname "$RES")"; printf "{\"eval\":\"%s\",\"experiment\":\"claude-code-sonnet-5\",\"passed\":true,\"checks\":[{\"name\":\"x\",\"passed\":true}]}" "$EVAL" > "$RES"'
out=$(bash workspace/scripts/vs-main.sh "$EVAL" 2>&1; echo "rc=$?")
ck "delta table printed" "$(printf '%s' "$out" | grep -c "=== vs-main: $EVAL")" "1"
ck "published row shown" "$(printf '%s' "$out" | grep -c '^published .*main@')" "1"
ck "treatment row shown" "$(printf '%s' "$out" | grep -c '^treatment ')" "1"
ck "screen caveat present" "$(printf '%s' "$out" | grep -c 'screen only:')" "1"
ck "happy path exits zero" "$(printf '%s' "$out" | grep -c 'rc=0')" "1"
ck "published receipt has commit" "$(FORCE_COLOR=0 node -pe 'const b=require("./results-vs-main/"+process.argv[1]+".published.json"); /^[0-9a-f]{40}$/.test(b.vsMainBaseline.commit)?1:0' "$EVAL")" "1"
ck "treatment receipt has provenance" "$(FORCE_COLOR=0 node -pe 'require("./results-vs-main/"+process.argv[1]+".treatment.json").provenance?1:0' "$EVAL")" "1"
EVAL2=$(node -pe 'const rows=JSON.parse(require("child_process").execFileSync("git",["show","origin/main:apps/web/src/data/eval-results.json"],{maxBuffer:1<<28})); rows.filter(r=>r.experiment==="claude-code-sonnet-5").map(r=>r.eval).find(e=>e!==process.argv[1])' "$EVAL")
out=$(bash workspace/scripts/vs-main.sh "$EVAL" "$EVAL2" 2>&1; echo "rc=$?")
ck "batch runs both" "$(printf '%s' "$out" | grep -c '=== vs-main: ')" "2"
ck "batch exits zero" "$(printf '%s' "$out" | grep -c 'rc=0')" "1"

rm -f "results-vs-main/$EVAL".*.json "results-vs-main/$EVAL2".*.json "results/claude-code-sonnet-5/$EVAL.json" "results/claude-code-sonnet-5/$EVAL2.json"
echo "vs-main.test: $pass passed, $fail failed"
[ "$fail" = 0 ]
