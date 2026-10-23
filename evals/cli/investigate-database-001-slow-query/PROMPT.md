---
stage: investigate
interface: cli
product:
  - database
topic:
  - observability
  - migrations
projectRunning: false
needsDocker: false
motivation: CLI-2712, https://linear.app/supabase/issue/CLI-2712/eval-diagnose-a-slow-query-bloat-or-locks-with-inspect-db, FDBKIN-1481, https://linear.app/supabase/issue/FDBKIN-1481/provide-tooling-to-identify-and-optimize-long-running-queries-causing, FDBKIN-1663, https://linear.app/supabase/issue/FDBKIN-1663/improve-documentation-and-visibility-of-index-usage-analysis-tools, FDBKIN-13604, https://linear.app/supabase/issue/FDBKIN-13604/fix-supabase-inspect-db-commands-failing-due-to-incorrect-search-path
area: diagnostics
journeyPhase: observe
---

Our app keeps getting slower and I'm fairly sure the database is the bottleneck. Can you use the Supabase CLI to dig into our local database, work out what's actually slow, and fix it? Make sure the fix is saved in the project so it ships with everything else, not just applied on my machine.
