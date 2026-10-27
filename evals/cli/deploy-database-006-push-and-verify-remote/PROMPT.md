---
stage: deploy
interface: cli
product:
  - database
topic:
  - migrations
  - sql
projectRunning: false
needsDocker: false
motivation: CLI-2734, https://linear.app/supabase/issue/CLI-2734/eval-push-a-schema-change-and-verify-it-on-the-remote-with-db-query
area: schema-and-migrations
journeyPhase: deploy
---

I wrote a migration that adds subscription plans and moves our existing users onto the right one. Can you push it to our project, then check the live database to make sure the plans are there and everyone ended up on the plan they should be?
