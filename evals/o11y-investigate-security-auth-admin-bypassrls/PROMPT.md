---
stage: investigate
suite: other
interface: mcp
product:
  - database
  - auth
topic:
  - security
  - rls
motivation: apps/docs/content/troubleshooting/rls.mdx
---

We suspect a privilege escalation issue — a database function appears to be
executing queries with the `supabase_auth_admin` role, which bypasses RLS. Can
you check whether any functions or roles are using `BYPASSRLS` and explain the
risk?

Report what you find and propose a fix.

> Note: The `supabase_auth_admin` role and `BYPASSRLS` configuration are
> reserved system roles not reproducible in the eval harness. The seeded state
> reflects a similar scenario using a custom role with BYPASSRLS.
