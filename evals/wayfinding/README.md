# Wayfinding evals

These evals measure how an agent finds its way through the Supabase docs, not
what a single page teaches. Each prompt is a developer's question with no docs
URL, only the docs root.

## Arms

Every eval runs in experiments that differ only in how the agent may reach the docs:

| Experiment | Access | What it measures |
| --- | --- | --- |
| `claude-code-sonnet-5-wayfinding-navigate` | Only `open_page` from the docs navigator | The information architecture: links only, from the docs root |
| `claude-code-sonnet-5-wayfinding-navigate-linked` | `navigate`, plus the proposed links in `PROPOSED_LINKS` | A proposed IA fix, before it ships |
| `claude-code-sonnet-5-wayfinding-browse` | `WebFetch`, `Read`, `Grep`, `Bash` | The model's memory of docs URLs, which it types directly |
| `claude-code-sonnet-5-wayfinding-closed-book` | No tools | Which answers the model knows without the docs |
| `claude-code-sonnet-5-wayfinding-search` | `browse`, plus the Supabase MCP `search_docs` tool | Search-first wayfinding |

The docs navigator, `experiments/docs/lib/docs-navigator.mjs`, opens the docs root and any link listed on a page the agent has already opened, and refuses anything else. The navigate arms have no other tools, so a result can't come from a remembered URL. Each refused URL is a blocked memory jump, and the summary counts it.

Runs are banded by hops to the target: 0 to 3 is clean, 4 to 6 friction, 7 to 9 failure, and 10 or more, or never reaching the target, a big failure.

`pnpm wayfinding-click-depth` crawls the same links the navigator shows, with no model, for the fewest clicks to each target, with and without the proposed links.

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
pnpm eval -- --suite wayfinding --experiment claude-code-sonnet-5-wayfinding-navigate,claude-code-sonnet-5-wayfinding-navigate-linked --runs 3
```

Then summarize the arms as markdown tables, per eval and per IA problem, with
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
