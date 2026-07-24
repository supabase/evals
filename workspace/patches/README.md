# Enabler patches

Local changes to the cloned repos, materialized by `scripts/apply-patches.sh`
as identifiable **local commits** at the bottom of each clone's branch:

    [eval-workspace-local] <name>      dev shim — must never leave this machine
    [eval-workspace-upstream] <name>   upstream candidate — leaves ONLY via
                                  `mise run publish <repo> <topic> --with <name>`

Your own work sits **above** these as normal commits, so `git commit -am` can
never sweep plumbing into it, and `mise run ab` can A/B any file (plumbing is
not in the working diff). A pre-push guard in every clone (and the agent-skills
submodule) blocks marker commits from being pushed; a pre-existing pre-push
hook is chained after the guard. Deliberate override (skips only the marker
checks): `EVAL_WORKSPACE_ALLOW_PUSH=1 git push …`.

The `.patch` files here are **canonical**: `apply-patches` builds each commit
from the patch via the index, verifies the staged diff equals the patch before
committing (a user edit in a patch-owned file can never be absorbed), and on
every later run verifies the existing marker commit still matches the file.
`manifest.json` is the single source of truth mapping patches → repos / kinds
(read via `scripts/manifest.mjs`; marker subjects derive from the kind).

| Patch | Repo | Files | Kind | Tests | What |
|---|---|---|---|---|---|
| `mcp-content-api-url` | supabase/mcp | `transports/stdio.ts` | upstream | 3 stdio integration tests (in the PR) | `--content-api-url` flag + `SUPABASE_CONTENT_API_URL` — **PR open: [mcp#343](https://github.com/supabase/mcp/pull/343)** |
| `evals-mcp-local-build-override` | supabase/evals | `core/index.ts`, `core/mcp-server.test.ts` | upstream | 4 `createConfig` tests | `SUPABASE_MCP_SERVER_PATH` local-build override (independent of the mcp flag; ships with the M1 submodule PR) |
| `evals-mcp-content-api-url` | supabase/evals | `core/index.ts`, `core/mcp-server.test.ts` | upstream | 2 `createConfig` tests | `contentApiUrl` option + `SUPABASE_CONTENT_API_URL` threading (applies on top of the override patch; upstream only after mcp's `--content-api-url` flag lands) |
| `supabase-content-local-ports` | supabase/supabase | `config.toml` | **LOCAL-ONLY** | n/a | dev ports 55321+ (avoid evals' 54321-9) |
| `supabase-docs-index-fail-closed` | supabase/supabase | `generate-embeddings.ts` | upstream | none | fail-closed `purgeOldPages` + token/cost report |
| `supabase-docs-guide-checksum` | supabase/supabase | `guideModelLoader.ts` | upstream | none | guide checksum + `tryCatch` `onError` fix (docs-index edit detection) |
| `supabase-docs-lint-warnings-skip` | supabase/supabase | `lint-warnings-guide.ts` | **LOCAL-ONLY** | n/a | `DOCS_EMBED_ALLOW_MISSING_SOURCES` skip |
| `supabase-docs-reference-dup-sources` | supabase/supabase | `sources/reference-doc.ts` + test | upstream | **unit + real-output tests** | dedupe duplicate reference source paths (the 18-page `inserted 2/1` fix) |

## Changing or regenerating a patch

The marker commit and the `.patch` file must stay in sync — `apply-patches`
verifies both directions and fails loudly on drift.

- **You changed the plumbing in the clone** (amended/edited the marker commit):
  refresh the canonical file from the commit —
  `git -C <clone> diff <marker-sha>^ <marker-sha> > patches/<name>.patch`
  (plain `git diff` cannot see committed changes).
- **You edited the `.patch` file**: drop the old marker commit
  (`git -C <clone> rebase --onto <marker-sha>^ <marker-sha>`), then
  `mise run apply-patches` re-creates it from the file.
- **A patch adds brand-new files**: when generating, `git add -N <file>` first,
  then `git reset -- <file>` after — a leftover intent-to-add entry breaks `git stash`.

## Upstreaming order

`evals-mcp-local-build-override` — independent of everything, shipped with the
evals M1 submodule PR (evals#109). Then `mcp-content-api-url` PR →
`evals-mcp-content-api-url` PR (depends on the flag) → the three upstream
supabase fixes (independent; `guide-checksum` and `index-fail-closed` still
need regression tests; `reference-dup-sources` is test-covered and PR-ready).
