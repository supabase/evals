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
  - gotrue
  - kong
  - postgrest
projectRunning: true
motivation: >-
  build-dataapi-001-relational-report found every codex variant (0/4) skips
  @supabase/supabase-js for a bare backend Data API script, hand-rolling raw
  HTTP instead, while every claude-code variant (4/4) reached for it
  unprompted. A single scenario isn't enough to tell a real model tendency
  from a one-off artifact of that prompt's specific shape — this companion
  scenario keeps the same "unnamed SDK, empty package.json, backend worker
  script" shape but swaps in an unrelated schema and aggregation (inventory
  restock alerts vs. sales report) to check whether the pattern generalizes.
---

Purchasing needs a restock alert. `app/restock.mjs` has the spec in a
comment — it runs in our Node backend worker and prints a JSON list of what
needs reordering, with who to email about it.

The data lives in the Supabase project in `supabase/` (already running
locally). Finish the script and make sure it prints the right alerts.
