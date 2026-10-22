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
motivation: CLI-2710, https://linear.app/supabase/issue/CLI-2710/eval-write-and-run-rls-tests-with-test-db, FDBKIN-8983, https://linear.app/supabase/issue/FDBKIN-8983/provide-native-tooling-for-testing-and-validating-rls-policies, FDBKIN-36404, https://linear.app/supabase/issue/FDBKIN-36404/improve-the-developer-experience-and-accessibility-of-testing-rls, FDBKIN-7467, https://linear.app/supabase/issue/FDBKIN-7467/provide-a-callable-postgres-function-for-user-creation-to-aid-in-pgtap
area: tests-and-lint
journeyPhase: detect
---

We're launching soon and I'm nervous about our notes. Everyone should only ever be able to see their own notes, nobody else's. Can you write proper database tests for that, run them, and fix anything they turn up?
