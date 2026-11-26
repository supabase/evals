---
stage: resolve
suite: other
interface: cli
product:
  - cron
  - database
topic:
  - sql
  - observability
services:
  - kong
  - postgrest
motivation: apps/docs/content/troubleshooting/cron.mdx
---

We have a cron job called `chaos-wrong-owner` that is scheduled but silently
never runs — it's owned by a role (`supabase_read_only_user`) that doesn't have
the necessary privileges to execute its statement. Can you fix the ownership so
the job actually runs?

End your turn with a short summary of what you changed and why.
