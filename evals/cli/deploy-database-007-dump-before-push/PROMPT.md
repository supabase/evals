---
stage: deploy
interface: cli
product:
  - database
topic:
  - migrations
projectRunning: false
needsDocker: true
motivation: CLI-2738, https://linear.app/supabase/issue/CLI-2738/eval-dump-the-remote-database-before-a-risky-push-hosted
area: schema-and-migrations
journeyPhase: deploy
---

I've got a migration that clears out some old data we don't use anymore. Before it goes out, I want a backup of what's on the live database right now so we can restore it if anything goes wrong. Can you back it up, push the migration to our project, and tell me where the backup is?
