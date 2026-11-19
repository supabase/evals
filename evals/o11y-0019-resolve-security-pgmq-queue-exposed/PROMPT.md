---
stage: resolve
suite: other
interface: mcp
product:
  - queues
  - database
topic:
  - security
  - rls
motivation: apps/docs/content/troubleshooting/queues.mdx
---

Our PGMQ message queue `order_events` has no RLS policies, meaning any
authenticated user can read or delete messages from the queue. Can you lock this
down so that only the service role can access queue messages?

End your turn with a short summary of what you changed and why.

> Note: PGMQ extension is not available in the eval harness. The seeded state
> simulates the pgmq schema and queue tables that would exist on a real project.
