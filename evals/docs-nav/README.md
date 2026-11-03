# Docs navigation evals

Each case asks whether an agent can reach the docs page in `TARGETS` by following links from the docs root, with no search.

## Personas

| Persona | Who |
| --- | --- |
| Solo founder | Runs a SaaS alone |
| Agency developer | Builds client apps and hands them over |
| Backend engineer | Knows SQL, new to Supabase settings |
| Engineering lead | Owns team access |
| Frontend developer | Uses supabase-js, avoids SQL |
| Hobbyist | Runs a free-plan side project |

## Editing

- Never use a page's title, or a distinctive word from the links on the way to it, in a prompt.
- When a run is judged or a target moves, update `TARGETS`.

## Running

```bash
pnpm eval -- --suite docs-nav --runs 3
pnpm --filter @supabase-evals/framework exec tsx ../../experiments/docs-nav/lib/print-report.ts
```

A drop of 2 or more reached or direct cases on an arm since the last refresh is a regression. In CI, dispatch `eval-refresh.yml` with `suite=docs-nav`.
