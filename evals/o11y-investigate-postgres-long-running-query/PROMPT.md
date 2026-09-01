---
stage: investigate
suite: other
interface: mcp
product:
  - database
topic:
  - observability
  - sql
motivation: apps/docs/content/troubleshooting/timeouts.mdx
---

Our Postgres logs show a recurring query that has been running for well over a
minute — it appears in `pg_stat_activity` as active and is holding resources.
The logs suggest it's related to a sleep or long-running function. Can you
review the logs and activity, identify what's causing it, and tell us how to
stop it and prevent recurrence?

Report what you find and propose a fix.
