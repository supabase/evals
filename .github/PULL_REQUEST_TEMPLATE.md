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

- For a new or changed eval, start from `PROMPT.md` (the task and `motivation:`), then `EVAL.ts` (the scorer), then any `remote/` or `local/` seed data.
- For a new or changed experiment, start from the `experiments/` file and call out the `suite:`, skills, and MCP servers it configures.
- Use bold numbered areas, each with one or two indented bullets: the exact files, then what to inspect.
- Use exact repository-relative paths, and avoid line numbers while the branch is still changing.
- Don't repeat the PR purpose or the verification steps here. Keep the section scannable.
-->

1. **Scenario**
   - `evals/<your-eval>/PROMPT.md`
   - The task the agent sees and the cited `motivation:`.

2. **Scorer**
   - `evals/<your-eval>/EVAL.ts`
   - What end state it checks, and where it uses `judge()` versus deterministic checks.

3. **Seed data**
   - `evals/<your-eval>/remote/` or `local/`
   - What project or filesystem state the scenario seeds.

**Review questions**

<!-- Four to six short questions covering the reviewer's judgment calls. -->

- [ ] Does `motivation:` cite real evidence from the Supabase user journey?
- [ ] Does the scorer check end state and prefer deterministic checks over prescribing process?
- [ ] For a benchmark scenario, do results show agents legitimately failing rather than framework limitations?
- [ ] Is the scenario representative rather than over-indexed on a niche use case?

## Verification

<!--
Include the steps and evidence. Run the eval locally to sanity check it completes without framework errors.
See CONTRIBUTING.md for the CI options (run-evals-changed / run-evals labels, or the Refresh eval results workflow).
-->

Include refreshed results (from CI or the Vercel preview) for PRs with new or changed evals, so a reviewer can see results directly.

## Additional context

Add any other context or screenshots.
