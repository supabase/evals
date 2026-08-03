---
motivation: derived from investigate-logs-001-top-error-function; provenance carried by the canonical eval (see evals/trigger/MAPPING.md)
stage: investigate
suite: trigger
interface: mcp
product:
  - database
topic:
  - observability
---

Identify the edge function with the most errors in the last 15 minutes.

Report:

- The function id
- The exact error count
- The total event count for that function in the same window

Use the available project observability data to answer.
