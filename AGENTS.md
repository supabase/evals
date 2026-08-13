# AGENTS.md — supabase/evals

Instructions for coding agents working in this repo. Humans: start with
[README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## What this repo is

Evals for Supabase AI agents. An eval run is `agent + inputs -> score`. The
three inputs a change usually targets: the **skills** tree (in this repo),
the **MCP server** (external checkout), and **docs** content (external
supabase/supabase checkout).

## Verifying a change against the evals (`pnpm local`)

Use the local runner for all "did my change help / did it regress?" work.
It never mutates git state, so it is safe alongside in-flight work.

```bash
pnpm local run <eval-id...> [--experiment <id>] [--runs N] [--mcp <path>] [--content-api <url>]
pnpm local experiments                         # experiments + which have published results
pnpm local docs <up|seed|api|down> --docs <path-to-supabase-monorepo>
```

Per input:

- **Skill edited** (in `skills/`): no sync step — `pnpm local run <eval>`.
- **MCP server edited** (external checkout): `pnpm build` in that checkout,
  then `pnpm local run <eval> --mcp <checkout-path>`.
- **Docs page edited** (external supabase/supabase checkout):
  `pnpm local docs seed --yes` to re-embed (**~$0.12 OpenAI — see spend
  rules**), keep `pnpm local docs api` running in a separate terminal, then
  `pnpm local run <eval> --content-api http://127.0.0.1:3001/docs/api/graphql --mcp <mcp-checkout>`.
  `--content-api` needs `--mcp` while the harness pin is below v0.10.0: the
  `--content-api-url` flag it forwards landed in supabase/mcp#343 and shipped in
  v0.10.0, so the pinned package ignores it and `search_docs` would query
  production docs while the receipt claimed otherwise. The runner refuses
  pre-spend, and stops asking for `--mcp` once the pin reaches v0.10.0.
  **`docs seed` currently fails against a vanilla docs checkout**: the pipeline
  unconditionally loads its lint-warnings source, which needs a GitHub App
  (`DOCS_GITHUB_APP_*`, no token fallback), and one `Promise.all` makes that
  fatal. It aborts before embedding, so a retry costs nothing but achieves
  nothing — don't loop on it. The leg needs an index seeded another way until a
  skip flag lands upstream.
  Score docs evals on retrieval (`docs.calls`, canary content coming back out of
  `search_docs`), not on the answer text: tools mode also exposes
  `WebSearch`/`WebFetch`, and an edit that contradicts the live page invites the
  agent to fetch production and reject the local content as injection (observed).

Receipts land in `results-local/` (git-ignored): treatment provenance, meaning
the host SHA + dirty state and the override paths with their git state.

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
- **Custom evals work the same way.** `pnpm local run` does not need the eval
  to appear in any published export.

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

- Eval runs cost model tokens; `pnpm local docs seed` costs **~$0.12 OpenAI
  per invocation**. State the cost and get user confirmation before
  running paid steps the user did not explicitly request.
- The runner refuses pre-spend on invalid eval metadata, unknown
  experiments, and bad `--mcp` paths — do not work around these gates.
- Zero-cost checks: `pnpm --filter @supabase-evals/framework test:local`
  (runner self-test), `pnpm local experiments`, `pnpm eval:dry`.

## Conventions

- Keys live in `.env` at the repo root: `ANTHROPIC_API_KEY`, plus
  `OPENAI_API_KEY` for the docs loop AND for any eval whose scorer uses the
  LLM judge (an OpenAI grader model runs even when the agent under test is
  Claude). Never hardcode or echo key values.
- Model/agent selection = experiment id. To test an unlisted model, add a
  small `experiments/<name>.ts` (copy an existing file's shape) rather than
  editing a published experiment in place.
- `results/`, `results-local/`, and `.local-docs/` are outputs — never
  commit their contents.
- Verify with `pnpm check` (typecheck + core/sandbox tests) and
  `pnpm format:check` (biome) before pushing.
- New evals: follow [CONTRIBUTING.md](CONTRIBUTING.md) (suite choice,
  `motivation:` frontmatter, scorer shape).
