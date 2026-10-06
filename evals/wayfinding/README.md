# Wayfinding evals

These evals measure whether an agent can find a docs page by following the
docs' own links, without search and without urls it remembers. Each prompt is a
developer's question with no docs url, only the docs root.

## How navigation is enforced

The agent has no built-in tools. Its only tool is `open_page` from the docs
navigator (`experiments/docs/lib/docs-navigator.mjs`), which opens the docs
root and any link listed on a page the agent has already opened, and refuses
anything else. Each page shows its text, then the links in its served HTML,
which is what a crawler or an agent fetching the page sees. A refused url is a
blocked memory jump: the agent reaching for a page it remembers.

## Arms

| Experiment | What it measures |
| --- | --- |
| `claude-code-sonnet-5-wayfinding-navigate` | The docs as they are |
| `claude-code-sonnet-5-wayfinding-navigate-linked` | The docs with the links in `experiments/docs/lib/proposed-links.ts` added, to test an IA fix before it ships |

## Scoring

Each `EVAL.ts` exports the `TARGETS` that answer the question, any
`ALTERNATES` that answer it as well, and the facts a correct answer covers.

- **Reached a target page in under 10 hops.** Hops are `open_page` calls before
  the first target, refused ones included. 0 to 3 is clean, 4 to 6 friction,
  7 to 9 failure, and 10 or more, or never reaching a target, a big failure,
  which fails the check. The notes hold the full navigation from
  `evals/wayfinding/lib/wayfinding.ts`.
- **Answer covers the key facts.** A judge reads the final answer.

`build-wayfinding-001-new-nextjs-app` is a control: its page is linked from the
docs homepage. The others cover pages that the hubs where people look don't
link.

## Editing

- Never name a docs page or its title in a prompt. The point is to see how the
  agent finds it.
- When a docs page moves, update `TARGETS`.
- Add a page to `ALTERNATES` only when it answers the task as fully as a
  target, not when it's merely related.

## Running

```bash
pnpm eval -- --suite wayfinding --experiment-suite wayfinding --runs 3
pnpm wayfinding-report
```

In CI, dispatch `eval-refresh.yml` with `suite=wayfinding` and
`experiment_suite=wayfinding`. The export step skips this suite, so nothing is
published to the results site. The runs are in the `raw-results` artifact and
in Braintrust.
