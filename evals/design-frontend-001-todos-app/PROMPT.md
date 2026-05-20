---
stage: design
product:
  - database
  - auth
  - sdk
topic:
  - frontend
  - rls
  - supabase-js
---

# Authenticated Todos Frontend

Build the missing Supabase integration for this Vite + React todos app.

The Supabase project already has a `todos` table with RLS policies:

```sql
todos(id uuid, user_id uuid default auth.uid(), body text, done boolean, created_at timestamptz)
```

The project files are under `app/`. `app/src/App.tsx` already contains the UI
markup and stable `data-testid`s used by the tests. Keep that UI shape intact
and hook it up to Supabase.

Requirements:

1. Create a Supabase client using `@supabase/supabase-js`. You may create a
   helper like `app/src/supabase.ts` or keep the client in `App.tsx`.
2. Read `import.meta.env.VITE_SUPABASE_URL` and
   `import.meta.env.VITE_SUPABASE_ANON_KEY`.
3. The sign-in form signs in with email/password.
4. After sign-in, load and render only the current user's todos.
5. The add-todo form inserts a todo for the current user. The table defaults `user_id`
   from `auth.uid()`, so insert only the todo body.
6. Checking a todo updates its `done` state in Supabase.
7. Throw an error if any Supabase call fails.

You may refactor the implementation, but keep the existing user-facing controls
and `data-testid` attributes so the tests can drive the app.
