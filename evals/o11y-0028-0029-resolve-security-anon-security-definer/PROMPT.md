---
stage: resolve
suite: regression
interface: mcp
product:
  - database
topic:
  - security
  - sql
motivation: apps/docs/content/troubleshooting/database-roles.mdx
---

The security advisor flagged that one of our database functions marked
`SECURITY DEFINER` is callable by the `anon` role — meaning unauthenticated API
callers can execute it as the function owner, with elevated privileges, and read
aggregated data they should never see. Can you revoke that access?

End your turn with a short summary of what you changed and why.
