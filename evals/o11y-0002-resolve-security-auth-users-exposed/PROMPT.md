---
stage: resolve
suite: regression
interface: mcp
product:
  - database
  - auth
topic:
  - security
motivation: apps/docs/content/troubleshooting/database-roles.mdx
---

A security review flagged that we have a view in our public schema that looks
like it's exposing user PII from the auth system — emails and created-at
timestamps — to anyone who can read the API. Can you confirm whether that view
is leaking data, fix it so user details are no longer exposed via the public
schema, and confirm it's resolved?

End your turn with a short summary of what you changed and why.
