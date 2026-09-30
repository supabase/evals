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

Our database CPU is spiking every few minutes even when user traffic is flat.
The query performance dashboard shows one query with a consistently high
execution time and it looks like it's scanning the entire orders table. Can you
dig into the query statistics and tell me what's causing the spikes and what
should be done about it?

Report what you find and propose a concrete fix.
