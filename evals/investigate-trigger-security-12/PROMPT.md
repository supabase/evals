---
motivation: derived from build-rls-002-own-todos-client; provenance carried by the canonical eval (see evals/trigger/MAPPING.md)
stage: investigate
suite: trigger
interface: mcp
product:
  - database
topic:
  - rls
---

You are working on a Supabase project for a todos app.

The `todos` table already exists:

```sql
id uuid, user_id uuid, body text, done boolean, created_at timestamptz
```

`user_id` defaults to `auth.uid()`, so app code can insert a todo by sending only
`body` / `done`.

Add the RLS policies needed so that authenticated users can:

1. `SELECT` only their own todos.
2. `INSERT` only their own todos.
3. `UPDATE` only their own todos.
4. `DELETE` only their own todos.

Apply the required database changes. End your turn when you believe the
policies are in place.
