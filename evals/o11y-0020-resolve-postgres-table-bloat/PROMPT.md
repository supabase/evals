---
stage: resolve
suite: regression
interface: mcp
product:
  - database
topic:
  - sql
  - observability
motivation: apps/docs/content/troubleshooting/autovacuum.mdx
---

The Postgres advisor flagged that our `chaos_bloat` table has severe dead-tuple
bloat — autovacuum is disabled and ~99% of rows are dead tuples taking up disk
space. Can you reclaim the space and make sure autovacuum can keep the table
clean going forward?

End your turn with a short summary of what you changed and why.
