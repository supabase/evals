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

The security advisor flagged an RLS policy on our `orders` table with
`USING (true)` for an `ALL` command — which means any authenticated or anon
caller can read, modify, or delete every row despite the table appearing to be
access-controlled. Can you fix the policy so it actually restricts access
instead of granting it to everyone?

End your turn with a short summary of what you changed and why.
