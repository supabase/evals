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

We're seeing intermittent timeout errors across multiple queries and the app is becoming sluggish. Our ops team thinks there might be a lock chain where one blocked query is holding up several others. Can you check for lock wait chains in the database and tell us what to do?

Report what you find and propose a fix.

> Note: `pg_locks` and `pg_stat_activity` reflect only harness-internal state. The lock wait chain data has been exported to snapshot tables in the database.
