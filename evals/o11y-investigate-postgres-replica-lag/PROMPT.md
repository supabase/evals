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

Our application connects to a read replica for analytics queries, but users are reporting stale data — results that should reflect recent writes are returning old values. We suspect the replica has fallen significantly behind the primary. Can you check the replication lag and tell us what to do?

Report what you find and propose a fix.

> Note: `pg_stat_replication` reflects only harness-internal state. Replication lag data has been exported to a snapshot table in the database.
