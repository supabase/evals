# Wayfinding evals

These evals measure how an agent finds its way through the Supabase docs, not
what a single page teaches. Each prompt is a developer's question with no docs
URL. The agent gets the docs root and has only `WebFetch` and the Supabase MCP
`search_docs` tool. Use the `claude-code-sonnet-5-wayfinding` experiment.

Each `EVAL.ts` names the target pages that answer the question and the facts
a correct answer covers. Two checks score a run:

- **Reached a target page.** A docs call delivered a target. The notes hold the
  wayfinding summary from `scoreWayfinding` in `@supabase-evals/core`: entry
  surface, hops to the target, each fetch with how the agent found it
  (`prompt`, `convention`, `search`, `link`, or `guess`), wrong pages, 404s,
  and search queries.
- **Answer covers the key facts.** A judge reads the final answer.

The tasks come in pairs, one pair per information architecture problem from
the docs IA audit, plus a pair for getting started. The `motivation` field in
each `PROMPT.md` names the problem.

## Editing

- Never name a docs page or its title in a prompt. The point is to see how the
  agent finds it.
- When a docs page moves, update `TARGETS`. A run can't reach a page that's
  missing from the list.

## Running

```bash
pnpm eval -- --suite wayfinding --experiment claude-code-sonnet-5-wayfinding --runs 3
```

Then summarize the runs as markdown tables, per eval and per IA problem:

```bash
pnpm wayfinding-report
```

In CI, dispatch `eval-refresh.yml` with `suite=wayfinding` and
`experiment_suite=wayfinding`. The export step skips this suite, so nothing is
published to the results site. The runs are in the `raw-results` artifact and
in Braintrust.
