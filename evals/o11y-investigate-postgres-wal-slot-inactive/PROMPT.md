---
stage: investigate
suite: other
interface: mcp
product:
  - database
topic:
  - observability
  - sql
motivation: apps/docs/content/troubleshooting/replication-slots.mdx
---

Our disk usage has been slowly growing even though data volume is flat, and
VACUUM doesn't seem to be reclaiming space. A DBA mentioned inactive replication
slots can hold WAL indefinitely. Can you check for any inactive replication slots and tell us what to do?

Report what you find and propose a fix.

> Note: Logical replication slots are not available in the eval harness. The
> slot state has been exported to `public.replication_slots_snapshot`, which
> mirrors the columns of `pg_replication_slots` on a real project.
