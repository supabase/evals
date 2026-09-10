---
stage: investigate
suite: other
interface: mcp
product:
  - database
topic:
  - sql
  - observability
motivation: apps/docs/content/troubleshooting/database-design.mdx
---

Something is wrong with our `orders` data — every order we insert ends up with
`total_cents = 0` regardless of what value we pass in. There's no error, no
exception, the insert succeeds, but the value is always zeroed out. Can you
investigate what's silently corrupting the data and propose a fix?

Report what you find.
