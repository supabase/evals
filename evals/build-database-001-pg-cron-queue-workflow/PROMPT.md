---
stage: build
product:
  - database
  - functions
  - cron
  - queues
topic:
  - sql
  - pg_cron
  - pgmq
suite: benchmark
motivation: AI-812, https://supabase.com/docs/guides/ai/automatic-embeddings
---

I want to set up a recurring background workflow on my project.

Can you set up a cron job called `enqueue-tasks` to run every minute and push a task into a queue called `tasks`? Then deploy an Edge Function called `process-tasks` that an internal worker can call to drain the queue.
