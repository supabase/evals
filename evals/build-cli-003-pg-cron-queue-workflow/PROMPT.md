---
stage: build
suite: benchmark
interface: cli
product:
  - database
  - edge-functions
  - cron
  - queues
topic:
  - sql
  - sdk
services:
  - gotrue
  - kong
  - postgrest
  - edge-runtime
motivation: AI-812, https://supabase.com/docs/guides/queues/consuming-messages-with-edge-functions
---

I want to set up a recurring background workflow on my local Supabase stack.

Can you set up a cron job called `enqueue-tasks` to run every minute and push a task into a queue called `tasks`? Then add a `process-tasks` edge function so an internal worker can drain the queue.
