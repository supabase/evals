---
stage: deploy
interface: cli
product:
  - edge-functions
topic:
  - security
projectRunning: false
needsDocker: false
motivation: CLI-2737, https://linear.app/supabase/issue/CLI-2737/eval-download-a-deployed-edge-function-edit-it-and-redeploy-hosted, CLI-2705, https://linear.app/supabase/issue/CLI-2705/eval-deploy-an-edge-function, supabase/cli#5349, https://github.com/supabase/cli/issues/5349, supabase/cli#5000, https://github.com/supabase/cli/issues/5000, supabase/cli#4788, https://github.com/supabase/cli/issues/4788
area: edge-functions
journeyPhase: deploy
---

Customers keep telling us their promo codes get rejected when they type them in lowercase. The edge function that checks codes is live on our project, but nobody ever committed its code to this repo. Can you fix it and get the fix live?
