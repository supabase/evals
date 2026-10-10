---
stage: investigate
suite: other
interface: mcp
product:
  - database
topic:
  - observability
  - sql
motivation: pgbot-gap-analysis.md
---

The query planner sometimes chooses sequential scans on tables where we'd expect an index scan. We're running on SSD-backed storage (Supabase), but we're wondering if the planner's cost model is calibrated for spinning disks. Can you check the `random_page_cost` setting and tell us what to do?

Report what you find and propose a fix.
