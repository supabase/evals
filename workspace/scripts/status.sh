#!/usr/bin/env bash
# Workspace status: host repo + submodule + clone state, env keys present, tooling.
set -euo pipefail

cd "$(dirname "$0")/../.."

# --json: machine-readable provenance receipt (host, submodules, repos, patches, docs stamp)
if [ "${1:-}" = "--json" ]; then exec node workspace/scripts/provenance.mjs; fi
source workspace/scripts/patches-lib.sh

# label, dir, [missing-message]. `.git` is a dir for clones and a file for
# submodules, so -e covers both.
repo_status() {
  local label="$1" dir="$2" missing="${3:-not cloned}" branch sha dirty
  if [ ! -e "$dir/.git" ]; then
    printf '  %-22s %s\n' "$label" "$missing"
    return
  fi
  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
  sha=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo '?')
  if [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then dirty=dirty; else dirty=clean; fi
  printf '  %-22s %-22s %-10s %s\n' "$label" "$branch" "$sha" "$dirty"
}

NEXT=""
echo "Repos:"
# The host repo is this checkout itself (evals); agent-skills and mcp are its
# two pinned submodules (hand-nested rows); supabase is the only opt-in clone.
repo_status "evals (host)" "."
repo_status "  - agent-skills" "$(repo_dir skills)" "not initialized"
repo_status "  - mcp" "$(repo_dir mcp)" "not initialized"
for _repo in $PUBLISH_REPOS; do
  case "$_repo" in skills|mcp) continue ;; esac
  repo_status "$_repo" "$(repo_dir "$_repo")"
done
unset _repo

# Bootstrap order (mirrors mise run setup): deps, then submodules, then
# enabler plumbing, then keys. The supabase clone is opt-in for the docs loop
# only — its absence is informational (shown above) and never gates Ready.
[ -d node_modules ] || NEXT="${NEXT}  pnpm install                                       # install workspace deps\n"
if [ ! -e "$(repo_dir skills)/.git" ] || [ ! -e "$(repo_dir mcp)/.git" ]; then
  NEXT="${NEXT}  git submodule update --init submodules/agent-skills submodules/mcp # init submodules\n"
fi
# enabler plumbing present? (marker commits; see apply-patches.sh) — only
# checked for repos that are actually present (supabase clone, mcp submodule).
for _r in $PATCH_REPOS; do
  _d=$(repo_dir "$_r")
  [ -e "$_d/.git" ] || continue
  _subjects=$(git -C "$_d" log --format=%s HEAD --not --remotes 2>/dev/null || true)
  for _p in $(patches_for "$_r"); do
    if ! printf '%s\n' "$_subjects" | grep -qxF "$(patch_subject "$_p")"; then
      NEXT="${NEXT}  mise run apply-patches            # enabler plumbing commit(s) missing in $_d\n"
      break
    fi
  done
done
# pre-push guards active? (apply-patches installs them, incl. in agent-skills)
for _n in $PUBLISH_REPOS; do
  _d=$(repo_dir "$_n")
  [ -e "$_d/.git" ] || continue
  _hooks=$(git -C "$_d" rev-parse --path-format=absolute --git-path hooks 2>/dev/null || true)
  if [ -n "$_hooks" ] && ! grep -q 'eval-workspace pre-push guard' "$_hooks/pre-push" 2>/dev/null; then
    NEXT="${NEXT}  mise run apply-patches            # pre-push guard missing in $_d\n"
  fi
done
unset _r _n _d _subjects _p _hooks

echo
echo "Credentials (source per key; ANTHROPIC + OPENAI required, GEMINI optional):"
IS_DARWIN=""; [ "$(uname -s)" = Darwin ] && IS_DARWIN=1
for key in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY; do
  src=""
  [ -n "$IS_DARWIN" ] && security find-generic-password -a "$USER" -s "eval-workspace:$key" >/dev/null 2>&1 && src="keychain"
  if [ -f .env ] && grep -qE "^${key}=.+" .env; then src="${src:+$src, }.env"; fi
  printf '  %-24s %s\n' "$key" "${src:-MISSING}"
  if [ -z "$src" ] && [ "$key" != GEMINI_API_KEY ]; then
    if [ -n "$IS_DARWIN" ]; then
      NEXT="${NEXT}  mise run store-key $key\n"
    else
      NEXT="${NEXT}  add ${key}=… to .env              # git-ignored; no macOS keychain here (see README \"Credentials\")\n"
    fi
  fi
done

echo
echo "Tooling:"
for bin in mise pnpm docker node; do
  if command -v "$bin" >/dev/null; then printf '  %-7s %s\n' "$bin" "$(command -v "$bin")"; else printf '  %-7s missing\n' "$bin"; fi
done
if command -v docker >/dev/null; then
  if docker info >/dev/null 2>&1; then echo "  docker  (running)"; else echo "  docker  (not running)"; fi
fi

echo
if [ -n "$NEXT" ]; then
  echo "Next (in order):"
  printf "%b" "$NEXT" | awk '!seen[$0]++'
else
  echo "Ready. Try:"
  echo "  mise run ab-test                                  # zero-cost self-check of the A/B runner"
  echo "  mise run ab                                       # A/B readiness probe (head-to-head evals)"
  echo "  mise run eval -- --eval <id> --experiment <exp>   # run an eval (see evals/)"
fi
