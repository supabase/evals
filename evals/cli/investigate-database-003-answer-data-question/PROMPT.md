---
stage: investigate
interface: cli
preinstallCli: true
startLocalStack: true
product:
  - database
topic:
  - sql
needsDocker: true
motivation: CLI-2735, https://linear.app/supabase/issue/CLI-2735/eval-answer-a-data-question-with-db-query-against-the-local-database
area: schema-and-migrations
journeyPhase: observe
---

How many of our customers have never placed an order? I'm sending them a win-back email today, so I need the exact number. Can you check the local database with the Supabase CLI?
