# Edge Function Auth + Database

Create a Supabase Edge Function named `todo-create`.

The function must:

1. Accept only `POST` requests.
2. Require the caller's `Authorization` header and forward it to Supabase.
3. Use `@supabase/supabase-js` with:
  - `Deno.env.get("SUPABASE_URL")`
  - `Deno.env.get("SUPABASE_ANON_KEY")`
4. Read JSON body `{ "body": "todo text" }`.
5. Insert one row into the existing `todos` table. The table defaults `user_id`
  from `auth.uid()`, so insert only the `body` value.
6. Return `201` JSON containing the inserted row.
7. Return a non-2xx JSON error for missing auth, invalid JSON, missing body, or
  insert/select failures.

Use the `functions.deploy` tool to deploy the function with slug `todo-create`.
Pass the implementation as a single `index.ts` source string in the `file`
array, with function metadata in `metadata`.