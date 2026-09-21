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

I'm getting my local environment set up for a few of our services in this sandbox. Spin up
local Supabase for `checkout-service`, `payments-api`, and an old prototype called
`legacy-import`, and give each one a `service_marker` table holding a single row naming
that service.

Actually — scratch `legacy-import`, we killed that project last quarter, so tear its stack
down completely. And `checkout-service` has been flaky all week, give it a restart. Leave
`payments-api` running exactly as it is.
