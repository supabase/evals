---
stage: investigate
interface: mcp
product:
  - data-api
topic:
  - sdk
motivation: Frontend developer who doesn't know how to see what Postgres does with a request sent from supabase-js. Measures whether an agent reaches a page that answers the task by following docs links. EVAL.ts holds the target pages. See ../README.md before editing.
---

I'm a frontend developer, and I do everything through supabase-js. One select with a few filters takes about four seconds, and I don't write SQL. I want to see how Postgres actually runs that exact request, straight from my JavaScript code, so I can tell what's slow. I don't know if supabase-js can show me that. Can you check the Supabase docs?
