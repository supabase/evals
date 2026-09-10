---
stage: resolve
suite: other
interface: cli
product:
  - realtime
  - database
topic:
  - sql
  - observability
services:
  - realtime
  - postgrest
  - kong
motivation: apps/docs/content/troubleshooting/realtime.mdx
---

We're filtering our Realtime subscription on `orders.total_cents` but performance
is poor — every broadcast seems to be doing a sequential scan. Can you check
whether the filter column is indexed and add an index if it's missing?

End your turn with a short summary of what you changed and why.
