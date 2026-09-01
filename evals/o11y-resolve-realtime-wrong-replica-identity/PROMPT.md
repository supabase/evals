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

Our Realtime subscribers on the `orders` table are receiving UPDATE events but
`old_record` is always null, and subscriptions that filter on columns other than
the primary key silently drop events. A teammate mentioned something about
replica identity. Can you diagnose the issue and fix it?

End your turn with a short summary of what you changed and why.
