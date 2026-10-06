# Wayfinding evals

These evals measure how an agent finds its way through the Supabase docs, not
what a single page teaches. Each prompt is a developer's question with no docs
URL, only the docs root.

## Two paths

Every eval runs in two experiments that differ only in the docs search tool:

| Experiment | Docs search | What it measures |
| --- | --- | --- |
| `claude-code-sonnet-5-wayfinding-search` | Supabase MCP `search_docs` | Wayfinding as most agents do it, search first |
| `claude-code-sonnet-5-wayfinding-browse` | None | The information architecture alone: `llms.txt`, navigation, and links |

Both arms get the same agent and the same built-in tools: `WebFetch` to read
pages, and `Read`, `Grep`, and `Bash`. The last three let the search arm open a
result the CLI saved to a file for being too large. That file is one long JSON
line, so in practice only a shell tool like `jq` can read it. A `curl` of a docs
page counts as a fetch. In the browse arm, a fetch of a docs search endpoint
(`/docs/api/...`) is a workaround, and the summary counts it.

The gap between the arms, task by task, is what search contributes. A task the
browse arm fails and the search arm passes is one where the IA leaves the
agent stuck without search.

## Scoring

Each `EVAL.ts` exports the `TARGETS` that answer the question and any
`ALTERNATES` that duplicate a target, and names the facts a correct answer
covers. Reaching an alternate passes, and the summary records it, because
duplicate pages are one of the IA problems being measured. Two checks score a
run:

- **Reached a target page.** The notes hold the summary from `scoreWayfinding`
  in `@supabase-evals/core`: entry surface, hops to the target, each fetch with
  how the agent found it (`prompt`, `convention`, `search`, `link`, or
  `guess`), other pages, 404s, search queries, whether each search was
  truncated and opened, and search endpoint fetches.
- **Answer covers the key facts.** A judge reads the final answer.

A fetch of a target reaches it. So does any tool output, such as a script the
agent ran over a saved search result, that contains the target's own prose.
That's matched by fingerprints of both the published page and the search
index's copy, which can lag behind it.

The tasks come in pairs, one pair per information architecture problem from
the docs IA audit, plus a pair for getting started. The `motivation` field in
each `PROMPT.md` names the problem.

## Editing

- Never name a docs page or its title in a prompt. The point is to see how the
  agent finds it.
- When a docs page moves, update `TARGETS`. A run can't reach a page that's
  missing from the list.
- Add a page to `ALTERNATES` only when it answers the task as fully as a
  target, not when it's merely related.

## Running

```bash
pnpm eval -- --suite wayfinding --experiment-suite wayfinding --runs 3
```

Then summarize both arms as markdown tables, per eval and per IA problem, with
the arms side by side:

```bash
pnpm wayfinding-report
```

The report rescores every run with the current scorer, so older runs stay
comparable after a scorer change.

In CI, dispatch `eval-refresh.yml` with `suite=wayfinding` and
`experiment_suite=wayfinding`. The export step skips this suite, so nothing is
published to the results site. The runs are in the `raw-results` artifact and
in Braintrust.
