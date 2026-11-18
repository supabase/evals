---
stage: build
interface: rest
product:
  - data-api
  - database
topic:
  - sdk
motivation: >-
  Spark port of the benchmark build-dataapi-002 scenario, the companion to
  build-dataapi-001: same "unnamed SDK, empty package.json, backend worker
  script" shape with an unrelated schema and aggregation (inventory restock
  alerts vs. sales report), to check whether agents' SDK adoption for a bare
  backend Data API script generalizes. Agents defaulting to the wrong
  data-access path on a backend task is a real, documented failure
  (supabase/agent-skills#173).
---

Purchasing needs a restock alert. `app/restock.mjs` has the spec in a
comment — it runs in our Node backend worker and prints a JSON list of what
needs reordering, with who to email about it.

The data lives in the provided Spark project (already running). Finish the
script and make sure it prints the right alerts.
