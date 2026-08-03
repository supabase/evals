# Supabase Evals

This repo answers how well can agents use Supabase across various tasks.

## Quickstart

Clone with submodules:

```bash
git clone --recurse-submodules git@github.com:supabase/evals.git
```

If you already cloned without submodules:

```bash
git submodule update --init
```

From the repo root:

```bash
pnpm install
cp .env.example .env
```

Agent-backed runs require the relevant provider key in `.env` (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)

## Concepts

- An **eval** is one scenario under `evals/<id>/`. It contains the prompt, scorer, and optional starting state for the two environments: `remote/` (the hosted project) and `local/` (the agent's working files).
- An **experiment** is one agent/runtime/model setup under `experiments/<name>.ts`.
- An **eval suite** is a named set of evals to run together.
- An **experiment suite** is a named set of experiments with related configurations, for head to head comparisons.
- An **agent** is the model driver that receives the eval prompt and calls the configured tools.
- A **runtime** is the local Supabase-like environment and tool surface an experiment gives to the agent.
- `platform-lite` exposes a Supabase Management API-compatible HTTP surface backed by [`@supabase/lite`](https://github.com/supabase/supabase-lite), so real tools like `@supabase/mcp-server-supabase` can run against a lightweight project.

## Running evals

Running evals executes experiment x eval pairs and writes local result files under `results/`.

Run a single eval with one experiment:

```bash
pnpm eval -- --eval resolve-dataapi-001-empty-results --experiment claude-code-sonnet-5
```


Run selected evals across multiple experiments:

```bash
pnpm eval -- \
  --experiment claude-code-sonnet-5 \
  --experiment claude-code-opus-5 \
  --eval resolve-dataapi-001-empty-results \
  --eval investigate-auth-001-deleted-user-access
```

`--suite`, `--experiment-suite`, `--experiment`, and `--eval` accept multiple inputs via repeated flags as well as comma-separated values.

Run all benchmark and no-skills experiments across all benchmark evals:

```bash
pnpm eval -- --suite benchmark --experiment-suite benchmark,no-skills
```

### View results in the web app

After running evals locally, export their results to `eval-results.json` for the web app:

```bash
pnpm export-results
```

Start the web app development server:

```bash
pnpm web
```

## Local development loop (`pnpm local`)

Testing a change to an agent input — a skill, a local build of
[`mcp-server-supabase`](https://github.com/supabase/mcp), or an edited docs
page — against the evals, without touching git state:

```bash
pnpm local run <eval-id> [--experiment <id>] [--mcp <path>] [--content-api <url>]
pnpm local compare <eval-id> [same flags]   # + diff vs the latest published result on main
pnpm local experiments                      # list experiments + published-baseline availability
```

- **Skills**: edit the skills tree in this repo and just `run` — the harness
  reads it as-is.
- **MCP**: clone + build the mcp repo anywhere, then `--mcp <path-to-checkout>`
  (sets `SUPABASE_MCP_SERVER_PATH`, so `search_docs` and friends run your build).
- **Docs**: serve a local docs content API from your own supabase/supabase
  checkout, then point runs at it:

  ```bash
  pnpm local docs up --docs <path-to-supabase-monorepo>
  pnpm local docs seed        # full embed via the docs app's pipeline (~$0.12 OpenAI; asks first)
  pnpm local docs api         # keep running in a separate terminal
  # --content-api needs a local mcp build too: SUPABASE_CONTENT_API_URL support
  # is merged (supabase/mcp#343) but unreleased, so the published server ignores
  # it and search_docs would silently hit production docs. Refused pre-spend.
  pnpm local run <eval-id> --content-api http://127.0.0.1:3001/docs/api/graphql --mcp <mcp-checkout>
  ```

  **Known limitation — `docs seed` needs a docs checkout containing
  [supabase/supabase#48364](https://github.com/supabase/supabase/pull/48364).**
  Without it, `fetchAllSources()` unconditionally awaits the lint warnings source,
  whose loader requires the docs GitHub App, and one shared `Promise.all` turns
  that into a full abort before any embedding (so it costs nothing). That PR adds
  a token rung below the App, `GH_TOKEN` then `GITHUB_TOKEN`, which is all a
  contributor needs: `export GH_TOKEN=$(gh auth token)`. Until it merges, check
  that branch out in the checkout you pass to `--docs`.

  Verified end to end against a checkout carrying it, with the `NEXT_PUBLIC_MISC_*`
  wiring `docs seed` supplies: the seed completes (1901 sources, 7890 sections) and
  a tools-mode eval's `search_docs` returns content that exists only in the local
  index. Two rough edges to expect, both upstream: the seed exits 0 while silently
  failing 22 `/reference/{javascript,dart}` pages whose sections exceed the
  embedding model's 8192-token limit, and a local index has no partner-integration
  pages, since that source reads the hosted misc project. Neither blocked the
  tested guide-page eval, but an eval whose answer lives in those reference pages
  would find them missing from the index.

Every run writes a provenance receipt to `results-local/` (host SHA + dirty
state, override paths and their git state). `compare` records the published
arm's result commit, parent, and age — and a pass/fail flip against published
is a **screen**, not causal proof: the published run happened in the scheduled
CI world (published mcp package, prod docs index, model state at refresh time).

Keys go in `.env` at the repo root: `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY`
for the docs loop and for judge-scored evals (the LLM judge is an OpenAI
grader model, regardless of the agent under test). Zero-cost self-test: `pnpm --filter
@supabase-evals/framework test:local`.

## Eval Shape

Every eval contains:

1. `PROMPT.md` - frontmatter metadata plus the task description the agent sees.
2. `EVAL.ts` - a default-exported scorer.
3. Optional `remote/` - the hosted project's starting state, seeded into platform-lite: `project.sql` (database), `logs.jsonl` (observability logs), `functions/` (already-deployed edge functions).
4. Optional `local/` - the agent's starting files, copied into the sandbox workspace the agent works in (absent means an empty workspace, or no sandbox at all for tools evals).

The two directories mirror Supabase's two environments: `remote/` describes what the customer's hosted project already looks like, `local/` describes what the developer's working directory already looks like.

`PROMPT.md` frontmatter drives eval discovery and site filters:

```md
---
stage: build
suite: benchmark
product:
  - database
  - auth
topic:
  - rls
  - security
motivation: AI-123
---
```

Allowed metadata values are defined in `packages/core/src/eval-metadata.ts`.
`suite` is required on every eval (`benchmark`, `regression`, or `other`). Run an eval suite with `--suite regression` / `--suite other`. Select experiment suites separately with `--experiment-suite benchmark` or `--experiment-suite no-skills`.

## Eval Modes

There are two runtimes, chosen automatically per eval:

- **Tools evals** run the agent against the experiment's MCP/tool surface (no `local/` directory, no `interface: cli`), then score the resulting project state or report.
- **Local-stack evals** run the agent inside a Docker sandbox — a `bash` tool plus file tools with the real Supabase CLI installed — so it can run `supabase init/start/db/test` against a real local stack. An eval uses this runtime when it ships a `local/` workspace **or** declares `interface: cli` (the latter covers bootstrap scenarios that start from an empty workspace).

`interface` (`mcp` | `cli`) is otherwise a benchmark dimension (a cross-team KPI label), not the runtime switch — the `local/` directory and `interface: cli` are what decide whether a sandbox boots.

### Local-stack evals

The Supabase CLI is the agent's tool; the **local stack** (the Docker services `supabase start` runs on a developer machine) is the environment it acts on — distinct from the remote/hosted platform that platform-lite mocks. Experiments declare the environment like MCP servers and skills: add `localStack: localStackRuntime()` (from [`@supabase-evals/sandbox`](packages/sandbox/src/local-stack-runtime.ts)); experiments without it skip these evals. Skills compose with the CLI tools as usual, and tool surfaces merge, so an experiment can in principle expose MCP and CLI together.

**Scoring uses host tooling against an exported workspace.** After the agent finishes, the harness copies its workspace out of the sandbox to the host (`docker cp`), so scorers can run the repo-root `vite`/`vitest` against the produced files without that toolchain having to exist in the sandbox — the same build/test scoring former "project" evals used. Scorers may also run commands and SQL **inside** the sandbox (against the live stack) via the scoring context.

Local-stack evals require a running Docker daemon. Each attempt boots a fresh sandbox container that mounts the host Docker socket, so `supabase start` spawns the local stack as sibling containers; the sandbox runs with host networking, so their published ports land directly on the sandbox's `127.0.0.1` default ports. Supabase's default host ports (54321-54329) must be free — stop any local `supabase start` stacks before running.

An eval's optional `local/` directory is copied into the sandbox workspace before the agent starts. A `services:` frontmatter list declares which local-stack services the scenario needs (e.g. `gotrue`, `kong`, `postgrest`); every other service is excluded from `supabase start` — including when the agent runs it itself — to keep stack boots fast. An empty list (`services: []`) starts only the database; omit the key entirely to start the full stack.

Set `cliVersion: 2.109.1` in an eval's frontmatter when it requires a specific Supabase CLI release. This overrides an experiment's `localStackRuntime({ cliVersion })` setting; otherwise the runtime setting or repository-wide default applies.

Scorers check what the agent produced, never what the harness provisioned: with `projectRunning: true` (the default) the running stack and the seeded `local/` workspace are setup, so score only the deltas the agent made on top; with `projectRunning: false` the agent creates that state itself, so depending on it is fair game.

Test the sandbox plumbing without an agent run (Docker required, not part of `pnpm check`):

```bash
pnpm --filter @supabase-evals/sandbox test:docker
```

## Skills

Skills come from [`supabase/agent-skills`](https://github.com/supabase/agent-skills), pinned as a git submodule at `submodules/agent-skills`. The `skills/` directory contains symlinks into the submodule.

To use a skill in an experiment, reference its directory name in the experiment's `skills` array.

Both runtimes load skills lazily ([progressive disclosure](https://ai-sdk.dev/cookbook/guides/agent-skills)): only each skill's name+description is in the system prompt, and the agent pulls a skill's full instructions on demand. They differ only in how the body is fetched, because the tools-mode agent has no filesystem:

- **Local-stack (sandbox) mode:** skills are installed into the workspace with [Vercel's `skills` CLI](https://github.com/vercel-labs/skills) (baked into the sandbox image, sourced from the local `skills/` directory — never the network) under `.claude/skills/`. When a task matches, the agent reads `.claude/skills/<name>/SKILL.md` (and any files it references) with its file tools.
- **Tools mode:** no filesystem, so a `load_skill` tool returns a skill's full instructions when the agent calls it with the skill's name.

## Framework Checks

```bash
pnpm check
```

Runs typechecks plus local smoke tests.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidance on adding evals and experiments, and submitting changes.
