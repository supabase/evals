---
stage: resolve
suite: regression
interface: mcp
product:
  - database
topic:
  - rls
  - security
motivation: apps/docs/content/troubleshooting/row-level-security.mdx
---

We enabled row-level security on our `documents` table but now every query
returns zero rows without any error — even though the table definitely has data.
Can you figure out why the table is empty via the API and add the right policy so
our data is actually accessible?

End your turn with a short summary of what you changed and why.
