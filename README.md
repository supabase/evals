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
npm install
cp .env.example .env
```

Agent-backed runs require the relevant provider key in `.env` (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)

Run one eval:

```bash
npm run eval -- --eval detect-security-001-public-table --experiment openai-gpt-5.4-mini
```

## Concepts

- An **eval** is one scenario under `evals/<id>/`. It contains the prompt, scorer, and optional seed data.
- An **experiment** is one agent/runtime/model setup under `experiments/<name>.ts`.
- Running evals means executing experiment x eval pairs and writing local result files under `results/`.

## Common Workflows

### Add an eval

1. Add a folder under `evals/`.
2. Add `PROMPT.md` with frontmatter metadata and the task the agent sees.
3. Add `EVAL.ts` with the scorer.
4. Add `seed/` data if the scenario needs project state or logs.

Test with:

```bash
npm run eval -- --eval <eval-id> --experiment <experiment-name>
```

### Add an experiment

Add a file under `experiments/` for the agent/model/runtime setup you want to compare.

### Run evals

Target a single experiment by filename stem:

```bash
npm run eval -- --experiment openai-gpt-5.4-mini
```

Target a single model id:

```bash
npm run eval -- --model gpt-5.4-mini
```

Or run everything:

```bash
npm run eval
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
product:
  - database
  - auth
topic:
  - rls
  - security
---
```

Allowed metadata values are defined in `packages/core/src/eval-metadata.ts`.

## Eval Modes

- **Tool evals** use the experiment's configured MCP servers backed by `platform-lite`. Scorers can inspect project state through helpers such as `ctx.mgmt`, `ctx.client`, `ctx.query`, `ctx.invokeFunction`, and `ctx.agentReport`.
- **Project evals** include `app/package.json` and `app/src/`. The agent edits a copied workspace with file tools only. Scoring runs Vite and withheld Vitest tests after the agent turn.

Project eval workspaces are copied under `results/<experiment>/<eval-id>/workspace/`. The agent edits only that copy. `EVAL.ts` and `tests/` are withheld during the agent turn and copied in before scoring.

## Skills

Skills come from [`supabase/agent-skills`](https://github.com/supabase/agent-skills), pinned as a git submodule at `submodules/agent-skills`. The `skills/` directory contains symlinks into the submodule.

To use a skill in an experiment, reference its directory name in the experiment's `skills` array.

## Framework Checks

```bash
npm run check
```

Runs typechecking plus the credential-free framework smoke script.
