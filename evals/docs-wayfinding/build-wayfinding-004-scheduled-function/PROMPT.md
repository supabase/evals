---
stage: build
interface: mcp
product:
  - edge-functions
  - cron
topic:
  - sql
motivation: measures whether an agent can navigate from Cron to the guide for scheduling an Edge Function. The Cron pages don’t link it, so agents stop at the Cron quickstart. The prompt names no docs page, and EVAL.ts holds the target pages. See ../README.md before editing.
---

I wrote an Edge Function that cleans up old records. I want it to run automatically every night at 2am. What's the way to do that on Supabase?

Use the Supabase docs at https://supabase.com/docs.
