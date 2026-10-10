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

A security scan flagged that one of our database functions is marked
`SECURITY DEFINER` but doesn't pin its `search_path`. This means an attacker
could shadow system functions by creating objects in a schema that appears
earlier on the search path, and our function would execute them with elevated
privileges. Can you find the vulnerable function and fix it?

End your turn with a short summary of what you changed and why.
