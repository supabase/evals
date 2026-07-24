# Enabler patches

Local changes to the patched repos (the `submodules/supabase` and the
`submodules/mcp` working tree), materialized by
`workspace/scripts/apply-patches.sh` as identifiable **local commits** at the
bottom of each repo's branch:

    [eval-workspace-local] <name>      dev shim — must never leave this machine
    [eval-workspace-upstream] <name>   upstream candidate — leaves ONLY via
                                  `mise run publish <repo> <topic> --with <name>`

Your own work sits **above** these as normal commits, so `git commit -am` can
never sweep plumbing into it, and `mise run ab` can A/B any file (plumbing is
not in the working diff). A pre-push guard in each patched repo blocks marker
commits from being pushed; a pre-existing pre-push hook is chained after the
guard. The host repo (this one) never gets hooks or marker commits. Deliberate
override (skips only the marker checks): `EVAL_WORKSPACE_ALLOW_PUSH=1 git push …`.

The `.patch` files here are **canonical**: `apply-patches` builds each commit
from the patch via the index, verifies the staged diff equals the patch before
committing (a user edit in a patch-owned file can never be absorbed), and on
every later run verifies the existing marker commit still matches the file.
`workspace/manifest.json` is the single source of truth mapping patches →
repos / kinds (read via `workspace/scripts/manifest.mjs`; marker subjects
derive from the kind).

| Patch | Repo | Files | Kind | Tests | What |
|---|---|---|---|---|---|
| `mcp-content-api-url` | `submodules/mcp` | `transports/stdio.ts` | upstream | 3 stdio integration tests (upstream) | `--content-api-url` flag + `SUPABASE_CONTENT_API_URL` — **merged upstream ([mcp#343](https://github.com/supabase/mcp/pull/343), 2026-07-23), not yet in a release**; the patch retires when a release ships the flag and the pin moves past it |
| `supabase-content-local-ports` | supabase/supabase | `config.toml` | **LOCAL-ONLY** | n/a | dev ports 55321+ (avoid evals' 54321-9) |
| `supabase-docs-index-fail-closed` | supabase/supabase | `generate-embeddings.ts`, `partner-integrations.ts` | upstream | none | fail-closed `purgeOldPages` + token/cost report; partner fetch errors fail loud (a swallowed error looked like zero partners and purged their rows) |
| `supabase-docs-guide-checksum` | supabase/supabase | `guideModelLoader.ts` | upstream | none | guide checksum + `tryCatch` `onError` fix (docs-index edit detection) |
| `supabase-docs-lint-warnings-skip` | supabase/supabase | `lint-warnings-guide.ts`, `generate-embeddings.ts` | **LOCAL-ONLY** | n/a | `DOCS_EMBED_ALLOW_MISSING_SOURCES` skip; the skipped source registers its path scope and the purge excludes it (skip→purge hole) |
| `supabase-docs-reference-dup-sources` | supabase/supabase | `sources/reference-doc.ts` + test | upstream | **unit + real-output tests** | dedupe duplicate reference source paths (the 18-page `inserted 2/1` fix) |

## Changing or regenerating a patch

The marker commit and the `.patch` file must stay in sync — `apply-patches`
verifies both directions and fails loudly on drift.

- **You changed the plumbing in the clone** (amended/edited the marker commit):
  refresh the canonical file from the commit —
  `git -C <repo-dir> diff <marker-sha>^ <marker-sha> > workspace/patches/<name>.patch`
  (plain `git diff` cannot see committed changes).
- **You edited the `.patch` file**: drop the old marker commit
  (`git -C <repo-dir> rebase --onto <marker-sha>^ <marker-sha>`), then
  `mise run apply-patches` re-creates it from the file.
- **A patch adds brand-new files**: when generating, `git add -N <file>` first,
  then `git reset -- <file>` after — a leftover intent-to-add entry breaks `git stash`.

## Upstreaming order

`mcp-content-api-url` — merged upstream ([mcp#343](https://github.com/supabase/mcp/pull/343)); retires at the next mcp release + pin bump.
Then the three upstream supabase fixes (independent; `guide-checksum` and
`index-fail-closed` still need regression tests; `reference-dup-sources` is
test-covered and PR-ready). The two former evals patches are done: the
local-build override shipped with evals#109, and the contentApiUrl threading
landed as a normal commit on this branch.
