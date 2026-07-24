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

for r in $PATCH_REPOS; do
  test_guard_in "$r"
done

# The docs gitlink must record an UPSTREAM sha, never a local [eval-workspace-*]
# plumbing commit: markers can't be pushed (guard above), so a marker gitlink
# makes every cold seed unfetchable ("upload-pack: not our ref"). `ignore = all`
# hides gitlink changes from status but not from an explicit `git add` — this
# is the check that catches that accident. Skipped when the submodule isn't
# seeded (the sha can't be inspected without a clone).
DOCS_SUB=$(repo_dir supabase)
if [ -e "$DOCS_SUB/.git" ]; then
  _pin=$(git rev-parse "HEAD:$DOCS_SUB" 2>/dev/null || echo "")
  if [ -n "$_pin" ] && git -C "$DOCS_SUB" cat-file -e "$_pin^{commit}" 2>/dev/null; then
    _subj=$(git -C "$DOCS_SUB" log -1 --format=%s "$_pin")
    case "$_subj" in
      "[eval-workspace-"*) ck "docs gitlink: pinned at upstream (not a marker)" "marker: $_subj" "upstream" ;;
      *)                   ck "docs gitlink: pinned at upstream (not a marker)" "upstream" "upstream" ;;
    esac
  fi
fi

# Receipt coverage: every configured submodule's pin must appear (derived
# from git, so a new submodule can't silently drop out), and patch-carrying
# repos must carry working-tree records — per-arm A/B receipts differ by
# exactly the edit under test only if the working tree is recorded.
_receipt=$(node workspace/scripts/provenance.mjs 2>/dev/null || echo '{}')
ck "receipt: docs submodule pin recorded" \
   "$(printf '%s' "$_receipt" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);console.log(/^[0-9a-f]{40}$/.test(r.submodules?.supabase||"")?"y":"n")})')" "y"
ck "receipt: patch repos carry tree records" \
   "$(printf '%s' "$_receipt" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);console.log(("supabase" in (r.repos||{}))&&("mcp" in (r.repos||{}))?"y":"n")})')" "y"

echo "hooks.test: $pass passed, $fail failed"
if [ "$pass" -eq 0 ] && [ "$fail" -eq 0 ]; then
  echo "hooks.test: 0 checks ran (no patched repo present — run: mise run setup)" >&2
  exit 1
fi
[ "$fail" -eq 0 ]
