# Bash facade over manifest.json — the single source of truth for repos,
# remotes, and enabler patches (order and kind; marker subjects derive from
# the kind). All data queries go through scripts/manifest.mjs, which validates
# the schema and fails loud. Sourced by apply-patches.sh, update.sh,
# publish.sh, status.sh, setup.sh, clone-docs.sh. Requires bash (BASH_SOURCE)
# and node (pinned via mise).
_MANIFEST_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
_manifest() { node "$_MANIFEST_LIB_DIR/manifest.mjs" "$@"; }

# PATCH_REPOS   = repos carrying enabler patches (manifest order): mcp, supabase
# PUBLISH_REPOS = same set here — skills has no patches and is neither a patch
#                 nor a publish repo in this manifest (both derive from the
#                 same "has patches" predicate; kept as separate names because
#                 downstream scripts read them for different purposes)
#
# Fail-loud init: `for x in $(failing-cmd)` does NOT trip `set -e` in the
# sourcing script — the substitution failure is swallowed and the lists come
# out empty, turning a broken manifest into silent no-ops downstream
# (update.sh would "update" zero repos and exit 0). Capture first, verify.
_MANIFEST_REPOS=$(_manifest repos) || _MANIFEST_REPOS=""
if [ -z "$_MANIFEST_REPOS" ]; then
  echo "patches-lib.sh: manifest.mjs returned no repos (broken manifest.json or node failure above) — aborting" >&2
  exit 1
fi
PATCH_REPOS=""
for _r in $_MANIFEST_REPOS; do
  if [ -n "$(_manifest get "$_r" patches)" ]; then
    PATCH_REPOS="${PATCH_REPOS:+$PATCH_REPOS }$_r"
  fi
done
PUBLISH_REPOS="$PATCH_REPOS"
unset _r _MANIFEST_REPOS

repo_dir()    { local d; d=$(_manifest get "$1" dir); echo "${d:-$1}"; }
repo_remote() { _manifest get "$1" remote; }

patches_for() {
  local out="" n
  for n in $(_manifest get "$1" patches); do
    out="${out:+$out }workspace/patches/$n.patch"
  done
  echo "$out"
}

# local    = dev shim, must NEVER reach an upstream PR
# upstream = real fix/feature; `mise run publish --with <name>` cherry-picks it
#            onto a clean PR branch (reworded to drop the marker)
patch_kind() { _manifest kind "$(basename "$1" .patch)"; }

patch_subject() {
  local name; name=$(basename "$1" .patch)
  if [ "$(patch_kind "$1")" = local ]; then
    echo "[eval-workspace-local] $name"
  else
    echo "[eval-workspace-upstream] $name"
  fi
}
