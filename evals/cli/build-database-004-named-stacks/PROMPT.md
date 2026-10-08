---
stage: build
interface: cli
product:
  - database
topic:
  - sql
projectRunning: false
needsDocker: false
motivation: CLI-2401, https://linear.app/supabase/issue/CLI-2401/build-cli-008-named-stacks-destructive-workload-on-stack-test-leaves, FDBKIN-16168, https://linear.app/supabase/issue/FDBKIN-16168/allow-running-multiple-local-supabase-projects-concurrently-via-the
---

My test suite keeps wiping my dev data, so I want a `dev` stack and a `test` stack running side by side for this project. Put a couple of sample orders in each, then run our test-reset script against `test` only and confirm `dev` still has its original orders.
