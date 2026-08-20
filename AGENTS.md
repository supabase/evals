# AGENTS.md — supabase/evals

Instructions for coding agents working in this repo. Humans: start with
[README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## What this repo is

Evals for Supabase AI agents. An eval run is `agent + inputs -> score`. The
three inputs a change usually targets: the **skills** tree (in this repo),
the **MCP server** (external checkout), and **docs** content (external
supabase/supabase checkout).

## Verifying a change against the evals (`pnpm eval`)

Use `pnpm eval` for local and scheduled runs. It reads the current skills tree
and writes the result with its provenance receipt to
`results/<experiment>/<eval>.json`.

```bash
pnpm eval -- --strict --eval <eval-id> --experiment <id> --runs 3
pnpm eval -- list
pnpm docs:local <up|seed|api|down> --docs <path-to-supabase-monorepo>
```

Use `--strict` for verification. It makes missing credentials, skills, local
stack support, and other error-class skips fail with exit 1. Intentional
`--skip-existing` and eval-filter skips stay nonfatal.

Per input:

- **Skill edited** (in `skills/`): no sync step. Run `pnpm eval -- --strict
  --eval <eval-id>`.
- **MCP server edited** (external checkout): build that checkout, then add
  `--mcp <checkout-path>`. The runner validates the built server before spend.
- **Docs page edited** (external supabase/supabase checkout): use
  `pnpm docs:local up`, `seed`, and `api` for the local index lifecycle. Seeding
  costs about $0.12 OpenAI and asks before it starts. Keep `api` running, then
  use `pnpm eval -- --strict --eval <eval-id> --content-api
  http://127.0.0.1:3001/docs/api/graphql --mcp <mcp-checkout>`.
  `--content-api` needs `--mcp` while the harness pin is below v0.10.0. The
  runner refuses a build without the `--content-api-url` flag before spend.
  The docs checkout must include the lint-warnings authentication fix from
  supabase/supabase#48364 or provide its required GitHub credentials.

Score docs evals on retrieval (`docs.calls` and content returned by
`search_docs`). Tools-mode agents can also fetch production pages, which can
hide a local retrieval failure.

Receipts include the host state, MCP override state, and content API URL in the
canonical result under `results/`.

## Interpreting results — rules, not suggestions

- **The published results in this repo are not a control arm.** They came from
  the scheduled CI world (published MCP package, prod docs index, model state
  at refresh time), so a difference against them is a signal consistent with
  your edit and never proof the edit caused it. For a real two-arm comparison,
  run the eval yourself before and after the change with everything else held
  constant.
- **Single runs are noisy.** Before claiming improvement or regression, run
  `--runs 3` and read check-level results, not just pass/fail.
- **MCP changes: judge by tool-call activation.** An eval can pass without
  ever calling the tool you changed. Confirm the changed tool was actually
  exercised (the result JSON records tool calls) before concluding anything.
- **Docs changes: the eval must be able to see the docs.** Use a tools-mode
  (`interface: mcp`) eval whose answer lives in the edited page and is
  reached via `search_docs`. CLI-scaffold evals can pass regardless of docs.
- **Custom evals work the same way.** `pnpm eval -- --strict --eval <id>` does
  not require a published result.

## Validating a dependency PR (e.g. supabase/mcp)

1. **Baseline-proof first**: build the dependency's MAIN and run the chosen
   eval(s) against it before the PR build — version pins hide fixture drift
   (platform-lite tracks the pinned `MCP_SERVER_VERSION`, not your local
   build's line; the runner warns on version mismatch).
2. Fixture or eval support living in an unmerged evals PR? Apply it into the
   worktree as plain working-tree state: `gh pr diff <n> | git apply`.
   Receipts record the dirty tree, so runs stay attributable.
3. Run the PR build with `--mcp <checkout>`; a main-FAIL -> PR-PASS flip with
   everything else constant is a true two-arm comparison on the dependency
   axis, which is why step 1 is worth the spend.
4. **Judge by tool-call activation, not pass/fail**: confirm the changed tool
   was called, and unwrap `<untrusted-data-…>` envelopes in `toolCalls[]`
   before reading results — errors hide inside them. Note that claude-code
   records endpoints with an `mcp__<server>__` prefix; match with
   `.endsWith('<tool>')`.

## Spend rules

- Eval runs cost model tokens. `pnpm docs:local seed` costs about $0.12 OpenAI
  per invocation. State the cost and get user confirmation before unrequested
  paid steps.
- Strict mode refuses pre-spend errors. Do not work around these gates.
- Zero-cost checks: `pnpm --filter @supabase-evals/framework test:local`,
  `pnpm eval -- list`, and `pnpm eval:dry`.

## Conventions

- Keys live in `.env` at the repo root: `ANTHROPIC_API_KEY`, plus
  `OPENAI_API_KEY` for the docs loop AND for any eval whose scorer uses the
  LLM judge (an OpenAI grader model runs even when the agent under test is
  Claude). Never hardcode or echo key values.
- Model/agent selection = experiment id. To test an unlisted model, add a
  small `experiments/<name>.ts` (copy an existing file's shape) rather than
  editing a published experiment in place.
- `results/` and `.local-docs/` are outputs. Never commit their contents.
- Verify with `pnpm check` (typecheck + core/sandbox tests) and
  `pnpm format:check` (biome) before pushing.
- New evals: follow [CONTRIBUTING.md](CONTRIBUTING.md) (suite choice,
  `motivation:` frontmatter, scorer shape).
