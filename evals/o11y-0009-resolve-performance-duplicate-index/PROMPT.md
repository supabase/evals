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

Our Postgres advisor flagged a duplicate index on the `orders` table — two
indexes covering the same column, which doubles write overhead on every insert
and update without any benefit. Can you find the duplicate and remove it while
keeping the original index intact?

End your turn with a short summary of what you changed and why.
