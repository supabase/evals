---
stage: investigate
suite: regression
interface: mcp
product:
  - edge-functions
topic:
  - observability
  - self-hosting
motivation: supabase/mcp#333 review (Rodriguespn) — verify the agent falls back to get_logs on self-hosted projects, where ClickHouse-backed query_logs is unavailable.
---

This is a self-hosted Supabase instance (running via the self-hosting Docker
setup, not on supabase.com). Pull the edge function logs from the last 15 minutes
so I can see what's been happening.
