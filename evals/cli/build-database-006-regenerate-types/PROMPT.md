---
stage: build
interface: cli
product:
  - database
  - data-api
topic:
  - migrations
  - sdk
projectRunning: false
needsDocker: false
motivation: CLI-2703, https://linear.app/supabase/issue/CLI-2703/eval-regenerate-types-and-use-them-in-app-code, https://github.com/supabase/cli/issues/5283
area: type-generation
journeyPhase: design
---

I just pulled in a new migration that changes how we track whether tasks are finished, and our database types are out of date now. Can you regenerate them and update the app code to match?
