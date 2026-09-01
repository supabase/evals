---
stage: resolve
suite: other
interface: cli
product:
  - realtime
  - database
topic:
  - sql
services:
  - realtime
  - postgrest
  - kong
motivation: apps/docs/content/troubleshooting/realtime.mdx
---

We set up a Realtime subscription on our `realtime_events` table but we're not
receiving any events even though we're definitely inserting rows. The table has a
primary key and RLS is enabled — something else must be wrong. Can you figure
out why Realtime isn't delivering events for this table and fix it?

End your turn with a short summary of what you changed and why.
