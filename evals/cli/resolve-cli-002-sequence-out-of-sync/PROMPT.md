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

Our signup job adds each new customer with the SQL in `scripts/add-customer.sql`. I run it with `supabase db query --local -f scripts/add-customer.sql`, and the customer does not get added.

Please make the signup insert work. Keep the existing customers, and leave the script as it is, because the signup job runs it unchanged. The local Supabase project in `supabase/` is already running, so apply your fix to it.
