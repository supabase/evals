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

We're seeing unusual load on the database and our connection pool is under stress. Monitoring shows a lot of transaction activity, but query throughput doesn't seem to match — we think many transactions might be rolling back. Can you check whether there's a high transaction rollback ratio and tell us what to do?

Report what you find and propose a fix.

> Note: `pg_stat_database` reflects only harness-internal state. Transaction statistics have been exported to a snapshot table in the database.
