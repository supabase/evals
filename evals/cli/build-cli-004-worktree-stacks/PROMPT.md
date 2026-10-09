---
stage: build
interface: cli
product:
  - database
topic:
  - migrations
projectRunning: false
needsDocker: false
motivation: FDBKIN-20391, https://linear.app/supabase/issue/FDBKIN-20391/support-running-multiple-isolated-supabase-stacks-locally-for-parallel, CLI-2400, https://linear.app/supabase/issue/CLI-2400
---

I'm kicking off a brand-new project in this sandbox. I'm about to have three
coding agents work on features in parallel, each in its own git worktree, so
set up a repo here with worktrees `feature-a`, `feature-b`, and `feature-c`,
and get a local Supabase stack running in each one. `feature-a` needs a
`widgets` table, `feature-b` needs `gadgets`, and `feature-c` needs `gizmos`,
each added via a migration. Drop one sample row in each and tell me how to
reach each stack.
