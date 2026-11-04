---
stage: build
interface: cli
needsDocker: false
hostedProject: true
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
projectRunning: false
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

Use the connected hosted project. SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are provided in the environment. The profiles table exists, but signup triggers are not available, so the app needs to create the profile row. Leave RLS and policies out of this prototype.
