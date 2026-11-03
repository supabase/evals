Copied from `evals/benchmark/build-auth-001-email-password-flow` at `158d8df7c`.

Hosted app environment. Plain profiles table replaces trigger/RLS setup; the app creates its profile. All signup, metadata/profile, wrong-password, sign-in, client-key and SDK checks retained. No isolation or trigger-support claim.

See `../EXPANDED-COMPATIBILITY.md` for results and remaining gaps.
