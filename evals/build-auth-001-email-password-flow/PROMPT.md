---
stage: build
suite: benchmark
interface: cli
cliVersion: 2.109.1
product:
  - auth
  - database
topic:
  - sdk
  - rls
services:
  - gotrue
  - kong
  - postgrest
projectRunning: true
motivation: >-
  The signup → profile-trigger flow is a recurring pain point
  (supabase/supabase#37497, supabase/supabase#35997, and the canonical
  pattern in https://supabase.com/docs/guides/auth/managing-user-data);
  auth is also the largest supabase-js surface with no dedicated eval
  coverage.
---

Our app in `app/` needs accounts. Wire up `app/src/auth.mjs` — the stubs in
there describe what each function should do. People sign up with an email,
password, and display name, sign back in later, and the app greets them with
their profile.

The Supabase project for this app is in `supabase/` and already running
locally. When you're done, the functions should work for real against it.
