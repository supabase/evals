---
stage: build
suite: other
product:
  - database
  - auth
topic:
  - rls
  - security
---

You are working on a Supabase project for a multi-tenant document app.

The schema has three tables already created and seeded:

```sql
-- memberships
user_id uuid, org_id uuid, role text

-- documents
id uuid, org_id uuid, owner_id uuid, title text, body text, deleted_at timestamptz

-- document_audit
id uuid, document_id uuid, actor_id uuid, action text, ts timestamptz
```

Add the RLS policies and database logic needed for authenticated users:

1. Viewers can read active documents in orgs where they are members.
2. Editors can read active documents in their orgs, insert documents they own in their orgs, and update or delete only documents they own.
3. Admins can read, update, and delete any active document in orgs where they are admins.
4. Soft-deleted documents (`deleted_at IS NOT NULL`) should not be visible through normal reads.
5. Deletes should be soft deletes by setting `deleted_at`; do not hard-delete rows.
6. Every insert, update, and soft-delete should write a row to `document_audit` with the acting user.

Apply the required database changes. End your turn when you believe the
policies and audit behavior are in place.
