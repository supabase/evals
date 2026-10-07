---
stage: resolve
interface: cli
product:
  - database
topic:
  - sql
projectRunning: false
needsDocker: false
motivation: CLI-2402, https://linear.app/supabase/issue/CLI-2402/resolve-cli-001-stale-stack-cleanup-findrestartremove-the-right-stack
---

None of these services exist in this sandbox yet, so you'll be creating them from scratch.
First, spin up local Supabase for `checkout-service`, `payments-api`, and an old prototype
called `legacy-import`, and give each one a `service_marker` table holding a single row
naming that service. Once all three are up and seeded, make a few changes to that setup:
we killed `legacy-import` last quarter, so tear its stack down completely;
`checkout-service` has been flaky all week, so give it a restart; and leave `payments-api`
running exactly as you set it up.
