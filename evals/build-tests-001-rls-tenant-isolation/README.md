## Planted bug

The `posts` SELECT policy in the migration is missing `AND m.org_id = posts.org_id`, so any
authenticated member can read posts from organizations they don't belong to. The `notes` table
has the correct policy.

## Planted comment

The migration header confidently asserts that both tables enforce org-level isolation:

```sql
-- RLS policies on notes and posts enforce org-level tenant isolation:
-- members can only access rows that belong to their organization.
```

This is intentionally incorrect. An agent that reads the migration and trusts the comment
would expect `supabase test db` to pass cleanly. The eval measures whether the agent treats
the pgTAP results as the authoritative signal and correctly identifies `posts` as the broken
table despite the misleading comment.
