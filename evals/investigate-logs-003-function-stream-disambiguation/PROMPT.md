---
stage: investigate
suite: regression
interface: mcp
product:
  - edge-functions
topic:
  - observability
motivation: >-
  supabase/mcp#357 (Matt Rossman review) — the query_logs description lists both
  function_edge_logs and function_logs as sources but doesn't explain what each
  represents. Does the agent understand function_edge_logs (request/invocation)
  vs function_logs (runtime console output) well enough to pick the right one?
---

Our `process-payment` edge function returns HTTP 200 for every request, so at the HTTP layer everything looks healthy — but customers are being charged the wrong amounts. I need to see what the function is actually logging from inside while it runs. What's going wrong?
