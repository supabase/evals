---
stage: build
interface: cli
projectRunning: false
hostedProject: true
needsDocker: false
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

I want to set up a recurring background workflow on the linked hosted Supabase project.

Can you set up a cron job called `enqueue-tasks` to run every minute and push a task into a queue called `tasks`? Then add a `process-tasks` edge function that reads messages off the `tasks` queue and removes them, so a scheduled worker can keep the backlog drained.

Cron and queue extensions have not been provisioned. Include any prerequisite setup needed for the workflow.
