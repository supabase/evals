---
motivation: derived from resolve-security-001-rls-cross-user-leak; provenance carried by the canonical eval (see evals/trigger/MAPPING.md)
stage: investigate
suite: trigger
interface: mcp
product:
  - database
topic:
  - rls
---

Audit the RLS policies on this Supabase project.

If any policy lets one authenticated user access another user's data, fix it in
the database. Do not weaken existing legitimate access.

End your turn when you believe the policies are correct.
