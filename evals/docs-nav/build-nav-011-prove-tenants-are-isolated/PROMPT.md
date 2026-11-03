---
stage: build
interface: mcp
product:
  - database
topic:
  - rls
  - tests
motivation: Backend engineer who doesn't know which tool can check the database's access rules on their own. Measures whether an agent reaches a page that answers the task by following docs links. EVAL.ts holds the target pages. See ../README.md before editing.
---

Our app is multi-tenant. I wrote access rules in the database so users only see rows that belong to their own company. Before every deploy, I want CI to prove that a user from one company can't read another company's rows. I don't know what tool can check rules that live inside Postgres. Can you find what the Supabase docs recommend?
