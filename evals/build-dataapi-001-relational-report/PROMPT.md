---
stage: build
suite: benchmark
interface: cli
cliVersion: 2.109.1
product:
  - data-api
  - database
topic:
  - sdk
services:
  - kong
  - postgrest
projectRunning: true
motivation: >-
  Relationship embedding is the query-builder surface users trip on most
  (supabase/postgrest-js#609, supabase/postgrest-js#611,
  supabase/supabase-js#1639), and the most-used supabase-js surface had no
  dedicated eval coverage.
---

We need the nightly sales report working. `app/report.mjs` has the spec in a
comment — it runs in our Node backend worker and prints a JSON summary of what
each customer has ordered.

The data lives in the Supabase project in `supabase/` (already running
locally). Finish the script and make sure it prints the right numbers.
