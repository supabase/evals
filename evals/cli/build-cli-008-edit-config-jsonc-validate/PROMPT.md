---
stage: build
interface: cli
product:
  - auth
  - storage
topic:
  - security
projectRunning: false
needsDocker: false
motivation: CLI-2872, https://linear.app/supabase/issue/CLI-2872/agent-eval-configtoml-vs-configjsonc-with-config-validate, supabase/cli#5894, https://github.com/supabase/cli/issues/5894
customMetadata:
  area: config-and-secrets
  journeyPhase: design
---

Before we put staging live I need a few auth/storage changes in our Supabase config: people should have to confirm their email before they can sign in, https://staging.orders-app.dev/auth/callback needs to be an allowed redirect, uploads should allow files up to 100MB, and turn on GitHub login — the GitHub OAuth app's credentials are already in our env file.
