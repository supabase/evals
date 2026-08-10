---
stage: investigate
suite: regression
interface: mcp
product:
  - data-api
topic:
  - observability
motivation: >-
  supabase/mcp#357 (Matt Rossman review) — the query_logs tool description lists
  example log sources but the set is non-exhaustive (e.g. postgrest_logs exists
  on real projects but isn't listed). Does the agent discover available sources,
  or does it only query the ones named in the description and miss/hallucinate?
---

Our auto-generated REST API (the Data API) is failing for some requests in production, but our edge functions and database both look healthy. Look through the project's logs and tell me what's actually failing, and why.
