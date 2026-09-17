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

Our database has been running for a long time without a VACUUM FREEZE pass and we're worried about transaction ID wraparound. Postgres will refuse writes and shut down to protect data integrity if the transaction ID counter gets too close to the limit. Can you check whether any database is approaching transaction ID exhaustion and tell us what to do?

Report what you find and propose a fix.

> Note: `pg_database` system catalog values reflect the eval harness state and won't show production-realistic ages. Transaction age data has been exported to a snapshot table in the database.
