#!/usr/bin/env bash
# Build a CLEAN branch for an upstream PR, in a temporary worktree that starts
# at origin/<branch> and contains ONLY what you select:
#   - your own commits (everything above origin that isn't [eval-workspace-*])
#   - optionally, UPSTREAM-CANDIDATE plumbing commits via --with <patch-name>,
#     reworded to drop the marker so the PR is clean
# [eval-workspace-local] commits can never be selected, and the pre-push guard
# blocks any marker commit from being pushed by accident.
#
# Usage:
#   workspace/scripts/publish.sh <repo> --list                         what's publishable
#   workspace/scripts/publish.sh <repo> <topic-branch> [--with <patch-name>]...
#   <repo>: mcp (submodule) | supabase (docs submodule) — the only publishable repos
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
source workspace/scripts/patches-lib.sh

repo="${1:-}"; shift || true
case " $PATCH_REPOS " in *" $repo "*) ;; *)
  echo "usage: mise run publish <mcp|supabase> <topic-branch> [--with <patch-name>]... | --list" >&2; exit 2 ;;
esac
dir=$(repo_dir "$repo")
[ -e "$dir/.git" ] || { echo "$dir not cloned" >&2; exit 1; }
branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD)
[ "$branch" != HEAD ] || { echo "$dir is on a detached HEAD — check out a branch first" >&2; exit 1; }

user_commits() {  # oldest first, hash + subject, excluding plumbing markers
  git -C "$dir" log --reverse --format='%H %s' "origin/$branch..HEAD" \
    | grep -v ' \[eval-workspace-' || true
}
candidate_sha() { # sha of an [eval-workspace-upstream] commit by patch name
  git -C "$dir" log --format='%H %s' "origin/$branch..HEAD" \
    | grep -F "[eval-workspace-upstream] $1" | head -1 | cut -d' ' -f1
}

if [ "${1:-}" = "--list" ] || [ $# -eq 0 ]; then
  echo "== $repo: publishable from $branch (base origin/$branch) =="
  echo "your commits:"
  user_commits | sed 's/^\([0-9a-f]\{8\}\)[0-9a-f]*/  \1/' || true
  [ -n "$(user_commits)" ] || echo "  (none)"
  if [ -n "$(patches_for "$repo")" ]; then
    echo "upstream-candidate plumbing (add with --with <name>):"
    for p in $(patches_for "$repo"); do
      [ "$(patch_kind "$p")" = upstream ] || continue
      echo "  $(basename "$p" .patch)"
    done
  fi
  echo
  echo "then: mise run publish $repo <topic-branch> (--all | --commit <sha>...) [--with <name>]..."
  exit 0
fi

topic="$1"; shift
case "$topic" in --*) echo "topic branch must come before the selection flags" >&2; exit 2 ;; esac
ALL=0; COMMITS=(); WITH=()
while [ $# -gt 0 ]; do
  case "$1" in
    --all)    ALL=1; shift ;;
    --commit) shift; [ -n "${1:-}" ] || { echo "--commit needs a sha" >&2; exit 2; }; COMMITS+=("$1"); shift ;;
    --with)   shift; [ -n "${1:-}" ] || { echo "--with needs a patch name" >&2; exit 2; }; WITH+=("$1"); shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# resolve selections -> SHAs. Commit selection is EXPLICIT: --all takes every
# commit of yours; --commit picks specific ones — so stacked, unrelated
# experiments can't ride along into a PR by accident.
PICKS=()
for w in ${WITH[@]+"${WITH[@]}"}; do
  sha=$(candidate_sha "$w")
  [ -n "$sha" ] || { echo "no [eval-workspace-upstream] commit for '$w' in $dir (see: mise run publish $repo --list)" >&2; exit 1; }
  PICKS+=("$sha")
done
if [ "$ALL" = 1 ]; then
  [ ${#COMMITS[@]} -eq 0 ] 2>/dev/null || { echo "use --all or --commit, not both" >&2; exit 2; }
  while read -r sha _; do [ -n "$sha" ] && PICKS+=("$sha"); done <<EOF
$(user_commits)
EOF
elif [ ${#COMMITS[@]} -gt 0 ] 2>/dev/null; then
  for c in ${COMMITS[@]+"${COMMITS[@]}"}; do
    sha=$(git -C "$dir" rev-parse --verify --quiet "$c^{commit}") \
      || { echo "not a commit in $dir: $c" >&2; exit 1; }
    user_commits | grep -q "^$sha " \
      || { echo "$c is not one of YOUR commits above origin/$branch (see: mise run publish $repo --list)" >&2; exit 1; }
    PICKS+=("$sha")
  done
fi
if [ ${#PICKS[@]} -eq 0 ] 2>/dev/null; then
  echo "nothing selected. Pick commits explicitly:" >&2
  echo "  mise run publish $repo $topic --all                  # every commit of yours" >&2
  echo "  mise run publish $repo $topic --commit <sha>...      # specific commits" >&2
  echo "  mise run publish $repo $topic --with <patch-name>    # an upstream-candidate enabler" >&2
  echo >&2
  echo "your commits (mise run publish $repo --list):" >&2
  user_commits | sed 's/^/  /' >&2
  exit 2
fi
# chronological order (parents first)
ORDERED=()
while read -r sha; do
  for p in ${PICKS[@]+"${PICKS[@]}"}; do [ "$sha" = "$p" ] && ORDERED+=("$sha"); done
done <<EOF
$(git -C "$dir" rev-list --reverse "origin/$branch..HEAD")
EOF

wt="$ROOT/.publish/$repo-$topic"
[ ! -e "$wt" ] || { echo "$wt already exists — remove it first (git -C $dir worktree remove $wt)" >&2; exit 1; }
git -C "$dir" worktree add -q -b "$topic" "$wt" "origin/$branch" \
  || { echo "could not create worktree/branch '$topic' (does the branch already exist?)" >&2; exit 1; }

fail() {
  git -C "$wt" cherry-pick --abort 2>/dev/null || true
  git -C "$dir" worktree remove --force "$wt" 2>/dev/null || true
  git -C "$dir" branch -D "$topic" 2>/dev/null || true
  echo "publish aborted: $1" >&2
  exit 1
}
for sha in ${ORDERED[@]+"${ORDERED[@]}"}; do
  git -C "$wt" cherry-pick "$sha" >/dev/null || fail "cherry-pick conflict at $(git -C "$dir" log -1 --format='%h %s' "$sha")"
  subj=$(git -C "$wt" log -1 --format=%s)
  case "$subj" in
    "[eval-workspace-upstream] "*)   # reword: drop the marker + plumbing boilerplate
      git -C "$wt" log -1 --format=%B \
        | sed -e '1s/^\[eval-workspace-upstream\] //' -e '/eval-workspace plumbing/d' \
        | git -C "$wt" commit -q --amend -F - ;;
  esac
done

echo "== clean PR branch ready =="
git -C "$wt" log --oneline "origin/$branch..HEAD" | sed 's/^/  /'
echo
echo "Review and push:"
echo "  cd $wt"
echo "  git push origin HEAD        # then open the PR"
echo
echo "When merged (or abandoned), clean up:"
echo "  git -C $dir worktree remove $wt && git -C $dir branch -D $topic"
