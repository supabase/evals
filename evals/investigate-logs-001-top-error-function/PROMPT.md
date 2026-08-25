---
stage: investigate
suite: other
interface: mcp
product:
  - edge-functions
topic:
  - observability
---

Identify the edge function with the most errors in the last 15 minutes.

Report:

- The function id
- The exact error count
- The total event count for that function in the same window

Count edge function invocation events (one row per invocation), not gateway
request rows.

Use the available project observability data to answer.
