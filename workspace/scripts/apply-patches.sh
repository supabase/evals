#!/usr/bin/env bash
# Materialize the enabler patches as identifiable LOCAL COMMITS in the
# supabase and mcp submodule working trees:
#   [eval-workspace-local] <name>      dev shim — must never leave this machine
#   [eval-workspace-upstream] <name>   upstream candidate — leaves ONLY via
#                                 `mise run publish … --with <name>` (reworded)
# Your own work sits ABOVE these as normal commits, so `git commit -am` can
# never sweep plumbing into it, and stash/A-B isolation stays clean.
#
# Idempotent: a patch whose marker commit already exists is skipped; patch
# content found uncommitted in the working tree (the old model) is migrated
# into a commit. Also installs a pre-push guard in the supabase submodule and
# the mcp submodule (the two publishable repos) that blocks marker commits
# from being pushed anywhere. A repo whose dir is absent (supabase not
# cloned) or whose submodule is uninitialized (empty working tree, no .git)
# is skipped cleanly — never install anything on the host repo.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
source workspace/scripts/patches-lib.sh

# Tree OID of "<parent-tree> + <patch>", built in a throwaway index. This is
# the ONE verification mechanism for "state matches the canonical patch":
# byte-exact tree identity, immune to the classic payload-diff blind spot
# (an identical +/- line reattributed to a different file).
patch_tree() {
  local dir="$1" parent="$2" patch="$3" tmpidx out=""
  tmpidx=$(mktemp /tmp/eval-workspace-idx-XXXXXX); rm -f "$tmpidx"   # keep only the name: git must create the index itself
  if GIT_INDEX_FILE="$tmpidx" git -C "$dir" read-tree "$parent" 2>/dev/null \
     && GIT_INDEX_FILE="$tmpidx" git -C "$dir" apply --cached "$ROOT/$patch" 2>/dev/null; then
    out=$(GIT_INDEX_FILE="$tmpidx" git -C "$dir" write-tree 2>/dev/null || echo "")
  fi
  rm -f "$tmpidx"
  echo "$out"
}

apply_one() {
  local dir="$1" patch="$2" subject sha h s
  subject=$(patch_subject "$patch")
  # marker commit already present? (search ALL local-only history)
  sha=""
  while read -r h s; do
    [ "$s" = "$subject" ] && { sha="$h"; break; }
  done <<EOF
$(git -C "$dir" log --format='%H %s' HEAD --not --remotes 2>/dev/null)
EOF
  if [ -n "$sha" ]; then
    # the .patch file is canonical — the commit must still match it EXACTLY:
    # rebuild parent-tree + patch and compare tree OIDs
    local want got
    want=$(git -C "$dir" rev-parse "$sha^{tree}")
    got=$(patch_tree "$dir" "$sha^" "$patch")
    if [ "$got" = "$want" ]; then
      echo "  $(basename "$patch") already committed in $dir"
    else
      echo "  ERROR: the $(basename "$patch") commit in $dir differs from the canonical patch file." >&2
      echo "    refresh the file from the commit:  git -C $dir diff $sha^ $sha > $patch" >&2
      echo "    or drop the commit and re-apply:   git -C $dir rebase --onto $sha^ $sha && mise run apply-patches" >&2
      exit 1
    fi
    return
  fi
  # Build the commit from the CANONICAL patch via the index — never stage whole
  # files, so user edits sitting in patch-owned files can't be absorbed.
  if git -C "$dir" apply --index --check "$ROOT/$patch" 2>/dev/null; then
    git -C "$dir" apply --index "$ROOT/$patch"      # fresh clone: index + worktree
  elif git -C "$dir" apply --cached --check "$ROOT/$patch" 2>/dev/null; then
    git -C "$dir" apply --cached "$ROOT/$patch"     # content already in worktree; extra edits stay unstaged above
  else
    echo "  ERROR: $(basename "$patch") does not apply cleanly to $dir — regenerate it (workspace/patches/README.md)" >&2
    exit 1
  fi
  # the staged state must be exactly parent-tree + canonical patch (tree identity)
  if [ "$(git -C "$dir" write-tree)" != "$(patch_tree "$dir" HEAD "$patch")" ]; then
    git -C "$dir" reset -q
    echo "  ERROR: staged state for $(basename "$patch") differs from the canonical patch — aborted (index reset)" >&2
    exit 1
  fi
  GIT_AUTHOR_NAME=eval-workspace GIT_AUTHOR_EMAIL=eval-workspace@local \
  GIT_COMMITTER_NAME=eval-workspace GIT_COMMITTER_EMAIL=eval-workspace@local \
  git -C "$dir" commit -q -m "$subject" \
    -m "eval-workspace plumbing ($(patch_kind "$patch") kind), generated from $patch. Do not push; see workspace/patches/README.md."
  echo "  committed $(basename "$patch") -> $dir"
}

install_pre_push_guard() {
  local dir="$1" hooks hook
  hooks=$(git -C "$dir" rev-parse --path-format=absolute --git-path hooks)  # submodule .git is a file
  mkdir -p "$hooks"
  hook="$hooks/pre-push"
  if [ -e "$hook" ] && ! grep -q 'eval-workspace pre-push guard' "$hook"; then
    if [ -e "$hooks/pre-push.eval-workspace-chained" ] && ! cmp -s "$hook" "$hooks/pre-push.eval-workspace-chained"; then
      echo "  ERROR: $dir has BOTH a foreign pre-push hook AND a different previously-chained one — merge them manually:" >&2
      echo "    foreign:  $hook" >&2
      echo "    chained:  $hooks/pre-push.eval-workspace-chained" >&2
      exit 1
    fi
    mv "$hook" "$hooks/pre-push.eval-workspace-chained"
    echo "  note: existing pre-push hook in $dir now chained after the eval-workspace guard"
  fi
  cat > "$hook" <<'HOOK'
#!/usr/bin/env bash
# eval-workspace pre-push guard (generated by scripts/apply-patches.sh).
# Blocks eval-workspace plumbing commits from leaving this machine. Publish work
# upstream via a clean cherry-picked branch:
#   mise run publish <repo> <topic-branch> [--with <patch-name>]
# Deliberate override (skips ONLY the marker checks, never a chained hook):
#   EVAL_WORKSPACE_ALLOW_PUSH=1 git push …
input=$(cat)
zero=0000000000000000000000000000000000000000
if [ -z "${EVAL_WORKSPACE_ALLOW_PUSH:-}" ]; then
  while read -r _lref lsha _rref _rsha; do
    [ -z "$lsha" ] && continue
    [ "$lsha" = "$zero" ] && continue                    # deleting a remote ref
    # scan the FULL ancestry being pushed: markers only ever exist locally, so
    # any marker anywhere below $lsha means plumbing would leave the machine.
    # A failing log is a block too (fail-closed), never silently allowed.
    if ! subjects=$(git log --format=%s "$lsha" 2>/dev/null); then
      echo "push blocked: could not inspect the commits at $lsha (failing closed)." >&2
      exit 1
    fi
    if printf '%s\n' "$subjects" | grep -q '^\[eval-workspace-local\]'; then
      echo "push blocked: it contains [eval-workspace-local] plumbing commits (dev shims — never upstream)." >&2
      exit 1
    fi
    if printf '%s\n' "$subjects" | grep -q '^\[eval-workspace-upstream\]'; then
      echo "push blocked: it contains [eval-workspace-upstream] commits. Upstream those via a clean branch:" >&2
      echo "  mise run publish <repo> <topic-branch> --with <patch-name>" >&2
      exit 1
    fi
  done <<EOF
$input
EOF
fi
# pass the same stdin to any pre-existing (chained) hook
chained="$(cd "$(dirname "$0")" && pwd)/pre-push.eval-workspace-chained"
if [ -x "$chained" ]; then
  printf '%s\n' "$input" | "$chained" "$@" || exit $?
fi
exit 0
HOOK
  chmod +x "$hook"
}

echo "Applying enabler patches (as local marker commits):"
for repo in $PATCH_REPOS; do
  dir=$(repo_dir "$repo")
  if [ ! -e "$dir/.git" ]; then echo "  $repo ($dir) not present — skipping"; continue; fi
  git -C "$dir" diff --cached --quiet --ita-visible-in-index \
    || { echo "  ERROR: $dir index has staged changes — unstage first (git -C $dir status)" >&2; exit 1; }
  for p in $(patches_for "$repo"); do apply_one "$dir" "$p"; done
done
for name in $PATCH_REPOS; do
  dir=$(repo_dir "$name")
  [ -e "$dir/.git" ] && install_pre_push_guard "$dir"
done
echo "  pre-push guards installed"
