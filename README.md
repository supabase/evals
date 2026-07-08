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

Run the benchmark against one eval:

```bash
pnpm eval -- --comparison benchmark --eval resolve-dataapi-001-empty-results
```

View results in the web app at `http://localhost:5173`:

```bash
pnpm web
```

## Concepts

The **agent** and the **environment** are decoupled: each is a reusable building block, and a **Comparison** composes them on demand. This lets one environment run against any model (and vice versa) without duplicating a coupled config per pairing.

- An **eval** is one scenario under `evals/<id>/`. It contains the prompt, scorer, and optional starting state for the two environments: `remote/` (the hosted project) and `local/` (the agent's working files).
- An **Agent** — the "who" — is one harness × model setup under `agents/<name>.ts`, authored with `defineAgent`. Reusable across any environment.
- An **Environment** — the "with-what" — is one runtime × tools × skills × (optional) local stack under `environments/<name>.ts`, authored with `defineEnvironment`. Reusable across any agent.
- A **Configuration** is an Agent × Environment — the atom the runner actually executes.
- A **Comparison** is one file under `comparisons/<name>.ts`, authored with `defineComparison`. It names a dataset (a scenario scope) plus lists of `agents` and `environments`; the runner takes their cartesian product, one **cell** (Configuration) per pairing. Where the `control` marker sits decides the shape: agents vary with no control → a **leaderboard** (`benchmark.ts`); environments vary against a control → a **head-to-head diff** (`skills-h2h.ts`).
- An **eval suite** is a named set of evals to run together (an eval's `suite` frontmatter).
- `platform-lite` exposes a Supabase Management API-compatible HTTP surface backed by [`@supabase/lite`](https://github.com/supabase/supabase-lite), so real tools like `@supabase/mcp-server-supabase` can run against a lightweight project.

## Common Workflows

### Add an eval

1. Add a folder under `evals/`.
2. Add `PROMPT.md` with frontmatter metadata and the task the agent sees.
3. Add `EVAL.ts` with the scorer.
4. Add `remote/` data if the scenario needs hosted-project state (database, logs, functions).
5. Add `local/` files if the agent starts from an existing workspace (the app or repo it edits).

### Add an agent

Add a file under `agents/` (authored with `defineAgent`) that binds a harness to a model — e.g. `claudeCodeAgent({ model: "claude-sonnet-5", reasoningEffort: "high" })`. It carries no runtime or skills, so it composes with any environment.

### Add an environment

Add a file under `environments/` (authored with `defineEnvironment`) for the runtime, tool surface, optional local stack, and skills — e.g. `{ runtime: platformLiteRuntime({ mcpServers: [supabaseMcpServer()] }), localStack: localStackRuntime(), skills: ["supabase"] }`. Build on an existing one by spreading it (see `environments/supabase-mcp-skill.ts`).

### Add a comparison

Add a file under `comparisons/` (authored with `defineComparison`) with a `dataset` scope plus `agents` and `environments` lists. Vary the `agents` for a leaderboard, or mark one `environment` as `control: true` for a head-to-head diff.

### Run a comparison

A run executes a comparison's cells (Agent × Environment) over its dataset and writes result files under `results/<cell>/<eval>.json`.

Run the whole benchmark leaderboard:

```bash
pnpm eval -- --comparison benchmark
```

Narrow to specific cells or evals (both flags are repeatable):

```bash
pnpm eval -- \
  --comparison benchmark \
  --cell claude-sonnet-5 \
  --cell claude-code-opus-4.8 \
  --eval resolve-dataapi-001-empty-results \
  --eval investigate-auth-001-deleted-user-access
```

Run the skills head-to-head:

```bash
pnpm eval -- --comparison skills-h2h
```

List the available comparisons, or a comparison's cells:

```bash
pnpm eval -- list
pnpm eval -- list --comparison benchmark
```

`--comparison` defaults to `benchmark`, so bare `pnpm eval` runs the leaderboard.

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
`suite` is required on every eval (`benchmark`, `regression`, or `other`) and scopes which evals a comparison's `dataset` can include. Narrow a run further with `--suite regression` / `--suite other` or an explicit `--eval`.
Benchmark evals should include `motivation` with the issue or other reference that explains why the scenario belongs in the suite.

## Eval Modes

There are two runtimes, chosen automatically per eval:

- **Tools evals** run the agent against the environment's MCP/tool surface (no `local/` directory, no `interface: cli`), then score the resulting project state or report.
- **Local-stack evals** run the agent inside a Docker sandbox — a `bash` tool plus file tools with the real Supabase CLI installed — so it can run `supabase init/start/db/test` against a real local stack. An eval uses this runtime when it ships a `local/` workspace **or** declares `interface: cli` (the latter covers bootstrap scenarios that start from an empty workspace).

`interface` (`mcp` | `cli`) is otherwise a benchmark dimension (a cross-team KPI label), not the runtime switch — the `local/` directory and `interface: cli` are what decide whether a sandbox boots.

### Local-stack evals

The Supabase CLI is the agent's tool; the **local stack** (the Docker services `supabase start` runs on a developer machine) is the environment it acts on — distinct from the remote/hosted platform that platform-lite mocks. Environments declare it like MCP servers and skills: add `localStack: localStackRuntime()` (from [`@supabase-evals/sandbox`](packages/sandbox/src/local-stack-runtime.ts)); environments without it skip these evals. Skills compose with the CLI tools as usual, and tool surfaces merge, so an environment can in principle expose MCP and CLI together.

**Scoring uses host tooling against an exported workspace.** After the agent finishes, the harness copies its workspace out of the sandbox to the host (`docker cp`), so scorers can run the repo-root `vite`/`vitest` against the produced files without that toolchain having to exist in the sandbox — the same build/test scoring former "project" evals used. Scorers may also run commands and SQL **inside** the sandbox (against the live stack) via the scoring context.

Local-stack evals require a running Docker daemon. Each attempt boots a fresh sandbox container that mounts the host Docker socket, so `supabase start` spawns the local stack as sibling containers; the sandbox runs with host networking, so their published ports land directly on the sandbox's `127.0.0.1` default ports. Supabase's default host ports (54321-54329) must be free — stop any local `supabase start` stacks before running.

An eval's optional `local/` directory is copied into the sandbox workspace before the agent starts. A `services:` frontmatter list declares which local-stack services the scenario needs (e.g. `gotrue`, `kong`, `postgrest`); every other service is excluded from `supabase start` — including when the agent runs it itself — to keep stack boots fast. An empty list (`services: []`) starts only the database; omit the key entirely to start the full stack.

Scorers check what the agent produced, never what the harness provisioned: with `projectRunning: true` (the default) the running stack and the seeded `local/` workspace are setup, so score only the deltas the agent made on top; with `projectRunning: false` the agent creates that state itself, so depending on it is fair game.

Test the sandbox plumbing without an agent run (Docker required, not part of `pnpm check`):

```bash
pnpm --filter @supabase-evals/sandbox test:docker
```

## Skills

Skills come from [`supabase/agent-skills`](https://github.com/supabase/agent-skills), pinned as a git submodule at `submodules/agent-skills`. The `skills/` directory contains symlinks into the submodule.

To use a skill in an environment, reference its directory name in the environment's `skills` array.

Both runtimes load skills lazily ([progressive disclosure](https://ai-sdk.dev/cookbook/guides/agent-skills)): only each skill's name+description is in the system prompt, and the agent pulls a skill's full instructions on demand. They differ only in how the body is fetched, because the tools-mode agent has no filesystem:

- **Local-stack (sandbox) mode:** skills are installed into the workspace with [Vercel's `skills` CLI](https://github.com/vercel-labs/skills) (baked into the sandbox image, sourced from the local `skills/` directory — never the network) under `.claude/skills/`. When a task matches, the agent reads `.claude/skills/<name>/SKILL.md` (and any files it references) with its file tools.
- **Tools mode:** no filesystem, so a `load_skill` tool returns a skill's full instructions when the agent calls it with the skill's name.

## Framework Checks

```bash
pnpm check
```

Runs typechecks plus local smoke tests.
