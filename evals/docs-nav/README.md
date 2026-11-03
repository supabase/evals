# Docs navigation evals

Each case asks whether an agent can reach the docs page in `TARGETS` by following links from the docs root, with no search.

This suite is a [tree test](https://www.nngroup.com/articles/tree-testing/). Tree tests are a common way to check whether people can find things in an information architecture, and they usually run with human participants. Here an agent stands in for each participant, and the tree is the live docs navigation.

## Personas

| Persona | Who | Knows a lot about | Doesn't know |
| --- | --- | --- | --- |
| Solo founder | Builds and runs a SaaS alone | Their own app and its code | Supabase features they haven't used yet |
| Agency developer | Builds client apps and hands each project over at launch | Shipping apps with frameworks like Next.js | What a client's Supabase project needs beyond the app |
| Backend engineer | Works at a startup | SQL and Postgres | Where Supabase keeps its settings |
| Engineering lead | In charge of team access | The team's tools and company accounts | How Supabase handles team members |
| Frontend developer | Works through supabase-js | JavaScript and supabase-js | SQL or what happens inside Postgres |
| Hobbyist | Runs a side project on the free plan | The basics of their app | Anything past the Supabase quickstart |

## Scoring

- **Tree:** the scorer loads `/docs/nav-tree.json` from the docs the run opened, for that run's variant.
- **Pass:** the agent reaches a target in no more hops than the tree has levels.
- **No wrong turns:** every page the agent opens before the target is the target or one of its tree ancestors. This is the headline measure.
- **Nav-only arms:** the navigator lists only links inside `data-docs-nav` regions, so page bodies can't shortcut the tree.
- **The bar:** Option 1 nav-only beats control nav-only by at least 20 points on cases with no wrong turns.

## Editing

- Open every prompt with the persona frame: who they are, what they know a lot about, what they don't know, and an instruction to stay in that role. Then give the situation in the persona's words.
- Never use a page's title, or a distinctive word from the links on the way to it, in a prompt.
- When a run is judged or a target moves, update `TARGETS`.
- When control's answer is on a different page, add it to `CONTROL_TARGETS`.

## Running

```bash
pnpm eval -- --suite docs-nav --runs 3
pnpm --filter @supabase-evals/framework exec tsx ../../experiments/docs-nav/lib/print-report.ts
```

A drop of 2 or more cases with no wrong turns on an arm since the last refresh is a regression. In CI, dispatch `eval-refresh.yml` with `suite=docs-nav`.
