---
stage: investigate
interface: mcp
product:
  - database
topic:
  - security
  - rls
motivation: https://supabase.com/docs/guides/database/postgres/row-level-security
---

You have access to the project's database schema and recent logs.

Find any customer data table that is exposed to the public API without proper
Row Level Security. Tell us the exact table, who can access it, why that is a
problem, and the SQL fix we should apply.
