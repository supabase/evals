# Docs navigation evals

Each case asks whether an agent can reach the docs page in `TARGETS` by following links from the docs root, with no search.

## Personas

| Persona | Who | Knows a lot about | Doesn't know |
| --- | --- | --- | --- |
| Solo founder | Builds and runs a SaaS alone | Their own app and its code | Supabase features they haven't used yet |
| Agency developer | Builds client apps and hands each project over at launch | Shipping apps with frameworks like Next.js | What a client's Supabase project needs beyond the app |
| Backend engineer | Works at a startup | SQL and Postgres | Where Supabase keeps its settings |
| Engineering lead | In charge of team access | The team's tools and company accounts | How Supabase handles team members |
| Frontend developer | Works through supabase-js | JavaScript and supabase-js | SQL or what happens inside Postgres |
| Hobbyist | Runs a side project on the free plan | The basics of their app | Anything past the Supabase quickstart |

## Editing

- Open every prompt with the persona frame: who they are, what they know a lot about, what they don't know, and an instruction to stay in that role. Then give the situation in the persona's words.
- Never use a page's title, or a distinctive word from the links on the way to it, in a prompt.
- When a run is judged or a target moves, update `TARGETS`.

## Running

```bash
pnpm eval -- --suite docs-nav --runs 3
pnpm --filter @supabase-evals/framework exec tsx ../../experiments/docs-nav/lib/print-report.ts
```

A drop of 2 or more reached or direct cases on an arm since the last refresh is a regression. In CI, dispatch `eval-refresh.yml` with `suite=docs-nav`.
