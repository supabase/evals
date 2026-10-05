---
stage: deploy
interface: mcp
product:
  - database
topic:
  - migrations
motivation: measures how an agent finds its way through the docs, for the "Database tree duplication" IA problem. The prompt names no docs page, and EVAL.ts holds the target pages. See ../README.md before editing.
---

I've been changing my schema by hand in the dashboard and now I have a staging project and a production project that don't match. How should I manage schema changes so both stay in sync?

Use the Supabase docs at https://supabase.com/docs.
