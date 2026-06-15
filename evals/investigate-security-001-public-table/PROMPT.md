---
stage: investigate
product:
  - database
topic:
  - security
  - rls
  - observability
---

You have access to the project's database schema and recent logs.

Identify any tables exposed to the public/anon role without proper Row Level
Security in place. For each issue found, report:

- The table name
- The role(s) that can access it
- Why this is a problem
- A specific fix (SQL preferred)

Be concrete. Vague answers like "consider reviewing your RLS settings" do not
count.
