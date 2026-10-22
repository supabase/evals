---
stage: investigate
interface: cli
product:
  - database
topic:
  - rls
  - tests
projectRunning: false
needsDocker: false
motivation: CLI-2710, https://linear.app/supabase/issue/CLI-2710/eval-write-and-run-rls-tests-with-test-db
area: tests-and-lint
journeyPhase: detect
---

We're launching soon and I'm nervous about our notes. Everyone should only ever be able to see their own notes, nobody else's. Can you write proper database tests for that, run them, and fix anything they turn up?
