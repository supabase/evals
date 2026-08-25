---
stage: investigate
suite: regression
interface: mcp
product:
  - edge-functions
topic:
  - observability
motivation: Edge Function console output lands in the function_logs source, which the query_logs schema hint does not list (it names edge_logs, postgres_logs and function_edge_logs) — see debugging-tools.ts and logs.ts in supabase/mcp. Checks whether an agent still finds console output when the hint omits the source it lives in.
---

I pushed a new version of our `checkout-quote` edge function this morning and it has a bunch of `console.log` lines in it, but I can't find any of that output anywhere in the dashboard.

Can you dig the output out of the project logs and tell me what the function is actually printing?
