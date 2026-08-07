---
stage: investigate
suite: regression
interface: mcp
product:
  - edge-functions
topic:
  - observability
motivation: supabase/mcp#333 review (Rodriguespn) — verify the agent successfully uses query_logs to investigate edge function logs. get_logs is hidden from tools/list on this platform (it only shows up when the platform lacks ClickHouse-backed querying, which platform-lite here does not simulate), so this exercises query_logs end-to-end rather than a choice between two listed tools.
---

Pull the edge function logs from the last 15 minutes so I can see what's been happening.
