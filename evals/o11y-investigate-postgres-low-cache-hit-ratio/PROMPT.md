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

Query times have been higher than usual and our database server seems to be under more I/O load than expected. We think the buffer cache hit rate might be very low, meaning Postgres is reading data from disk instead of memory for most queries. Can you check the cache hit ratio and tell us what to do?

Report what you find and propose a fix.

> Note: `pg_stat_database` reflects only harness-internal state. Cumulative I/O statistics have been exported to a snapshot table in the database.
