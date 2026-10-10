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

We have an RLS policy defined on our `orders` table that's supposed to restrict
access to a customer's own orders — but users are reporting they can still see
each other's data. Can you figure out why the policy isn't being enforced and
fix it?

End your turn with a short summary of what you changed and why.
