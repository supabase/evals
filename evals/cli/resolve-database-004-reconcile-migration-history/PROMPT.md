---
stage: resolve
interface: cli
product:
  - database
topic:
  - migrations
projectRunning: false
needsDocker: false
motivation: CLI-2702, https://linear.app/supabase/issue/CLI-2702/eval-reconcile-local-and-remote-migration-history, FDBKIN-8289, https://linear.app/supabase/issue/FDBKIN-8289/improve-cli-guidance-for-syncing-missing-remote-migrations-locally, FDBKIN-7637, https://linear.app/supabase/issue/FDBKIN-7637/improve-cli-tooling-for-diagnosing-and-repairing-migration-history, FDBKIN-8223, https://linear.app/supabase/issue/FDBKIN-8223/improve-the-process-for-recovering-from-a-desynchronized-migration, supabase/cli#3493, https://github.com/supabase/cli/issues/3493
area: schema-and-migrations
journeyPhase: resolve
---

Our local migrations and the migration history on our hosted project don't match any more, and I'm not sure how they drifted apart. Can you work out what happened and get them back in line? Prod has real user data, so don't lose any of it.
