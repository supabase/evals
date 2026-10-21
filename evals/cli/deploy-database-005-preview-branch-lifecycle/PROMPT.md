---
stage: deploy
interface: cli
product:
  - database
topic:
  - migrations
projectRunning: false
needsDocker: false
motivation: CLI-2709, https://linear.app/supabase/issue/CLI-2709/eval-create-use-and-clean-up-a-preview-branch, FDBKIN-15580, https://linear.app/supabase/issue/FDBKIN-15580/clarify-billing-and-lifecycle-of-non-pr-linked-preview-branches-in, FDBKIN-26777, https://linear.app/supabase/issue/FDBKIN-26777/increase-the-50-active-preview-branch-limit-for-cli-created-branches, supabase/cli#3088, https://github.com/supabase/cli/issues/3088
area: branching
journeyPhase: deploy
---

I've just written a new migration and I don't want it anywhere near production until I've seen it work. Can you spin up a preview branch of our project, try the migration out on it, check it actually does what it's meant to, and then clean the branch up?
