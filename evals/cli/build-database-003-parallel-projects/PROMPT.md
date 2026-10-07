---
stage: build
interface: cli
product:
  - database
topic:
  - sql
projectRunning: false
needsDocker: false
motivation: CLI-2399, https://github.com/orgs/supabase/discussions/5968
---

I'm starting two new client projects in this sandbox, `client-a` and `client-b` — neither
exists yet, so create both from scratch — and I need local Supabase running for both of
them at the same time so I can demo them side by side.

Set each one up with its own `clients` table holding a single row naming that client —
`client-a` in one, `client-b` in the other — and then tell me which API port each project
ended up on, so I can point the right frontend at the right one.
