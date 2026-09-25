---
stage: investigate
suite: other
interface: mcp
product:
  - database
topic:
  - observability
  - sql
motivation: apps/docs/content/troubleshooting/database-design.mdx
---

Our application is throwing "too many connections" errors under load. The Postgres
connection pool appears saturated and new connections are being refused. Can you
investigate the connection usage and tell us what's holding all the connections
and what we should do?

Report what you find and propose a fix.

> Note: This scenario cannot be fully reproduced in the eval harness (concurrent
> sessions are not possible), but the seeded pg_stat_activity snapshot reflects
> the saturation state.
