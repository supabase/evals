---
stage: investigate
suite: other
interface: mcp
product:
  - database
topic:
  - observability
  - sql
motivation: apps/docs/content/troubleshooting/autovacuum.mdx
---

We're seeing growing dead-tuple counts on our `orders` table and table bloat is
increasing even though we have autovacuum enabled globally. The bloat advisor is
firing but autovacuum isn't cleaning it up. Can you check whether autovacuum is
disabled at the table level and propose a fix?

Report what you find and propose a fix.
