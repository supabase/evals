---
stage: build
suite: regression
interface: cli
product:
  - database
topic:
  - migrations
  - sql
services: []
projectRunning: false
motivation: https://linear.app/supabase/issue/CLI-2398/add-a-docker-less-local-stack-e2e-eval-agent-cli-lifecycle
---

I'm setting up a brand-new Supabase project in this sandbox. Initialize it, start the
local stack, and add a `notes` table with a couple of sample rows via a migration so I
can confirm the schema and seed data are actually there. Show me the rows once it's done.
