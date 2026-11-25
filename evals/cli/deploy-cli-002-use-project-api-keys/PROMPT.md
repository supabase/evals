---
stage: deploy
interface: cli
preinstallCli: true
product:
  - data-api
topic:
  - security
  - sdk
needsDocker: false
motivation: CLI-2736, https://linear.app/supabase/issue/CLI-2736/eval-find-a-project-fetch-its-api-keys-and-use-them-hosted
area: linking-and-login
journeyPhase: deploy
---

Can you hook this app up to our Supabase project? It can't load anything until it has the project's URL and API key. My Supabase access token is already set in the environment on this machine.
