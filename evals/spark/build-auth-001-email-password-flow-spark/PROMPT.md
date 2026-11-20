---
stage: build
interface: rest
product:
  - auth
  - database
topic:
  - sdk
  - rls
motivation: >-
  Spark port of the benchmark build-auth-001 scenario. The signup → profile
  trigger is the one deliberate deviation: Spark has no plpgsql functions or
  triggers on auth.users, so the app creates the profile row itself after
  signup, and the prompt says so. Auth is also the largest supabase-js surface
  with no dedicated eval coverage.
---

Our app in `app/` needs accounts. Wire up `app/src/auth.mjs` — the stubs in
there describe what each function should do. People sign up with an email,
password, and display name, sign back in later, and the app greets them with
their profile. Every new account needs a row in the `profiles` table with its
display name, created as part of signing up.

The backend for this app is the provided Spark project (already
running). When you're done, the functions should work for real against it.
