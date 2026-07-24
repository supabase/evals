#!/usr/bin/env bash
# Update the clones: fetch upstream and REBASE local work — the [eval-workspace-*]
# plumbing commits plus any commits of yours — onto the new tip. Uncommitted
# edits survive via --autostash. A rebase conflict means upstream drifted under
# a plumbing commit (regenerate that patch; see patches/README.md) or under
# your own commits; the rebase is aborted so the workspace is left as found.
#
# Usage: scripts/update.sh [--check] [repo...]
#   --check  fetch + report how far behind each clone is; changes nothing
#   repos    default: every patch-carrying repo from manifest.json
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/patches-lib.sh

CHECK=0
[ "${1:-}" = "--check" ] && { CHECK=1; shift; }
REPOS=("$@")
[ ${#REPOS[@]} -gt 0 ] 2>/dev/null || REPOS=($PATCH_REPOS)

FAILED=0
for repo in ${REPOS[@]+"${REPOS[@]}"}; do
  if [ ! -e "$repo/.git" ]; then echo "== $repo: not cloned — skipping"; continue; fi
  branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD)
  old_upstream=$(git -C "$repo" rev-parse "origin/$branch" 2>/dev/null || echo "")
  git -C "$repo" fetch -q
  behind=$(git -C "$repo" rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo '?')

  if [ "$CHECK" = 1 ]; then
    printf '== %-9s %s@%s is %s commit(s) behind origin/%s\n' "$repo:" "$branch" "$(git -C "$repo" rev-parse --short HEAD)" "$behind" "$branch"
    continue
  fi

  echo "== $repo: $branch, $behind commit(s) behind — updating"
  git -C "$repo" diff --cached --quiet --ita-visible-in-index \
    || { echo "  $repo index has staged changes — unstage or commit first" >&2; FAILED=1; continue; }

  if [ "$behind" = 0 ]; then
    echo "  already up to date"
    continue
  fi

  # capture agent-skills state BEFORE the rebase moves the recorded pin
  if [ "$repo" = evals ]; then
    sk=evals/submodules/agent-skills
    old_pin=$(git -C evals ls-tree HEAD submodules/agent-skills | awk '{print $3}')
    sk_head=$(git -C "$sk" rev-parse HEAD 2>/dev/null || echo "")
    sk_clean=$([ -e "$sk/.git" ] && [ -z "$(git -C "$sk" status --porcelain 2>/dev/null)" ] && echo yes || echo no)
  fi

  if ! git -C "$repo" rebase --autostash -q "origin/$branch"; then
    git -C "$repo" rebase --abort 2>/dev/null || true
    echo "  REBASE CONFLICT: upstream drifted under a plumbing commit or your work — nothing changed." >&2
    echo "  Fix: regenerate the conflicting patch (patches/README.md) or rebase manually in $repo/." >&2
    FAILED=1
    continue
  fi
  echo "  now at $(git -C "$repo" rev-parse --short HEAD) (upstream $(git -C "$repo" rev-parse --short "origin/$branch"))"

  if [ "$repo" = evals ] && [ -e "$sk/.git" ]; then
    # sync the pin only when skills had NO local work before the update:
    # clean tree AND sitting exactly on the previously recorded gitlink
    if [ "$sk_clean" = yes ] && [ "$sk_head" = "$old_pin" ]; then
      git -C evals submodule update --init --recursive -q
    else
      echo "  note: agent-skills submodule has local work (edits or commits) — skipping submodule sync"
    fi
  fi

  new_upstream=$(git -C "$repo" rev-parse "origin/$branch")
  if [ "$old_upstream" != "$new_upstream" ]; then
    case "$repo" in
      evals)
        if ! git -C evals diff --quiet "$old_upstream" "$new_upstream" -- pnpm-lock.yaml; then
          echo "  lockfile changed — pnpm install"; ( cd evals && pnpm install --silent )
        fi ;;
      supabase)
        if ! git -C supabase diff --quiet "$old_upstream" "$new_upstream" -- pnpm-lock.yaml; then
          echo "  lockfile changed — pnpm install (docs filter)"; pnpm --dir supabase install --filter docs... --silent
        fi
        if [ -n "$(git -C supabase diff --name-only "$old_upstream" "$new_upstream" -- apps/docs/content | head -1)" ]; then
          echo "  note: docs content changed upstream — the next docs-index re-embeds changed pages (costs cents)"
        fi ;;
      mcp)
        if [ -d mcp/packages/mcp-server-supabase/dist ]; then
          echo "  rebuilding local mcp"; ( cd mcp && pnpm install --silent && pnpm build )
        fi ;;
    esac
  fi
done

[ "$FAILED" = 0 ] || { echo; echo "update finished with errors (see above)"; exit 1; }
