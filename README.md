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

## CLI version matrix

Local-stack evals install a pinned Supabase CLI (`SUPABASE_CLI_VERSION` in `packages/sandbox/src/supabase.ts`). The CLI version matrix compares agent capability across CLI versions, so the CLI team gets a signal when a release adds or breaks an agent capability:

- **Version arms** are experiments sharing one no-skills configuration that differ only in `localStackRuntime({ cliVersion })` (built by `experiments/lib/cli-version-matrix.ts`): `claude-code-sonnet-5-cli-pin` (the repository pin) and `claude-code-sonnet-5-cli-beta` (the latest supabase/cli prerelease, from `SUPABASE_CLI_BETA_VERSION`; skips every eval when unset). Arms run without skills so the delta measures raw CLI capability, and they skip evals where the version under test can't apply: frontmatter `cliVersion` pins (they override the experiment's version), `skipCliInstall` evals (the agent installs its own CLI), and evals whose `interface` isn't `cli`.
- Every local-stack result records `resolvedCliVersion` — the `supabase --version` actually reported inside the sandbox — so reports never trust the requested pin.

Run a manual version A/B (the repository pin vs a beta version you resolve yourself):

```bash
SUPABASE_CLI_BETA_VERSION=2.115.1-beta.6 pnpm eval -- --suite regression --runs 2 \
  --experiment claude-code-sonnet-5-cli-pin \
  --experiment claude-code-sonnet-5-cli-beta

pnpm compare-results -- \
  --baseline results/claude-code-sonnet-5-cli-pin \
  --candidate results/claude-code-sonnet-5-cli-beta
```

`compare-results` prints a per-scenario markdown verdict table — `IMPROVED (FAIL→PASS)`, `REGRESSED (PASS→FAIL)`, or the checks-score delta — pasteable into Slack or a Linear comment (`--output delta.md` to also write a file).

The nightly regression cron (`eval-refresh.yml`) runs both arms, resolving the latest supabase/cli prerelease into `SUPABASE_CLI_BETA_VERSION`, and publishes the pin-vs-beta delta table as the workflow run summary plus a `cli-version-delta` artifact. The delta is informational only: a person reviews it and files supabase/cli issues for real regressions.

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
