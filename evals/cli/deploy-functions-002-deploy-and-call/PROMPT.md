---
stage: deploy
interface: cli
product:
  - edge-functions
topic:
  - security
projectRunning: false
needsDocker: false
motivation: CLI-2705, https://linear.app/supabase/issue/CLI-2705/eval-deploy-an-edge-function, FDBKIN-32915, https://linear.app/supabase/issue/FDBKIN-32915/fix-edge-function-deployments-that-succeed-but-result-in-404-not-found, FDBKIN-2679, https://linear.app/supabase/issue/FDBKIN-2679/fix-edge-function-deployment-failures-from-both-cli-and-dashboard, supabase/cli#5735, https://github.com/supabase/cli/issues/5735
area: edge-functions
journeyPhase: deploy
---

Our shipping quote edge function is ready. Can you deploy it to our project and make sure the live one actually responds?
