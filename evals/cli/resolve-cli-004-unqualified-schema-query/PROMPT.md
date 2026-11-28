---
stage: resolve
interface: cli
product:
  - database
topic:
  - sql
services: []
motivation: https://github.com/supabase/cli/pull/7749
customMetadata:
  area: diagnostics
  journeyPhase: resolve
  abGroup: cli-docurl
---

Finance runs the month-end revenue report with `supabase db query --local -f scripts/monthly-revenue.sql`, and it does not return a report.

Please make the report run and show the revenue per customer. Keep the data and the table definitions as they are. The local Supabase project in `supabase/` is already running, so apply your fix to it.
