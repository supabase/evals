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

The security advisor flagged an RLS policy on our `customers` table that grants
SELECT access based on `user_metadata` from the JWT — which is user-editable. Any
authenticated user can self-promote by setting `user_metadata.role = 'admin'` and
immediately read all customer rows. Can you fix the policy to use a server-controlled
claim instead?

End your turn with a short summary of what you changed and why.
