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

We're seeing disk I/O spikes in our Postgres metrics and occasional slowdowns
that don't match CPU usage. Someone mentioned temp file usage could be the
culprit. Can you look at the Postgres logs and query statistics and tell me
which query is spilling to disk, why it's happening, and what we should do
about it?

Report what you find and propose a concrete fix.
