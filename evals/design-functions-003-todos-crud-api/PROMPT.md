# Todos CRUD Edge Function

Create a Supabase Edge Function named `todos-api`.

The function must use `@supabase/supabase-js` with:

- `Deno.env.get("SUPABASE_URL")`
- `Deno.env.get("SUPABASE_ANON_KEY")`
- The caller's `Authorization` header forwarded through `global.headers`

Implement these routes:

1. `GET /todos-api`
  - Requires auth.
  - Returns the caller's todos ordered by `created_at` ascending.
  - Supports optional `?done=true|false`.
  - Supports optional `?limit=` from 1 to 100, defaulting to 50.
2. `POST /todos-api`
  - Requires auth.
  - Reads JSON body `{ "body": "todo text", "done": false }`.
  - `body` is required and must be a non-empty string.
  - `done` is optional and defaults to `false`.
  - Returns `201` JSON containing the inserted row.
3. `PATCH /todos-api/<uuid>`
  - Requires auth.
  - Accepts a JSON object with only `body` and/or `done`.
  - Returns the updated row.
  - Return `404` if the row does not belong to the caller or does not exist.
4. `DELETE /todos-api/<uuid>`
  - Requires auth.
  - Deletes the caller's row and returns JSON `{ "deleted": true }`.
  - Return `404` if the row does not belong to the caller or does not exist.

Return JSON errors for missing auth (`401`), unsupported methods (`405`),
invalid JSON (`400`), invalid UUID path params (`400`), invalid query params
(`400`), and database failures.

Deploy the function with slug `todos-api`. The deployed source should be a
single `index.ts` file.
