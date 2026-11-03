---
stage: investigate
interface: mcp
product:
  - database
topic:
  - observability
motivation: Backend engineer who doesn't know which Postgres settings make the database record long-running queries and queries that error. Measures whether an agent reaches a page that answers the task by following docs links. EVAL.ts holds the target pages. See ../README.md before editing.
---

Some of our API requests take several seconds, and now and then one throws a database error, but I can't tell which queries are behind it. I want Postgres to keep a record of every query that takes more than a second, and of every query that errors. I don't know which Postgres settings do that on Supabase. What do the Supabase docs say?
