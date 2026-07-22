## Adding another docs quickstart test

This guide explains how to add an eval for another AI setup prompt from the docs, such as a different framework's quickstart page.

1. Create a sibling folder, for example `build-cli-005-quickstart-<framework>`.
2. Copy the target prompt verbatim into `PROMPT.md`. Don't paraphrase it or add detail that the prompt doesn't already give.
3. Seed `local/` with a minimal, unmodified starter for that framework. Don't include a `supabase/` directory, so the "is Supabase already initialized" step has something real to check.
4. Reuse this eval's `EVAL.ts` checks. Change only the judge rubric's framework-specific wording.
5. Validate the eval before you open a PR. Run `pnpm eval:dry -- --eval <new-eval-id> --experiment claude-code-sonnet-5` to check the setup, then run `pnpm eval -- --eval <new-eval-id> --experiment claude-code-sonnet-5` for a full pass.

For the full eval-authoring workflow, including frontmatter fields, suite selection, and submitting for review, see `CONTRIBUTING.md`.
