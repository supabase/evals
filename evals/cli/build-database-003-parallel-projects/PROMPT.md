---
stage: build
interface: cli
product:
  - database
topic:
  - migrations
  - sql
projectRunning: false
needsDocker: false
motivation: CLI-2399, https://linear.app/supabase/issue/CLI-2399/build-cli-006-parallel-projects-two-projects-running-concurrently
---

I'm juggling two client projects in this sandbox, `client-a` and `client-b`, and I need
local Supabase running for both of them at the same time so I can demo them side by side.

Set each one up with its own `clients` table holding a single row naming that client —
`client-a` in one, `client-b` in the other — and then tell me which API port each project
ended up on, so I can point the right frontend at the right one.
