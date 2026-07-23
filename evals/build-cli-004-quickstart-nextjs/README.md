# Adding an eval for another docs guide

This guide explains how to add an eval for another AI setup prompt from the docs. The prompt can come from a quickstart page for a different framework, or from any other docs guide that gives an agent a setup prompt to follow.

1. Create a sibling folder. Name it after the guide you're adding, for example `build-cli-005-quickstart-<framework>`.
2. Copy the target prompt verbatim into `PROMPT.md`. Don't paraphrase it or add detail that the prompt doesn't already give. Keep `skills: []` and `skipCliInstall: true` in the frontmatter if the prompt has the agent install its own tooling.
3. Seed `local/` with a minimal, unmodified starter that matches the guide's context. Don't include a `supabase/` directory, so the "is Supabase already initialized" step has something real to check.
4. Reuse this eval's `EVAL.ts` checks as a starting point. Adjust the checks to match what the new guide's prompt requires, including the judge rubric's wording.
5. Validate the eval before you open a PR. Run `pnpm eval:dry -- --eval <new-eval-id> --experiment claude-code-sonnet-5` to check the setup, and then run `pnpm eval -- --eval <new-eval-id> --experiment claude-code-sonnet-5` for a full pass.

For the full eval-authoring workflow, including frontmatter fields, suite selection, and submitting for review, see `CONTRIBUTING.md`.
