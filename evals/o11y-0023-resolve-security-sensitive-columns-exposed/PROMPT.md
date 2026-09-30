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

Our security advisor flagged that we have a table called `api_keys` with columns
named `password` and `secret` that has no row-level security — any authenticated
user can read all API credentials via the Data API. Can you lock it down so
credentials are protected?

End your turn with a short summary of what you changed and why.
