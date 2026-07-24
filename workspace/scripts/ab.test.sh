#!/usr/bin/env bash
# Zero-cost integration test for workspace/scripts/ab.sh. Fakes the eval via
# AB_EVAL_CMD (no model, no OpenAI, no services) and proves: the scoped
# stash/restore + result copy + comparison work, AND the selected edit and
# index are byte-identical after the run — including when a run fails mid-A/B
# (trap must restore).
#
# SAFETY: only ever touches a tracked skill file that is currently CLEAN (no
# working-tree or staged changes); it never checks out a file with your edits.
# If no clean skill file exists it fails with an actionable message rather
# than passing vacuously. Skills loop → sync is a no-op, so
# nothing else in the workspace is affected. Run: bash workspace/scripts/ab.test.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

SK=submodules/agent-skills
[ -e "$SK/.git" ] || { echo "ab.test: 0 checks ran — agent-skills submodule not initialized (run: mise run setup)" >&2; exit 1; }

# pick a tracked SKILL.md with NO local changes, so restoring it can't lose work
REL=""
for c in $(git -C "$SK" ls-files 'skills/*/SKILL.md'); do
  if git -C "$SK" diff --quiet -- "$c" && git -C "$SK" diff --cached --quiet -- "$c"; then REL="$c"; break; fi
done
[ -n "$REL" ] || { echo "ab.test: 0 checks ran — no CLEAN tracked skill file to test with" >&2; exit 1; }
FILE="$SK/$REL"
EVAL=ab-selftest; EXP=claude-sonnet-5
RES="results/$EXP/$EVAL.json"

# only now (after selecting a clean file) arm cleanup: revert our own edit, drop fixtures
MCP=submodules/mcp
MCPREL=packages/mcp-server-supabase/src/transports/stdio.ts
MCP_MUTATED=0   # cleanup may only revert $MCPREL if THIS test wrote to it — a
                # user's own unstaged edit there skips the fixture block below,
                # and must survive the run untouched.
cleanup() {
  git -C "$SK" checkout -q -- "$REL" 2>/dev/null || true
  [ "$MCP_MUTATED" = 1 ] && git -C "$MCP" checkout -q -- "$MCPREL" 2>/dev/null || true
  rm -f "$RES" "results-ab/$EVAL".*.json
}
trap cleanup EXIT

# fake eval: treatment passes, baseline fails; hard-fail baseline if AB_FAIL_BASELINE set.
FAKE='mkdir -p "$(dirname "$RES")"; if [ "$AB_LABEL" = baseline ] && [ -n "${AB_FAIL_BASELINE:-}" ]; then exit 7; fi; if [ "$AB_LABEL" = treatment ]; then p=true; else p=false; fi; printf "{\"passed\":%s,\"checks\":[{\"name\":\"x\",\"passed\":%s}],\"docs\":{\"calls\":[1,2]}}" "$p" "$p" > "$RES"'

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 (want[$3] got[$2])"; fi; }

# make an unstaged edit on the clean file
printf '\n<!-- ab-selftest edit -->\n' >> "$FILE"
edited=$(git -C "$SK" hash-object "$REL")
index0=$(git -C "$SK" diff --cached -- "$REL")   # empty (was clean)

# observable sync hook: every sync appends a line (treatment, baseline, restore = 3)
CNT=/tmp/ab_selftest_sync.cnt
SYNC="echo x >> $CNT"

# --- happy path ---
: > "$CNT"
ANTHROPIC_API_KEY=dummy AB_EVAL_CMD="$FAKE" AB_SYNC_CMD="$SYNC" bash workspace/scripts/ab.sh "$EVAL" "$EXP" "$FILE" >/tmp/ab_selftest.out 2>&1 \
  || { echo "FAIL: ab exited nonzero (happy path)"; sed 's/^/  /' /tmp/ab_selftest.out; fail=$((fail+1)); }
ck "edit preserved after success"    "$(git -C "$SK" hash-object "$REL")" "$edited"
ck "index untouched after success"   "$(git -C "$SK" diff --cached -- "$REL")" "$index0"
ck "treatment result copied"         "$([ -f "results-ab/$EVAL.treatment.json" ] && echo y || echo n)" "y"
ck "baseline result copied"          "$([ -f "results-ab/$EVAL.baseline.json" ] && echo y || echo n)" "y"
ck "reports IMPROVED (FAIL->PASS)"   "$(grep -c 'IMPROVED' /tmp/ab_selftest.out)" "1"
ck "checks rendered (treatment 1/1)" "$(grep -c 'treatment.*checks=1/1' /tmp/ab_selftest.out)" "1"
ck "sync ran 3x (incl. post-restore)" "$(wc -l < "$CNT" | tr -d ' ')" "3"

# --- failure path: baseline dies AFTER stash; ab's trap must restore the edit AND re-sync ---
: > "$CNT"
AB_FAIL_BASELINE=1 ANTHROPIC_API_KEY=dummy AB_EVAL_CMD="$FAKE" AB_SYNC_CMD="$SYNC" bash workspace/scripts/ab.sh "$EVAL" "$EXP" "$FILE" >/tmp/ab_selftest2.out 2>&1 || true
ck "edit restored after mid-run failure" "$(git -C "$SK" hash-object "$REL")" "$edited"
ck "index untouched after failure"       "$(git -C "$SK" diff --cached -- "$REL")" "$index0"
ck "trap re-synced after failure (3x)"   "$(wc -l < "$CNT" | tr -d ' ')" "3"
ck "failure exit status preserved"       "$(AB_FAIL_BASELINE=1 ANTHROPIC_API_KEY=dummy AB_EVAL_CMD="$FAKE" AB_SYNC_CMD="$SYNC" bash workspace/scripts/ab.sh "$EVAL" "$EXP" "$FILE" >/dev/null 2>&1; echo $?)" "7"

# --- restore-sync fails (3rd sync): must fail the run, keep the edit, skip the report ---
: > "$CNT"
SYNC_FAIL3="echo x >> $CNT; [ \$(wc -l < $CNT) -lt 3 ] || { echo sync3-boom >&2; exit 9; }"
rc3=$(ANTHROPIC_API_KEY=dummy AB_EVAL_CMD="$FAKE" AB_SYNC_CMD="$SYNC_FAIL3" bash workspace/scripts/ab.sh "$EVAL" "$EXP" "$FILE" >/tmp/ab_selftest3.out 2>&1; echo $?)
ck "restore-sync failure fails the run"    "$([ "$rc3" -ne 0 ] && echo nonzero || echo zero)" "nonzero"
ck "edit intact after restore-sync failure" "$(git -C "$SK" hash-object "$REL")" "$edited"
ck "reports re-sync error"                 "$(grep -c 'post-restore re-sync failed' /tmp/ab_selftest3.out)" "1"
ck "no A/B report on failed restore"       "$(grep -c '=== A/B' /tmp/ab_selftest3.out)" "0"

# --- docs loop must reject a second path outside the content scope ---
rc4=$(AB_DRYRUN=1 bash workspace/scripts/ab.sh e x supabase/apps/docs/content/a.mdx supabase/apps/studio/foo.ts >/dev/null 2>&1; echo $?)
ck "rejects non-content path in docs loop" "$rc4" "2"

# --- dirty clone index (e.g. intent-to-add residue) must be refused before stashing ---
echo probe > "$SK/.ab-selftest-idx-probe"
git -C "$SK" add -N .ab-selftest-idx-probe
rc5=$(ANTHROPIC_API_KEY=dummy AB_EVAL_CMD="$FAKE" AB_SYNC_CMD="$SYNC" bash workspace/scripts/ab.sh "$EVAL" "$EXP" "$FILE" >/tmp/ab_selftest5.out 2>&1; echo $?)
git -C "$SK" reset -q -- .ab-selftest-idx-probe && rm -f "$SK/.ab-selftest-idx-probe"
ck "refuses dirty clone index"       "$rc5" "1"
ck "explains staged-index refusal"   "$(grep -c 'staged changes' /tmp/ab_selftest5.out)" "1"

# --- patch-owned file A/B (the commit model's core win): an unstaged edit on a
# file the mcp enabler patch owns must A/B cleanly, and the plumbing marker
# commit must be untouched on both success and mid-run failure ---
if [ -e "$MCP/.git" ] && git -C "$MCP" diff --quiet -- "$MCPREL" && git -C "$MCP" diff --cached --quiet --ita-visible-in-index; then
  marker0=$(git -C "$MCP" rev-parse HEAD)
  MCP_MUTATED=1
  printf '\n// ab-selftest edit\n' >> "$MCP/$MCPREL"
  edited2=$(git -C "$MCP" hash-object "$MCPREL")
  ANTHROPIC_API_KEY=dummy AB_EVAL_CMD="$FAKE" AB_SYNC_CMD="$SYNC" bash workspace/scripts/ab.sh "$EVAL" "$EXP" "$MCP/$MCPREL" >/tmp/ab_selftest6.out 2>&1 \
    || { echo "FAIL: patch-owned A/B exited nonzero"; sed 's/^/  /' /tmp/ab_selftest6.out; fail=$((fail+1)); }
  ck "patch-owned: edit preserved"              "$(git -C "$MCP" hash-object "$MCPREL")" "$edited2"
  ck "patch-owned: marker commit intact"        "$(git -C "$MCP" rev-parse HEAD)" "$marker0"
  AB_FAIL_BASELINE=1 ANTHROPIC_API_KEY=dummy AB_EVAL_CMD="$FAKE" AB_SYNC_CMD="$SYNC" bash workspace/scripts/ab.sh "$EVAL" "$EXP" "$MCP/$MCPREL" >/dev/null 2>&1 || true
  ck "patch-owned: edit restored after failure" "$(git -C "$MCP" hash-object "$MCPREL")" "$edited2"
  ck "patch-owned: marker intact after failure" "$(git -C "$MCP" rev-parse HEAD)" "$marker0"
  git -C "$MCP" checkout -q -- "$MCPREL"
else
  echo "SKIP: mcp not initialized/clean — patch-owned A/B regression not run"
fi

echo "ab.test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
