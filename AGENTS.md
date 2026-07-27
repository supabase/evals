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
pnpm local run <eval-id...>     [--experiment <id>] [--runs N] [--mcp <path>] [--content-api <url>]
pnpm local compare <eval-id...> [same flags]   # + diff vs latest published result on origin/main
pnpm local experiments                         # experiments + which have published baselines
pnpm local docs <up|seed|api|down> --docs <path-to-supabase-monorepo>
```

Per input:

- **Skill edited** (in `skills/`): no sync step — `pnpm local compare <eval>`.
- **MCP server edited** (external checkout): `pnpm build` in that checkout,
  then `pnpm local compare <eval> --mcp <checkout-path>`.
- **Docs page edited** (external supabase/supabase checkout):
  `pnpm local docs seed --yes` to re-embed (**~$0.12 OpenAI — see spend
  rules**), keep `pnpm local docs api` running in a separate terminal, then
  `pnpm local compare <eval> --content-api http://127.0.0.1:3001/docs/api/graphql`.

Receipts land in `results-local/` (git-ignored): treatment provenance (host
SHA + dirty state, override git state) and, for `compare`, the published
arm's result commit + parent + age.

## Interpreting results — rules, not suggestions

- **`compare` is a screen, not causal proof.** The published arm ran in the
  scheduled CI world (published MCP package, prod docs index, model state at
  refresh time). Never report a flip as caused by the edit; report it as a
  signal consistent with the edit.
- **Single runs are noisy.** Before claiming improvement or regression, run
  `--runs 3` and read check-level results, not just pass/fail.
- **MCP changes: judge by tool-call activation.** An eval can pass without
  ever calling the tool you changed. Confirm the changed tool was actually
  exercised (the result JSON records tool calls) before concluding anything.
- **Docs changes: the eval must be able to see the docs.** Use a tools-mode
  (`interface: mcp`) eval whose answer lives in the edited page and is
  reached via `search_docs`. CLI-scaffold evals can pass regardless of docs.
- **No published baseline?** Use `pnpm local run` (custom evals included).
  For a before/after, run once before the edit and once after.

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
