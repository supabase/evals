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
motivation: apps/docs/content/troubleshooting/high-egress-or-compute.mdx
---

Our order detail page is painfully slow and hammering the database. We fetch
orders together with their line items using the Data API's resource embedding
(`?select=*,line_items(*)`). The orders list page loads fine, but as soon as
line items are included the response time spikes to 5–8 seconds and DB CPU
shoots up. Can you figure out what's causing this and tell us what to do?

Report what you find and propose a concrete fix.
