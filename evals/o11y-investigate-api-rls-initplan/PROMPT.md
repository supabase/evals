---
stage: investigate
suite: regression
interface: mcp
product:
  - data-api
  - database
topic:
  - observability
  - sql
motivation: apps/docs/content/troubleshooting/slow-queries.mdx
---

Our dashboard feed takes about 800ms to load even though the posts table only
has around 5,000 rows and they fit comfortably in memory. The query performance
dashboard shows the posts SELECT with an unusually high mean execution time —
way above what the I/O cost would justify. The same query runs in under 5ms
when we bypass RLS, but it's an order of magnitude slower for authenticated
users through the API.

Can you dig into the query statistics and the RLS setup to figure out why
authenticated reads are so much slower and tell us what to fix?

Report what you find and propose a concrete fix.
