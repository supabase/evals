---
stage: investigate
suite: regression
interface: mcp
product:
  - database
topic:
  - observability
  - sql
motivation: apps/docs/content/troubleshooting/slow-queries.mdx
---

Our DBA noticed that the index on `orders.customer_id` has grown much larger
than expected relative to the number of live rows. We suspect index bloat from
heavy UPDATE activity without proper vacuuming. Can you investigate the index
health and tell me what's going on and what should be done?

Report what you find and propose a concrete fix.
