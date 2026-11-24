## Problem

<!-- What's wrong or missing today, and how you know (failing runs, a user report, a Slack thread). Small PRs can replace this whole template with a couple of sentences. -->

## Changes

<!-- What this PR changes, and why this approach. -->

## How to Review

<!--
Optional. Fill this in for multi-file PRs where the reading order isn't obvious; delete it otherwise.

Give the exact repository-relative files in the order to read them, and what to check in each.
For a new or changed eval: `PROMPT.md` (task + `motivation:`) -> `EVAL.ts` (scorer) -> seed data.
For an experiment: the `experiments/` file, and the suite, skills and MCP servers it configures.

For evals, reviewers follow the checklist in CONTRIBUTING.md:
https://github.com/supabase/evals/blob/main/CONTRIBUTING.md#reviewing-an-eval
-->

## Verification

<!--
The exact commands you ran and what you saw. For an eval change, include the local command and the pass count before and after, e.g.

pnpm eval -- --eval <eval-id> --experiment <experiment> --runs 3
-->

For new or changed evals (see [Submitting evals for review](https://github.com/supabase/evals/blob/main/CONTRIBUTING.md#submitting-evals-for-review)):

- [ ] Ran the eval locally, and it completes without framework errors.
- [ ] Ran it in CI with the `run-evals-changed` label or the Refresh eval results workflow (`suite: regression` for framework changes), and linked the Braintrust run here.

<!-- Linear issue, e.g. "Closes AI-123" or "Part of AI-123". -->
