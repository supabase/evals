# Eval results store (AI-922)

Durable, queryable store for exported eval results in a dedicated Supabase
project, intended to replace the committed `apps/web/src/data/eval-results.json`
as the leaderboard's source of truth. Complements AI-921 (Braintrust mirror):
Braintrust reads are free but retention is limited (14d free / 30d Pro), so it
isn't durable enough for a public leaderboard; this store is.

- **Project:** `supabase-evals-results` (org: Supabase Dev, region: us-east-1)
- **Schema:** [`schema.sql`](./schema.sql) — one row per `(experiment, eval)`

## Planned next steps

- [ ] Uploader that upserts the exported snapshot into `eval_results`
      (parallels `pnpm upload:braintrust`).
- [ ] Point `apps/web` / CI at the project instead of committing the JSON.
- [ ] Decide read path for the public build (service-role at build → static JSON,
      or client read with RLS/anon).
