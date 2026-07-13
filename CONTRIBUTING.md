# Contributing

Read [README.md](README.md) for repo concepts and instructions for running evals locally.

## Adding an eval

First, determine the eval suite for your scenario:

- **Regression** evals are suitable for most scenarios. If we notice agents make a narrow mistake, we track it here to reproduce the issue, verify a fix, and monitor for regression. These scenarios are not included in the benchmark so they don't inflate scores.
- **Benchmark** evals are scenarios we've intentionally selected for the published benchmark report. These should be representative of the user journey on Supabase to cover a breadth of dimensions.

Then add a folder under `evals/` containing:

1. `PROMPT.md` with frontmatter metadata and the task the agent sees.
2. `EVAL.ts` with the scorer.
3. Optional `remote/` data when the scenario needs to seed hosted project state, such as database, logs, or functions.
4. Optional `local/` files when the scenario needs to seed a local filesystem, such as a local `supabase/` project.

If your scenario contains anything not self-explanatory, consider adding a `README.md` to the folder with a brief explanation of how it's set up and what it's testing.

## Eval criteria

Every new scenario needs a `motivation:` defined in `PROMPT.md` frontmatter that cites some evidence for the scenario being a part of the Supabase user journey, ideally a pain point. Examples include support tickets, GitHub issues, Linear issues, or social media threads.

For new **benchmark** scenarios, we need to see at least one agent, ideally more, failing the new scenario to ensure we're getting signal from results. If agents are already acing your scenario, consider hardening it with a more ambiguous or misleading prompt, unusual seed data, or subtle footgun. Run locally and review agent failures to ensure they're legitimate reasoning mistakes, not eval framework limitations. We also want to keep benchmarks representative of the user journey. Review the [Evals coverage table](https://app.hex.tech/supabase/app/Evals-033abDlwqlTbW5ktgwFffU/latest) and make sure you're not over-indexing on a niche use case.

## Writing prompts

Prompts should reflect what a real user would send to an agent. Prompts should NOT reflect deep familiarity with Supabase nor specify every detail of a request, as users should expect agents to fill in the gaps themselves. They should be short and casual messages, not highly formatted specs.

Instead of spoonfeeding agents in the prompt, move details into seed data to let agents discover context and infer user intent. For example, a seeded database table can help agents resolve the true names of columns or preferred naming conventions for a project, seeded edge functions can provide a template for desired functionality, and inline comments can help explain a project's structure beyond what the code shows.

## Writing scorers

Prefer determinstic checks where possible for stability and efficiency. Avoid being overly presriptive with the process an agent takes to reach a solution (unless critical to the scenario), prefer checking the end state by inspecting the project or filesystem.

If determinstic checks are too inflexible or convoluted, use an LLM-as-a-judge check via `judge()` to check semantic correctness.

Prefer building checks declaratively and returning the list in one place instead of accumulating checks within branching logic, so the list remains stable if one path fails.

## Adding an experiment

Add a file under `experiments/` for the agent, model, and runtime setup you want to compare. Here you can configure which skills and MCP servers are available.

Select the experiment's `suite:` depending on your use case. If this experiment should be part of our published benchmark, assign `suite: ["benchmark"]` and add include a corresponding `*-no-skills` variant to compare results with and without skills. You can also assign custom experiment suites for grouping related experiments for other head-to-head comparisons as desired.

## Submitting evals for review

Before submitting an eval for review, try running it locally to sanity check that it can complete without errors. It's okay if agents fail the eval, we just don't want them to be scored unfairly for framework limitations.

When you create a PR, use GitHub Actions to refresh the results in CI so we can verify the results in a trusted environment. Currently, results are tracked in Git and committed to the repo, so the refresh results workflow can either commit result changes directly to a branch or generate a PR to propose the change.

You have a few options to run evals in CI:

- Add the `run-evals-changed` label to your PR to refresh only the `evals/` changed in that PR and commit merged results directly to your branch.
- Add the `run-evals` label to run every benchmark eval across the `benchmark` and `no-skills` experiment suites. Use this when a change can affect results broadly, such as framework changes.
- Dispatch the [Refresh eval results](https://github.com/supabase/evals/actions/workflows/eval-refresh.yml) workflow manually to target any branch and choose specific evals, experiments, or other options. It can commit results directly to the selected branch or open a separate results PR.

Include refreshed results for PRs with new/changed evals so a reviewer can see results directly from your PR or Vercel preview build.
