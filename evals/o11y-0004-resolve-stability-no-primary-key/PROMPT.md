---
stage: resolve
suite: regression
interface: mcp
product:
  - database
topic:
  - sql
  - migrations
motivation: apps/docs/content/troubleshooting/database-design.mdx
---

We tried to turn on Realtime for our `events` table and it won't replicate, and
single-row lookups feel slow. Someone mentioned the table might be missing a
primary key. Can you check, fix whatever's wrong, and make sure existing rows
and inserts still work?

End your turn with a short summary of what you changed and why.
