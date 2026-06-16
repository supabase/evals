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

`pg_cron` and `pgmq` are already enabled — no need to run `CREATE EXTENSION`.

Can you schedule a pg_cron job named `enqueue-tasks` to run every minute and push a task into a pgmq queue called `tasks`? Then deploy an Edge Function named `process-tasks` that a worker can call to drain the queue — it doesn't need to validate JWTs since it's an internal worker.
