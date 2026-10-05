## What kind of change does this PR introduce?

New eval, new experiment, scorer fix, framework change, docs update, ...

## What is the current behavior?

Please link any relevant issues here.

## What is the new behavior?

Feel free to include screenshots if it includes visual changes.

## How to Review

<!--
A reviewer should understand what this PR does within 15-30 seconds, then know where to start reading.

Non-trivial or multi-file PRs must fill in the reading path below. Trivial changes may delete this section when the review path is obvious.

- Use bold numbered areas, each with one or two indented bullets: the exact files, then what to inspect.
- Use exact repository-relative paths, and avoid line numbers while the branch is still changing.
- Keep it scannable. Don't repeat the PR purpose or the verification steps here.

For a new or changed eval, a good path is `PROMPT.md` (task + `motivation:`) -> `EVAL.ts` (scorer) -> `remote/` or `local/` seed data.
For an experiment, point at the `experiments/` file and call out the `suite:`, skills, and MCP servers it configures.
-->

1. **Review area**
   - `path/to/file`
   - What to follow or verify.

2. **Next review area**
   - `path/to/next-file`
   - What to follow or verify.

**Review questions**

<!-- Four to six short questions covering the reviewer's judgment calls. -->

- [ ] Is the change scoped, and does the behavior match the description?
- [ ] Are edge cases and failure paths handled safely?

<!-- For new or changed evals, also confirm:
- [ ] Does `motivation:` cite real evidence from the Supabase user journey?
- [ ] Does the scorer check end state and prefer deterministic checks over prescribing process?
- [ ] For a benchmark scenario, do results show agents legitimately failing rather than framework limitations?
- [ ] Is the scenario representative rather than over-indexed on a niche use case?
-->

## Verification

<!-- Include the steps and evidence for how you verified this change. -->

For new or changed evals (see [CONTRIBUTING.md](/supabase/evals/blob/main/CONTRIBUTING.md)):

- [ ] Ran the eval locally to sanity check it completes without framework errors.
- [ ] Refreshed results in CI (`run-evals-changed` / `run-evals` labels, or the Refresh eval results workflow) and included them so a reviewer can see results directly.

## Additional context

Add any other context or screenshots.
