---
stage: resolve
interface: cli
product:
  - database
topic:
  - security
  - sql
projectRunning: false
needsDocker: false
motivation: CLI-2711, https://linear.app/supabase/issue/CLI-2711/eval-run-lint-or-advisors-and-fix-what-they-flag, FDBKIN-21143, https://linear.app/supabase/issue/FDBKIN-21143/enable-security-and-performance-advisor-for-local-development-via-the, FDBKIN-3130, https://linear.app/supabase/issue/FDBKIN-3130/expose-security-and-performance-advisor-results-in-the-supabase-cli, supabase/cli#3839, https://github.com/supabase/cli/issues/3839, supabase/cli#5868, https://github.com/supabase/cli/issues/5868
area: tests-and-lint
journeyPhase: resolve
---

We're about to launch and I want the database in good shape first. Can you run Supabase's database checks on our local database and fix whatever they flag?
