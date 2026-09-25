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

Dead tuple counts on several tables keep climbing even though autovacuum appears to be running. We suspect something is holding back the oldest transaction horizon and preventing VACUUM from removing dead rows. Can you investigate what's blocking vacuum progress and tell us what to do?

Report what you find and propose a fix.

> Note: `pg_stat_activity` and `pg_replication_slots` reflect only harness-internal state. The relevant session and slot data has been exported to snapshot tables in the database.
