# Multi-tenant RLS

You are working on a Supabase project for a multi-tenant SaaS app.

The schema has two tables — `notes` and `memberships` — already created and
seeded. Inspect the project state if you need to.

```sql
-- notes
id uuid, org_id uuid, author_id uuid, body text, created_at timestamptz

-- memberships  (which users belong to which orgs)
user_id uuid, org_id uuid
```

Add the RLS policies needed so that authenticated users can:

1. `SELECT` notes only from orgs they are a member of.
2. `INSERT` notes only into orgs they are a member of, and only with
   `author_id = auth.uid()`.
3. `UPDATE` and `DELETE` only their own notes.

Apply the required database changes. End your turn when you believe the
policies are in place.
