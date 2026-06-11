# Supabase Evals

This repo answers how well can agents use Supabase across various tasks.

## Quickstart

Clone with submodules:

```bash
git clone --recurse-submodules git@github.com:supabase-org/supabase-evals.git
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

Run one eval:

```bash
pnpm eval -- --eval detect-security-001-public-table --experiment openai-gpt-5.4-mini --runs 1 --force
```

View results in the web app at `http://localhost:5173`:

```bash
pnpm web
```

## Concepts

- An **eval** is one scenario under `evals/<id>/`. It contains the prompt, scorer, and optional seed data.
- An **experiment** is one agent/runtime/model setup under `experiments/<name>.ts`.
- An **agent** is the model driver that receives the eval prompt and calls the configured tools.
- A **runtime** is the local Supabase-like environment and tool surface an experiment gives to the agent.
- `platform-lite` exposes a Supabase Management API-compatible HTTP surface backed by [`@supabase/lite`](https://github.com/supabase/supabase-lite), so real tools like `@supabase/mcp-server-supabase` can run against a lightweight project.

## Common Workflows

### Add an eval

1. Add a folder under `evals/`.
2. Add `PROMPT.md` with frontmatter metadata and the task the agent sees.
3. Add `EVAL.ts` with the scorer.
4. Add `seed/` data if the scenario needs project state or logs.

### Add an experiment

Add a file under `experiments/` for the agent/model/runtime setup you want to compare.

### Run evals

Running evals executes experiment x eval pairs and writes local result files under `results/`.

Target a single experiment by filename stem:

```bash
pnpm eval -- --experiment openai-gpt-5.4-mini --runs 1 --force
```

Target multiple experiments or eval scenarios by repeating flags:

```bash
pnpm eval -- \
  --experiment openai-gpt-5.4-mini \
  --experiment openai-gpt-5.4-nano \
  --suite benchmark \
  --eval detect-security-001-public-table \
  --eval observe-db-001-table-row-counts \
  --runs 1 \
  --force
```

Target a single model id:

```bash
pnpm eval -- --model gpt-5.4-mini
```

> [!NOTE]
> Use `--runs 1 --force` when you want a fresh single-attempt result. Without `--force`, existing result files are skipped; without `--runs 1`, the runner defaults to up to four attempts with stop-on-pass.

Or run everything:

```bash
pnpm eval
```

## Eval Shape

Every eval contains:

1. `PROMPT.md` - frontmatter metadata plus the task description the agent sees.
2. `EVAL.ts` - a default-exported scorer.
3. Optional `seed/project.sql` - applied to a fresh Supabase-like project DB.
4. Optional `seed/logs.jsonl` - seeded observability log rows.

`PROMPT.md` frontmatter drives eval discovery and site filters:

```md
---
stage: design
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
Benchmark evals should include `motivation` with the issue or other reference that explains why the scenario belongs in the suite.

## Eval Modes

- **Tool evals** run the agent against the experiment's MCP/tool surface, then score the resulting project state or report.
- **Project evals** copy an app workspace for the agent to edit with file tools, then may score with Vite and withheld Vitest tests or file inspection.

## Skills

Skills come from [`supabase/agent-skills`](https://github.com/supabase/agent-skills), pinned as a git submodule at `submodules/agent-skills`. The `skills/` directory contains symlinks into the submodule.

To use a skill in an experiment, reference its directory name in the experiment's `skills` array.

## Framework Checks

```bash
pnpm check
```

Runs typechecks plus local smoke tests.
