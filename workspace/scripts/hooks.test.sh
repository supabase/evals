#!/usr/bin/env bash
# Self-test for the pre-push guard lifecycle (install / chain / reinstall).
# Exercises the guard in every publishable repo present locally — the
# supabase clone and the mcp submodule working tree. .git internals only,
# repo content untouched; every fixture is removed and the real guard
# reinstalled at the end. A repo that isn't cloned/initialized, or that
# already has a real chained hook, is skipped for that repo only.
set -euo pipefail
cd "$(dirname "$0")/../.."
source workspace/scripts/patches-lib.sh

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 (want[$3] got[$2])"; fi; }

CHAINED_PATHS=()
cleanup() { for c in ${CHAINED_PATHS[@]+"${CHAINED_PATHS[@]}"}; do rm -f "$c"; done; workspace/scripts/apply-patches.sh >/dev/null 2>&1 || true; }
trap cleanup EXIT

test_guard_in() {
  local repo="$1" dir hooks hook chained rc
  dir=$(repo_dir "$repo")
  [ -e "$dir/.git" ] || { echo "SKIP $repo: $dir not present"; return 0; }
  hooks=$(git -C "$dir" rev-parse --path-format=absolute --git-path hooks)
  hook="$hooks/pre-push"
  chained="$hooks/pre-push.eval-workspace-chained"
  [ ! -e "$chained" ] || { echo "SKIP $repo: $chained already exists (real chained hook — not touching it)"; return 0; }
  CHAINED_PATHS+=("$chained")

  # baseline: generated guard present
  workspace/scripts/apply-patches.sh >/dev/null
  ck "$repo: guard installed" "$(grep -c 'eval-workspace pre-push guard' "$hook")" "1"

  # foreign hook appears -> next install chains it
  printf '#!/usr/bin/env bash\n# foreign hook one\nexit 0\n' > "$hook"; chmod +x "$hook"
  workspace/scripts/apply-patches.sh >/dev/null 2>&1
  ck "$repo: foreign hook chained" "$(grep -c 'foreign hook one' "$chained" 2>/dev/null || echo 0)" "1"
  ck "$repo: guard reinstalled"    "$(grep -c 'eval-workspace pre-push guard' "$hook")" "1"

  # a DIFFERENT foreign hook overwrites the generated guard -> reinstall must
  # refuse rather than silently clobber the previously chained hook
  printf '#!/usr/bin/env bash\n# foreign hook two\nexit 0\n' > "$hook"; chmod +x "$hook"
  rc=$(workspace/scripts/apply-patches.sh >/dev/null 2>&1; echo $?)
  ck "$repo: reinstall refuses to clobber chained" "$rc" "1"
  ck "$repo: chained hook one preserved" "$(grep -c 'foreign hook one' "$chained")" "1"
  ck "$repo: foreign hook two preserved" "$(grep -c 'foreign hook two' "$hook")" "1"

  # identical foreign hook (e.g. re-copied) -> harmless, install proceeds
  cp "$chained" "$hook"
  rc=$(workspace/scripts/apply-patches.sh >/dev/null 2>&1; echo $?)
  ck "$repo: identical foreign re-chain ok" "$rc" "0"
  ck "$repo: guard active again" "$(grep -c 'eval-workspace pre-push guard' "$hook")" "1"
}

for r in $PUBLISH_REPOS; do
  test_guard_in "$r"
done

echo "hooks.test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
