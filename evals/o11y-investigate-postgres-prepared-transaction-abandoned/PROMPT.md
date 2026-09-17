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

We noticed our autovacuum is not keeping up and transaction ID ages are creeping up faster than expected. A colleague mentioned orphaned prepared transactions can hold back wraparound protection. Can you check whether there are any abandoned prepared transactions and tell us what to do?

Report what you find and propose a fix.

> Note: `pg_prepared_xacts` cannot be seeded with artificial transactions in the eval harness. The prepared transaction state has been exported to a snapshot table in the database.
