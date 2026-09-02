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

Autovacuum is enabled and workers are running, but many tables still have growing dead-tuple counts. We think the autovacuum worker pool might be fully saturated — all workers are busy at all times and can't keep up with the workload. Can you check whether autovacuum is saturated and tell us what to do?

Report what you find and propose a fix.

> Note: `pg_stat_activity` reflects only harness-internal state. Session and GUC data has been exported to snapshot tables in the database.
