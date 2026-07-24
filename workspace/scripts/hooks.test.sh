#!/usr/bin/env bash
# Self-test for the pre-push guard lifecycle (install / chain / reinstall).
# Uses the mcp clone's hooks dir — .git internals only, repo content untouched;
# every fixture is removed and the real guard is reinstalled at the end.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -e mcp/.git ] || { echo "SKIP: mcp not cloned"; exit 0; }
HOOKS=$(git -C mcp rev-parse --path-format=absolute --git-path hooks)
HOOK="$HOOKS/pre-push"
CHAINED="$HOOKS/pre-push.eval-workspace-chained"
[ ! -e "$CHAINED" ] || { echo "SKIP: $CHAINED already exists (real chained hook — not touching it)"; exit 0; }

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 (want[$3] got[$2])"; fi; }
cleanup() { rm -f "$CHAINED"; scripts/apply-patches.sh >/dev/null 2>&1 || true; }
trap cleanup EXIT

# baseline: generated guard present
scripts/apply-patches.sh >/dev/null
ck "guard installed" "$(grep -c 'eval-workspace pre-push guard' "$HOOK")" "1"

# foreign hook appears -> next install chains it
printf '#!/usr/bin/env bash\n# foreign hook one\nexit 0\n' > "$HOOK"; chmod +x "$HOOK"
scripts/apply-patches.sh >/dev/null 2>&1
ck "foreign hook chained"     "$(grep -c 'foreign hook one' "$CHAINED" 2>/dev/null || echo 0)" "1"
ck "guard reinstalled"        "$(grep -c 'eval-workspace pre-push guard' "$HOOK")" "1"

# a DIFFERENT foreign hook overwrites the generated guard -> reinstall must
# refuse rather than silently clobber the previously chained hook
printf '#!/usr/bin/env bash\n# foreign hook two\nexit 0\n' > "$HOOK"; chmod +x "$HOOK"
rc=$(scripts/apply-patches.sh >/dev/null 2>&1; echo $?)
ck "reinstall refuses to clobber chained" "$rc" "1"
ck "chained hook one preserved" "$(grep -c 'foreign hook one' "$CHAINED")" "1"
ck "foreign hook two preserved" "$(grep -c 'foreign hook two' "$HOOK")" "1"

# identical foreign hook (e.g. re-copied) -> harmless, install proceeds
cp "$CHAINED" "$HOOK"
rc=$(scripts/apply-patches.sh >/dev/null 2>&1; echo $?)
ck "identical foreign re-chain ok" "$rc" "0"
ck "guard active again" "$(grep -c 'eval-workspace pre-push guard' "$HOOK")" "1"

echo "hooks.test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
