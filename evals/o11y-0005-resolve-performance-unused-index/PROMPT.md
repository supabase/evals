---
stage: resolve
suite: regression
interface: mcp
product:
  - database
topic:
  - sql
  - observability
motivation: apps/docs/content/troubleshooting/slow-queries.mdx
---

Our Postgres advisor flagged an index that has never been used in any query but
is still adding overhead to every write on the `orders` table. Can you identify
the unused index and remove it?

End your turn with a short summary of what you changed and why.
