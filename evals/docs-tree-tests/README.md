# Docs tree tests

These evals are tree tests of the docs navigation. Each prompt is a developer's
goal in plain words. The agent finds the page that answers it using only the
navigation's labels, with no page content, no search, and no urls. It's the
navigate eval in `evals/docs-wayfinding/` run against a tree file instead of live
HTML, so a proposed navigation can be measured before anyone builds it.

## How it works

Each prompt ends by asking the agent to find and choose the page. The agent
has no built-in tools, only the tree navigator
(`experiments/docs/lib/tree-navigator.mjs`), whose MCP instructions explain the
tree test:

- `open_section` opens the top (`root`), a section listed in a section the
  agent has opened, or a section it opened before, to go back. It shows the
  section's labels and marks which items are sections.
- `choose_page` picks the page where the agent expects the answer. It gets one
  choice.

The trees are in `experiments/docs/trees/`:

| Tree | What it is |
| --- | --- |
| `today` | The docs navigation as it ships, exported with every sidebar group expanded and every feature flag on, as in production. Its top level is the top nav: Start, Products, Build, Manage, Reference, Resources. |
| `proposal-*` | Proposed trees. No node has more than 7 children, except a long list of pages of one kind, such as sign-in providers. Every page appears exactly once, and no tree is deeper than today's 5 levels. A tree can also split a section of a page into a new page, and choosing it counts as choosing that page. |

Each tree has an experiment, `claude-code-sonnet-5-tree-<tree>`.

## Scoring

Each `EVAL.ts` exports the `TARGETS` that answer the task and any `ALTERNATES`
that answer it as well. The tree is matched by page, so a page that a proposal
moves is still the same target.

- **Success:** the agent chose a target or an alternate.
- **Directness:** it never went back up or across the tree. A direct success is
  the standard tree test measure of a tree that works.
- **First click:** its first section from the top leads to a target.
- **Clicks:** sections opened after the top, reopened ones included. Choosing
  the page doesn't count. The navigate eval's bands apply: 0 to 3 is clean, 4
  to 6 friction, 7 to 9 failure, and 10 or more, or a wrong page, a big
  failure.

The check passes when the agent chose a target in under 10 clicks. Its notes
hold the full run from `lib/tree-test.ts`.

## Editing

- Never use a page's label or title, or a distinctive word from the labels on
  the way to it, in a prompt. Third-party names a person would say, like
  Terraform or Google Workspace, are fine.
- Every target and alternate must be a page in `today`. A page that isn't in
  the navigation can't be tree tested.
- Add a page to `ALTERNATES` only when it answers the task as fully as a
  target.

## Trees

Export today's tree from a supabase/supabase checkout:

```bash
pnpm docs-tree-export -- ../supabase
```

Build a proposal from a spec, which checks the rules:

```bash
pnpm docs-tree-build -- spec.json experiments/docs/trees/proposal-x.json
```

## Running

```bash
pnpm eval -- --suite docs-tree-tests --experiment-suite docs-tree-tests --runs 3
pnpm tree-test-report
```

In CI, dispatch `eval-refresh.yml` with `suite=docs-tree-tests` and
`experiment_suite=docs-tree-tests`, or list `experiments` to score some trees.
Nothing is published to the results site. The runs are in the `raw-results`
artifact and in Braintrust.
