# build-auth-001-email-password-flow

Benchmark for supabase-js auth flows. The prompt is a casual "our app needs
accounts" ask pointing at stubbed functions in `local/app/src/auth.mjs`
(signUp / signIn / getMyProfile) — it never names supabase-js; the
"uses @supabase/supabase-js" check is GATING, like its precedent in
build-functions-005.

The seed teaches through data rather than the prompt: the `profiles` trigger
falls back to the email local part unless the signup sends `display_name`
as user metadata, so the "display name reaches the profile" check only
passes when the agent wires `signUp` with `options.data`. RLS on `profiles`
plus the publishable key make the client-side path the only sanctioned one;
a "no secret key in app code" check guards the boundary.

Scoring installs a small driver (`app/eval-driver.mjs`) that imports the
agent's module and exercises the contract in one process — sign up, wrong
password (must not throw), correct sign-in, profile read — then verifies
results against the database with the superuser connection.
