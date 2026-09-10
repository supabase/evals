---
stage: resolve
suite: regression
interface: mcp
product:
  - database
topic:
  - security
  - rls
motivation: apps/docs/content/troubleshooting/row-level-security.mdx
---

We have a view called `order_summary` that the advisor says is using
`SECURITY DEFINER` behavior — meaning it runs as its owner and bypasses any RLS
policies on the underlying tables. Any authenticated user who can SELECT from
the view can read all orders regardless of what RLS says. Can you fix it so the
view respects the caller's permissions instead?

End your turn with a short summary of what you changed and why.
