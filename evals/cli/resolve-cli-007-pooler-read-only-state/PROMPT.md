---
stage: resolve
interface: cli
product:
  - database
topic:
  - sql
services:
  - supavisor
motivation: https://github.com/supabase/cli/pull/7749
customMetadata:
  area: diagnostics
  journeyPhase: resolve
  abGroup: cli-docurl
---

Our nightly report and our order signup job both connect through the local pooler at `postgresql://postgres.pooler-dev:postgres@127.0.0.1:54329/postgres?sslmode=disable`. The report runs first, with `psql "$POOLER_URL" -f scripts/nightly-report.sql`. The signup job runs next, with `supabase db query --remote "$POOLER_URL" --yes -f scripts/add-order.sql`, and it fails.

Please make both jobs work in that order, and keep the report from writing anything. The local Supabase project in `supabase/` is already running, so apply your fix to it.
