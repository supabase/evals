# Contributing

Read [README.md](README.md) for repo concepts and instructions for running evals locally.

## Adding an eval

First, determine the eval suite for your scenario:

- **Regression** evals are suitable for most scenarios. If we notice agents make a narrow mistake, we track it here to reproduce the issue, verify a fix, and monitor for regression. These scenarios are not included in the benchmark so they don't inflate scores.
- **Benchmark** evals are scenarios we've intentionally selected for the published benchmark report. These should be representative of the user journey on Supabase to cover a breadth of dimensions.
- **Docs** evals are owned by docs team for their own analysis of how agents interpret docs pages, refreshed as-needed.
- **CLI** evals are owned by the CLI team: one scenario run unchanged across forced CLI environments (Docker available / daemon unreachable / absent; pinned, stable and beta CLI) via the `cli` experiment suite.

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

Reserve LLM-as-a-judge checks via `judge()` for semantic or free-form outcomes where multiple valid forms make exact checks brittle.

Prefer building checks declaratively and returning the list in one place instead of accumulating checks within branching logic, so the list remains stable if one path fails.

## Adding an experiment

Add a `*.experiment.ts` file under `experiments/<owner>/` for the agent, model, and runtime setup you want to compare. Experiment discovery only scans this owner directory depth, so supporting files can live beside experiments or in nested directories. Reuse the base configs exported from `experiments/presets.ts` where they fit.

Select the experiment's `suite:` depending on your use case. If this experiment should be part of our published benchmark, assign `suite: ["benchmark"]` and include a corresponding `*-no-skills` variant to compare results with and without skills. You can also assign custom experiment suites for grouping related experiments for other head-to-head comparisons as desired.

## Submitting evals for review

Before submitting an eval for review, try running it locally to sanity check that it can complete without errors. It's okay if agents fail the eval, we just don't want them to be scored unfairly for framework limitations.

When you create a PR, use GitHub Actions to refresh the results in CI so we can verify the results in a trusted environment. Currently, results are tracked in Git and committed to the repo, so the refresh results workflow can either commit result changes directly to a branch or generate a PR to propose the change.

You have a few options to run evals in CI:

- Add the `run-evals-changed` label to your PR to refresh only the `evals/` changed in that PR and commit merged results directly to your branch.
- Add the `run-evals` label to run every benchmark eval across the `benchmark` and `no-skills` experiment suites. Use this when a change can affect results broadly, such as framework changes.
- Dispatch the [Refresh eval results](https://github.com/supabase/evals/actions/workflows/eval-refresh.yml) workflow manually to target any branch and choose specific evals, experiments, or other options. It can commit results directly to the selected branch or open a separate results PR.

Include refreshed results for PRs with new/changed evals so a reviewer can see results directly from your PR or Vercel preview build.

## Reviewing an eval

Start with [Eval criteria](#eval-criteria) and [Writing prompts](#writing-prompts). The `motivation:` should point to a real user problem, not just an interesting edge case. The prompt should have one clear, observable goal and withhold commands, schema details, or rubric language that would leak the intended solution.

Review [Writing scorers](#writing-scorers) check by check. For each assertion, identify the user requirement it represents and ask how it could falsely pass a wrong answer or falsely fail a valid one. Prefer behavior-level evidence over one implementation path. Keep true pass/fail expectations as assertions; use metrics for diagnostics only. If a judge checks something an exact or fixture-based check can prove, ask for the deterministic version.

Use the [Submitting evals for review](#submitting-evals-for-review) workflow to require refreshed CI results before approval. Inspect at least one success run and every distinct failure shape. Confirm the experiment environment matches the eval's intended suite, skills, runtime, hosted or local state, and any CLI or Docker assumptions.

Classify failures before requesting changes: agent gap, product gap, scorer bug, or harness/runtime failure. A failing run can be a valid product or agent gap, so an all-green result is not required. Exercise at least one intentionally wrong solution or counterexample to prove the scorer does not accept the failure mode the eval is meant to catch.

Approve when the evidence is real, the prompt and scorer measure the same outcome, no known false pass or false fail remains, and the intended CI setup produced trustworthy results. Review findings should name the exact file and line, describe the concrete false pass or false fail, and propose the smallest correction. Tag the AI team only when the PR changes eval framework behavior, runtime setup, experiment definitions, result schemas, or contracts; scenario wording and scorer tuning should stay with the owning team.

## Docs evals

The docs team owns `evals/docs/` and its results. Docs evals run without skills on a single experiment (`codex-gpt-6-luna-no-skills`).

Common workflows:

- **Add or change a docs eval.** Add the scenario under `evals/docs/<id>/` (see [Adding an eval](#adding-an-eval)), open a PR, and add the `run-evals-changed` label. Results for the changed evals are committed back to your branch and viewable in the Vercel preview.
- **Refresh every docs eval.** Dispatch the [Refresh eval results](https://github.com/supabase/evals/actions/workflows/eval-refresh.yml) workflow on `main` with `suite: docs` and `experiment_suite: docs`. It opens a draft PR with the updated `docs-eval-results.json` for you to review and merge.
- **Analyze results over time.** Every merge that changes `docs-eval-results.json` appends a snapshot to [`docs-results.jsonl`](https://supabase.github.io/evals/docs-results.jsonl) on GitHub Pages, alongside the [benchmark](https://supabase.github.io/evals/results.jsonl) and [regression](https://supabase.github.io/evals/regression-results.jsonl) histories.

## CLI evals

The CLI team owns `evals/cli/` and its results. CLI evals run on `codex-gpt-6-luna-cli-{pinned,stable,beta,nodaemon,absent}` under `experiments/cli/`: `pinned` runs the repo's pinned CLI version, `stable`/`beta` install the latest stable or beta CLI, and `nodaemon`/`absent` additionally force Docker-less sandboxes — comparing the same scenario across CLI environments.

Which evals each arm picks up:

- **pinned, stable, beta** run every `interface: cli` eval that isn't `hostedProject: true`.
- **nodaemon, absent** additionally only run evals that also set `needsDocker: false` and `projectRunning: false` — the harness cannot pre-start a stack, or link a hosted project, without Docker.

Common workflows:

- **Add or change a CLI eval.** Add the scenario under `evals/cli/<id>/` (see [Adding an eval](#adding-an-eval)); set `needsDocker: false` in its `PROMPT.md` frontmatter if it can run without Docker, open a PR, and add the `run-evals-changed` label. Results for the changed evals are committed back to your branch and viewable in the Vercel preview.
- **Refresh every CLI eval.** Dispatch the [Refresh eval results](https://github.com/supabase/evals/actions/workflows/eval-refresh.yml) workflow on `main` with `suite: cli` and `experiment_suite: cli`. It opens a draft PR with the updated `cli-eval-results.json` for you to review and merge. Leave `cli_stable_version`/`cli_beta_version` blank to resolve npm's latest dist-tags, or pin them to reproduce a specific run.
- **Analyze results over time.** Every merge that changes `cli-eval-results.json` appends a snapshot to [`cli-results.jsonl`](https://supabase.github.io/evals/cli-results.jsonl) on GitHub Pages, alongside the [benchmark](https://supabase.github.io/evals/results.jsonl), [regression](https://supabase.github.io/evals/regression-results.jsonl), and [docs](https://supabase.github.io/evals/docs-results.jsonl) histories.
- **Run the unit tests.** `pnpm --filter @supabase-evals/framework test:cli-lib` (the CLI skip predicates in `experiments/cli/lib/` plus every CLI eval's scorer tests) — also part of `pnpm check`.
