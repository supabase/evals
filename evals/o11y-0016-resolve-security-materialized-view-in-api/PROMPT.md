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

The advisor flagged that we have a materialized view in the public schema that
any authenticated user can query. Unlike regular views, RLS cannot be applied to
materialized views — so all aggregated revenue data across every customer is
visible to any API caller. Can you fix this so the data is no longer accessible
via the API?

End your turn with a short summary of what you changed and why.
