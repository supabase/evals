---
stage: build
interface: cli
product:
  - edge-functions
topic:
  - security
projectRunning: false
needsDocker: false
motivation: CLI-2704, https://linear.app/supabase/issue/CLI-2704/eval-create-and-serve-an-edge-function-locally-with-secrets, CLI-818, https://linear.app/supabase/issue/CLI-818/make-a-clearer-distinction-about-env-files-for-configtoml-and-edge, FDBKIN-11884, https://linear.app/supabase/issue/FDBKIN-11884/unify-env-file-loading-for-configtoml-and-edge-functions-in-local, FDBKIN-12716, https://linear.app/supabase/issue/FDBKIN-12716/fix-edge-runtimesecrets-to-properly-inject-secrets-into-functions
area: edge-functions
journeyPhase: design
---

The scheduler that sends our nightly digest needs an endpoint it can call. Can you build it as a Supabase edge function, using the secret we already share with the scheduler, and get it running locally so I can point the scheduler at it? Leave it running, and make sure it actually works before you hand it back.
