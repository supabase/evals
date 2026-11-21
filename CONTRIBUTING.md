# Contributing

Read [README.md](README.md) for repo concepts and instructions for running evals locally.

## Adding an eval

First, determine the eval suite for your scenario:

- **Regression** evals are suitable for most scenarios. If we notice agents make a narrow mistake, we track it here to reproduce the issue, verify a fix, and monitor for regression. These scenarios are not included in the benchmark so they don't inflate scores.
- **Benchmark** evals are scenarios we've intentionally selected for the published benchmark report. These should be representative of the user journey on Supabase to cover a breadth of dimensions.
- **Docs** evals are owned by docs team for their own analysis of how agents interpret docs pages, refreshed as-needed.
- **CLI** evals are owned by the CLI team: one scenario run unchanged across forced CLI environments (Docker available / daemon unreachable / absent; pinned, stable, beta and next CLI) via the `experiments/cli/` experiments.

Then add a folder under `evals/<suite>/` containing:

1. `PROMPT.md` with frontmatter metadata and the task the agent sees.
2. `EVAL.ts` with the scorer.
3. Optional `remote/` data when the scenario needs to seed hosted project state, such as database, logs, or functions.
4. Optional `local/` files when the scenario needs to seed a local filesystem, such as a local `supabase/` project.

If your scenario contains anything not self-explanatory, consider adding a `README.md` to the folder with a brief explanation of how it's set up and what it's testing.

## Eval criteria

Every new scenario needs a `motivation:` defined in `PROMPT.md` frontmatter that cites concrete evidence for the scenario being part of the Supabase user journey, ideally a pain point. Examples include Supabase troubleshooting guides, user or support reports, GitHub or Linear issues, Slack threads, or social posts.

For new **benchmark** scenarios, we need to see at least one agent, ideally more, failing the new scenario to ensure we're getting signal from results. If agents are already acing your scenario, consider hardening it with a more ambiguous or misleading prompt, unusual seed data, or subtle footgun. Run locally and review agent failures to ensure they're legitimate reasoning mistakes, not eval framework limitations. We also want to keep benchmarks representative of the user journey. Review the [Evals coverage table](https://app.hex.tech/supabase/app/Evals-033abDlwqlTbW5ktgwFffU/latest) and make sure you're not over-indexing on a niche use case.

## Writing prompts

Prompts should reflect what a real user would send to an agent. Prompts should NOT reflect deep familiarity with Supabase nor specify every detail of a request, as users should expect agents to fill in the gaps themselves. They should be short and casual messages, not highly formatted specs.

Instead of spoonfeeding agents in the prompt, move details into seed data to let agents discover context and infer user intent. For example, a seeded database table can help agents resolve the true names of columns or preferred naming conventions for a project, seeded edge functions can provide a template for desired functionality, and inline comments can help explain a project's structure beyond what the code shows.

## Writing scorers

Prefer deterministic checks where possible because they are cheaper, faster, repeatable, and easier to debug. Avoid being overly prescriptive with the process an agent takes to reach a solution (unless critical to the scenario), prefer checking the end state by inspecting the project or filesystem.

Reserve LLM-as-a-judge checks via `ctx.judge()` for semantic or free-form outcomes where multiple valid forms make exact checks brittle.

Prefer building checks declaratively and returning the list in one place instead of accumulating checks within branching logic, so the list remains stable if one path fails.

## Adding an experiment

Add a `*.experiment.ts` file under `experiments/<suite>/` for the agent, model, and runtime setup you want to compare. Experiment discovery only scans this suite directory depth, so supporting files can live beside experiments or in nested directories. Reuse the base configs exported from `experiments/presets.ts` where they fit.

The suite folder decides which evals the experiment runs: `experiments/<suite>/` runs the evals in `evals/<suite>/`. If this experiment should be part of our published benchmark, put it in `experiments/benchmark/` and include a corresponding `*-no-skills` variant (`skills: []`) to compare results with and without skills. To run one experiment in several suites, export a shared preset from `experiments/presets.ts` and spread it in a file under each suite folder.

## Testing MCP changes

### Run local changes

Clone [the MCP repo](https://github.com/supabase/mcp) and add its root to this repo's `.env`.

```dotenv
SUPABASE_MCP_REPO_PATH=../mcp
```

Build your MCP checkout before running evals, then rebuild after edits or keep the package’s watch build running.

```bash
pnpm eval -- --suite benchmark --experiment codex-gpt-6-luna --eval resolve-dataapi-001-empty-results --runs 1
```

### Share a branch or commit

Push the MCP changes to `supabase/mcp`. Select a full commit SHA (recommended), branch, or tag in the experiment:

```ts
// MCP-interface evals
supabaseMcpServer({ revision: '<full MCP commit SHA>' })

// CLI-interface evals (search_docs only)
localStackRuntime({ mcpRevision: '<full MCP commit SHA>' })
```

To configure this broadly across experiments and interfaces, set `mcpRevision` in [`experiments/presets.ts`](experiments/presets.ts).

> [!NOTE]
> `SUPABASE_MCP_REPO_PATH` overrides `revision` on the machine running the eval.

## Adding a CLI harness

A CLI harness (Claude Code, Codex, Grok Build, Muse Code, OpenCode) lives in `packages/core/src/agents/<id>/`: a runner that installs and runs the CLI, and a parser that turns its transcript into canonical events. Before its experiments join the benchmark:

- Pin the CLI to an exact version, and to a checksum if it isn't installed from npm, so a new release can't change behavior without a diff.
- Keep the CLI's config and session state outside the workspace, set from the shell command rather than the sandbox `env` (see the Grok runner for why).
- Build the parser from real transcripts and commit trimmed copies as test fixtures. Documented formats have not matched what CLIs actually emit.
- Make harness failures (no session, rejected key, rate limit, an event the parser doesn't know) throw, so the run is recorded as errored and rerun instead of scored as a model failure.
- Declare the harness's native skills directory in `packages/sandbox/src/skills.ts`.
- Add the provider key to `BROKERED_KEYS` in `apps/framework/scripts/run-vercel-evals.ts`, the refresh workflow, and `.env.example`.
- Add paired `<name>` (`benchmark`) and `<name>-no-skills` (`no-skills`) experiments, run one tools eval and one local-stack eval in CI, and inspect the transcripts before refreshing the full benchmark.

## Submitting evals for review

Before submitting an eval for review, try running it locally to sanity check that it can complete without errors. It's okay if agents fail the eval, we just don't want them to be scored unfairly for framework limitations.

When you create a PR, run evals in GitHub Actions so reviewers can inspect results from a trusted environment.

- Add the `run-evals-changed` label to run the evals changed in your PR.
- Dispatch the [Refresh eval results](https://github.com/supabase/evals/actions/workflows/eval-refresh.yml) workflow to choose a branch, suite, experiment, or eval. For framework changes, use `suite: regression`.

After CI runs, open the workflow run summary and select **Braintrust experiments → view all**. Link the Braintrust run in your PR so reviewers can inspect the results.

To schedule a suite, add a team-owned workflow that calls [eval-refresh.yml](.github/workflows/eval-refresh.yml) with the suite and optional experiments, and add the workflow to [CODEOWNERS](.github/CODEOWNERS). See existing schedules in [.github/workflows](.github/workflows/) for reference.

## Consuming results

Local eval runs write results to disk as described in [Running evals](README.md#running-evals). Uploaded results are in the [Evals project in Braintrust](https://www.braintrust.dev/app/supabase.io/p/Evals).

Use the [Braintrust CLI](https://docs.braintrust.dev/reference/cli/quickstart) or [MCP server](https://docs.braintrust.dev/integrations/developer-tools/mcp) to query results. See the [Braintrust SQL reference](https://docs.braintrust.dev/reference/sql) for query syntax.

For internal dashboards, see the [guide to reading eval results in Hex](https://app.notion.com/p/41c5004b775f815eb9c2f0485e74de5b).

## Publishing the benchmark

The [evals web app](https://supabase.com/evals) fetches benchmark results from Braintrust at build time. To publish a benchmark, refresh every experiment in `experiments/benchmark/` in CI, then update the pins and rationales in [publication.ts](apps/web/src/data/publication.ts).

For local UI work with a partial run, temporarily keep only the uploaded experiment IDs and their rationales in the catalog and start the server with `EVALS_ALLOW_PARTIAL=1 pnpm web`.

## Reviewing an eval

Use this checklist after the author has followed [Submitting evals for review](#submitting-evals-for-review). A failing run can be useful signal, so all-green results are not required.

- Read [Eval criteria](#eval-criteria) and [Writing prompts](#writing-prompts). The `motivation:` should cite a real user problem, with the respective external link or Linear issue ID, and the prompt should have one clear, observable goal without leaking commands, schema details, or rubric language.
- Review [Writing scorers](#writing-scorers) assertion by assertion. Each check should map to a user requirement, avoid known false passes and false fails, and measure behavior instead of one implementation path. Don't turn incidental diagnostics into pass/fail checks.
- Ask for a deterministic or fixture-based check whenever it can replace `ctx.judge()`. Reserve judges for semantic or free-form outcomes where exact checks would be brittle.
- Require refreshed CI results, inspect at least one success run and each distinct failure shape, and confirm the experiment matches the intended suite, skills, runtime, hosted or local state, and any CLI or Docker assumptions.
- Classify each failure before requesting changes: agent gap, product gap, scorer bug, or harness/runtime failure. Ideally, show that the scorer rejects at least one known-bad solution or counterexample with a scorer unit test or a failing run linked in the PR.

Tag #team-ai on Slack only for framework, runtime, experiment, result schema, or contract changes; scenario wording and scorer tuning should stay with the owning team.

## Spark evals

Local runs need `SPARK_API_URL` and WARP access. For CI, configure `SPARK_API_URL`, `CLOUDFLARE_WARP_CLIENT_ID`, and `CLOUDFLARE_WARP_CLIENT_SECRET` as repository secrets.

The [Spark eval schedule](.github/workflows/spark-eval-schedule.yml) runs the suite daily and uploads results to Braintrust.

## Docs evals

The docs team owns `evals/docs/` and its results. Docs evals run without skills on a single experiment (`codex-gpt-6-luna-no-skills`, under `experiments/docs/`).

Common workflows:

- **Add or change a docs eval.** Add the scenario under `evals/docs/<id>/` (see [Adding an eval](#adding-an-eval)), open a PR, and add the `run-evals-changed` label. Find the results in the workflow run summary.
- **Refresh every docs eval.** Dispatch the [Refresh eval results](https://github.com/supabase/evals/actions/workflows/eval-refresh.yml) workflow on `main` with `suite: docs`. Find the results in the workflow run summary.
- **Analyze results over time.** See [Consuming results](#consuming-results).

## CLI evals

The CLI team owns `evals/cli/` and its results. CLI evals run on `codex-gpt-6-luna-cli-{pinned,stable,beta,next,nodaemon,absent}` under `experiments/cli/`: `pinned` runs the repo's pinned CLI version, `stable`/`beta`/`next` install the latest stable, beta or next CLI, and `nodaemon`/`absent` additionally force Docker-less sandboxes — comparing the same scenario across CLI environments. The `<model>-cli-{stable,next}` arms run the same scenario on the stable and next CLI across `claude-code-sonnet-5.5`, `claude-code-opus-5.5`, `codex-gpt-6.1-sol` and `opencode-kimi-k3`, comparing models rather than environments.

Which evals each arm picks up:

- **pinned, stable, beta, next** run every `interface: cli` eval that isn't `hostedProject: true`. The `<model>-cli-{stable,next}` matrix arms pick up the same evals as `stable` and `next`.
- **nodaemon, absent** additionally only run evals that also set `needsDocker: false` and `projectRunning: false` — the harness cannot pre-start a stack, or link a hosted project, without Docker.

Common workflows:

- **Add or change a CLI eval.** Add the scenario under `evals/cli/<id>/` (see [Adding an eval](#adding-an-eval)); set `needsDocker: false` in its `PROMPT.md` frontmatter if it can run without Docker, open a PR, and add the `run-evals-changed` label. Find the results in the workflow run summary.
- **Refresh every CLI eval.** Dispatch the [Refresh eval results](https://github.com/supabase/evals/actions/workflows/eval-refresh.yml) workflow on `main` with `suite: cli`. Find the results in the workflow run summary. Leave `cli_stable_version`/`cli_beta_version`/`cli_next_version` blank to resolve npm's latest dist-tags, or pin them to reproduce a specific run.
- **Analyze results over time.** See [Consuming results](#consuming-results).
- **Scheduled runs.** The CLI team's schedule calls [Refresh eval results](https://github.com/supabase/evals/actions/workflows/eval-refresh.yml). Results go to Braintrust.
  - Daily, 04:20 UTC: the six `codex-gpt-6-luna-cli-*` arms.
  - Weekly, other models on stable and next. See `.github/workflows/cli-eval-schedule.yml` for the schedule and experiment list.
  - Edit the cadence and experiment lists in `.github/workflows/cli-eval-schedule.yml`.
  - The shared nightly no longer runs the cli suite.
- **Run the unit tests.** `pnpm --filter @supabase-evals/framework test:cli-lib` (the CLI skip predicates in `experiments/cli/lib/` plus every CLI eval's scorer tests) — also part of `pnpm test`.
