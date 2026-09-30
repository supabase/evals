---
stage: resolve
suite: other
interface: cli
product:
  - realtime
  - database
topic:
  - rls
  - security
services:
  - realtime
  - postgrest
  - kong
motivation: apps/docs/content/troubleshooting/realtime.mdx
---

We added `orders` to our Realtime publication, but realized afterwards that RLS
is enabled with no SELECT policy — meaning Realtime is broadcasting row-level
events to subscribers who have no business seeing them. Can you add a SELECT
policy so only authorized users receive the events?

End your turn with a short summary of what you changed and why.
