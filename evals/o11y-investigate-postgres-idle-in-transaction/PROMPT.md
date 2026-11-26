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

Table vacuums are falling behind and we're accumulating dead tuples faster than autovacuum can clean them up. A teammate mentioned that long-running idle-in-transaction sessions can hold back the oldest transaction horizon and prevent VACUUM from making progress. Can you check for sessions that have been idle in transaction for an excessive amount of time and tell us what to do?

Report what you find and propose a fix.

> Note: `pg_stat_activity` reflects only harness-internal state. Session data has been exported to a snapshot table in the database.
