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

Our database CPU has been elevated all morning — around 60–70% — but traffic
looks normal. We have several API endpoints in use. Can you figure out which
endpoint is driving the database load and what's causing it?

Report what you find and propose a concrete fix.
