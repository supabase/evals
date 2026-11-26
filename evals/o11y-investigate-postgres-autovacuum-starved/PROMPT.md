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

Several tables have large dead-tuple counts and are growing despite autovacuum being enabled and not saturated. We think specific tables might be effectively starved — autovacuum workers aren't reaching them often enough to keep up with the write rate. Can you check whether any tables have accumulated excessive dead tuples without being vacuumed recently?

Report what you find and propose a fix.

> Note: `pg_stat_user_tables` reflects only harness-internal state. Table vacuum statistics have been exported to a snapshot table in the database.
