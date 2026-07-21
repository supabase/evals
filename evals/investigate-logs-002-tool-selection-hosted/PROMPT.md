---
stage: investigate
suite: regression
interface: mcp
product:
  - edge-functions
topic:
  - observability
motivation: supabase/mcp#333 review (Rodriguespn) — verify the agent selects query_logs on hosted projects, driven by the log tool descriptions.
---

This project runs on hosted Supabase (production, on supabase.com). Pull the edge
function logs from the last 15 minutes so I can see what's been happening.
