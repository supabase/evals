---
stage: deploy
interface: mcp
product:
  - database
topic:
  - security
motivation: measures whether an agent can navigate to SSL enforcement. Agents look for it under Database, which doesn’t link it; it lives under Platform. The prompt names no docs page, and EVAL.ts holds the target pages. See ../README.md before editing.
---

Some of our database clients might be connecting without encryption. How do I make our Supabase Postgres reject connections that don't use SSL?

Use the Supabase docs at https://supabase.com/docs.
