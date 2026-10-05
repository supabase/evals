---
stage: build
interface: mcp
product:
  - database
  - auth
topic:
  - rls
motivation: measures how an agent finds its way through the docs, for the "Database tree duplication" IA problem. The prompt names no docs page, and EVAL.ts holds the target pages. See ../README.md before editing.
---

My app has organizations, and each user belongs to one or more of them. How do I make sure people can only read and change rows that belong to their own organization?

Use the Supabase docs at https://supabase.com/docs.
