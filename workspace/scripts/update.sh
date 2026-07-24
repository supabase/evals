#!/usr/bin/env bash
# Update the supabase clone: fetch upstream and REBASE local work — the
# [eval-workspace-*] plumbing commits plus any commits of yours — onto the
# new tip. Uncommitted edits survive via --autostash. A rebase conflict means
# upstream drifted under a plumbing commit (regenerate that patch; see
# workspace/patches/README.md) or under your own commits; the rebase is
# aborted so the workspace is left as found.
#
# mcp and skills are pin-driven submodules (no remote in manifest.json) —
# not managed here. Bump the pin with `git submodule update --remote <dir>`
# and record it via the M3 pin flow, then re-run `mise run apply-patches`.
#
# Usage: workspace/scripts/update.sh [--check] [repo...]
#   --check  fetch + report how far behind each clone is; changes nothing
#   repos    default: every patch-carrying repo from manifest.json
set -euo pipefail
cd "$(dirname "$0")/../.."
source workspace/scripts/patches-lib.sh

CHECK=0
[ "${1:-}" = "--check" ] && { CHECK=1; shift; }
REPOS=("$@")
[ ${#REPOS[@]} -gt 0 ] 2>/dev/null || REPOS=($PATCH_REPOS)

FAILED=0
for repo in ${REPOS[@]+"${REPOS[@]}"}; do
  dir=$(repo_dir "$repo")
  remote=$(repo_remote "$repo")
  if [ -z "$remote" ]; then
    echo "== $repo: pin-driven ($dir) — not fetched/rebased here."
    echo "   bump: git submodule update --remote $dir   (then record the pin — see M3 pin flow)"
    continue
  fi
  if [ ! -e "$dir/.git" ]; then echo "== $repo: not cloned — skipping"; continue; fi
  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD)
  old_upstream=$(git -C "$dir" rev-parse "origin/$branch" 2>/dev/null || echo "")
  git -C "$dir" fetch -q
  behind=$(git -C "$dir" rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo '?')

  if [ "$CHECK" = 1 ]; then
    printf '== %-9s %s@%s is %s commit(s) behind origin/%s\n' "$repo:" "$branch" "$(git -C "$dir" rev-parse --short HEAD)" "$behind" "$branch"
    continue
  fi

  echo "== $repo: $branch, $behind commit(s) behind — updating"
  git -C "$dir" diff --cached --quiet --ita-visible-in-index \
    || { echo "  $dir index has staged changes — unstage or commit first" >&2; FAILED=1; continue; }

  if [ "$behind" = 0 ]; then
    echo "  already up to date"
    continue
  fi

  if ! git -C "$dir" rebase --autostash -q "origin/$branch"; then
    git -C "$dir" rebase --abort 2>/dev/null || true
    echo "  REBASE CONFLICT: upstream drifted under a plumbing commit or your work — nothing changed." >&2
    echo "  Fix: regenerate the conflicting patch (workspace/patches/README.md) or rebase manually in $dir/." >&2
    FAILED=1
    continue
  fi
  echo "  now at $(git -C "$dir" rev-parse --short HEAD) (upstream $(git -C "$dir" rev-parse --short "origin/$branch"))"

  new_upstream=$(git -C "$dir" rev-parse "origin/$branch")
  if [ "$old_upstream" != "$new_upstream" ]; then
    case "$repo" in
      supabase)
        if ! git -C "$dir" diff --quiet "$old_upstream" "$new_upstream" -- pnpm-lock.yaml; then
          echo "  lockfile changed — pnpm install (docs filter)"; pnpm --dir "$dir" install --filter docs... --silent
        fi
        if [ -n "$(git -C "$dir" diff --name-only "$old_upstream" "$new_upstream" -- apps/docs/content | head -1)" ]; then
          echo "  note: docs content changed upstream — the next docs-index re-embeds changed pages (costs cents)"
        fi ;;
    esac
  fi
done

[ "$FAILED" = 0 ] || { echo; echo "update finished with errors (see above)"; exit 1; }
