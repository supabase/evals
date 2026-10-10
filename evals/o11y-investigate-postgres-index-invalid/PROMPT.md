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

We tried to add an index on a busy table last week using `CREATE INDEX CONCURRENTLY` but the operation was interrupted. We're not sure if the index was left in a broken state. Can you check whether there are any invalid indexes in the database and tell us what to do?

Report what you find and propose a fix.

> Note: `pg_index` does not reflect indexes with `indisvalid = false` in the eval harness the same way a real instance would after a failed `CREATE INDEX CONCURRENTLY`. The index state has been exported to a snapshot table in the database.
