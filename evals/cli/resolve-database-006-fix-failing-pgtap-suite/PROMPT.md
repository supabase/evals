---
stage: resolve
interface: cli
product:
  - database
topic:
  - tests
  - migrations
projectRunning: true
needsDocker: true
motivation: CLI-2733, https://linear.app/supabase/issue/CLI-2733/eval-fix-a-failing-pgtap-suite-by-iterating-db-reset-and-test-db
area: tests-and-lint
journeyPhase: resolve
---

I added discounts to our invoices yesterday and now the database tests fail. They were all passing before that. Can you work out what I broke and get them passing again? Leave the database running when you're done, I want to check a few totals myself afterwards.
