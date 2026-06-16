---
stage: build
product:
  - database
  - edge-functions
  - cron
  - queues
topic:
  - sql
suite: benchmark
motivation: AI-812, https://supabase.com/docs/guides/ai/automatic-embeddings
---

I want to set up a recurring background workflow on my project.

Can you set up a cron job called `enqueue-tasks` to run every minute and push a task into a queue called `tasks`? Then update my `process-tasks` edge function so the internal worker can drain the queue.
