---
stage: resolve
suite: regression
interface: mcp
product:
  - database
topic:
  - rls
  - security
  - sql
motivation: apps/docs/content/troubleshooting/slow-queries.mdx
---

Queries against our `profiles` table have become catastrophically slow at scale
— we're seeing full table scan times even with RLS policies in place. The
SELECT policy uses a wrapper function (`current_user_id()`) that is VOLATILE,
causing Postgres to re-evaluate it for every row instead of once per query.

Please fix the SELECT policy so it calls `auth.uid()` directly (no wrapper
function), then drop the `current_user_id()` wrapper function since it's no
longer needed.

End your turn with a short summary of what you changed and why.
