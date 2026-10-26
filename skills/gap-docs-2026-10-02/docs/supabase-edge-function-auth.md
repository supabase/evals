# Authenticate Supabase Edge Function callers

Use the user-only pattern when an Edge Function serves private records to signed-in users. Use the mixed-caller pattern when the same endpoint also serves a trusted backend. In either case, authenticate the caller and enforce which records they may request; gateway JWT verification alone does not scope database rows.

## Prerequisites

- A Supabase project and an Edge Function using the Supabase Edge Runtime.
- A private table with a stable ownership column (for example, `user_id`) that refers to the owning Auth user.
- RLS enabled on the table, grants limited to the needed database role, and a select policy that compares the ownership column with `auth.uid()`.
- For a mixed endpoint, `@supabase/server` and a trusted backend able to keep its `sb_secret_` key private.
- For local verification, the Supabase CLI and Docker or a compatible runtime, with the local project started using `supabase start`.

A user's access token and the project's API key are different credentials. A signed-in user request carries `Authorization: Bearer <user-access-token>` and the project's publishable key in `apikey`. Never put a secret key in a browser or mobile app. Never infer user identity from request JSON, query parameters, or an API key.

## User-only endpoint: authenticate and scope to the caller

For a function used only by signed-in users, keep the default gateway `verify_jwt = true`. The gateway rejects requests without a valid user JWT before the handler runs. In the handler, validate the user identity and use a user-scoped Supabase client so database RLS remains active. Add an explicit owner filter derived from the verified identity; ignore client-supplied owner IDs.

Adapt this example to the function runtime, table, selected columns, and owner column. The two layers serve different purposes: the verified identity and query filter make the function's intent explicit, while RLS protects the rows if another query path is added later.

```ts
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authorization } } },
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("private_notes")
    .select("id, note")
    .eq("user_id", user.id);

  if (error) {
    console.error("Could not read private notes", error);
    return Response.json({ error: "Could not read private notes" }, { status: 500 });
  }

  return Response.json(data ?? []);
});
```

This is an adaptable example: use the project's configured public client key variable if its runtime uses a different name, and replace `private_notes`, selected columns, and `user_id` to match the actual schema. The public client key is not a substitute for the user JWT. Forward the incoming Authorization header to the user-scoped client; do not create this client with a service-role or secret key. Do not use a request `user_id` to choose the owner. If the function uses `@supabase/server` instead, its `auth: "user"` mode supplies `ctx.userClaims.id` and an RLS-scoped `ctx.supabase`; keep `verify_jwt` enabled.

A corresponding read policy can be written as follows; adapt the schema and column names, and check existing grants and policies before applying changes:

```sql
alter table public.private_notes enable row level security;

create policy "Users can read their own private notes"
on public.private_notes for select
to authenticated
using ((select auth.uid()) = user_id);
```

RLS and grants are both required: a policy does not remove existing table privileges. Ensure only the intended roles have select permission. If the table has other operations, define and verify separate policies for them; do not broaden access merely to make this read work.

## Mixed endpoint: separate user and trusted service paths

Use this pattern only when one endpoint genuinely accepts both signed-in users and a trusted backend. The wrapper validates the caller's credential type; the handler must still enforce which records that caller may request.

The example is adaptable: replace `user_stats` and `user_id` with the table and ownership column in your schema. Keep the explicit owner filter even when RLS also protects the table.

```ts
import { withSupabase } from "npm:@supabase/server@^1";

export default {
  fetch: withSupabase(
    { auth: ["user", "secret"] },
    async (req, ctx) => {
      if (req.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }

      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      let targetUserId: string;
      let db: typeof ctx.supabase;

      if (ctx.authMode === "user") {
        targetUserId = ctx.userClaims.id;
        db = ctx.supabase;
      } else if (ctx.authMode === "secret") {
        const requestedId = (body as { user_id?: unknown }).user_id;
        if (typeof requestedId !== "string" || requestedId.length === 0) {
          return Response.json({ error: "user_id is required" }, { status: 400 });
        }
        targetUserId = requestedId;
        db = ctx.supabaseAdmin;
      } else {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      const { data, error } = await db
        .from("user_stats")
        .select("*")
        .eq("user_id", targetUserId);

      if (error) {
        console.error("Could not read user stats", error);
        return Response.json({ error: "Could not read user stats" }, { status: 500 });
      }

      return Response.json(data ?? []);
    },
  ),
};
```

The `user` mode accepts a valid user JWT and gives the handler `ctx.supabase`, which is scoped to that user's RLS policies. Use `ctx.userClaims.id` as the row owner. Ignore a supplied `user_id` on this path; it must never expand the verified user's scope.

The `secret` mode accepts a configured secret API key in `apikey` and gives the handler `ctx.supabaseAdmin`, which bypasses RLS. Only in this branch may the backend's validated request body select a target user. Validate the identifier and any additional business authorization needed by your service before querying.

For user requests, send both `apikey: sb_publishable_...` and `Authorization: Bearer <user-access-token>`. For trusted service requests, send `apikey: sb_secret_...` without a user bearer token. The wrapper validates the credential for the selected mode. Do not substitute legacy `anon` or `service_role` keys when the integration requires modern publishable and secret keys.

## Configure platform JWT verification

Leave `verify_jwt` enabled for a user-only function. This rejects missing or invalid user JWTs before the handler runs. A mixed endpoint must accept secret-key service calls without a user JWT, so disable the gateway check for that function and let `withSupabase` validate its declared modes:

```toml
[functions.my-function]
verify_jwt = false
```

Replace `my-function` with the deployed function name. This setting does not authorize callers by itself. The wrapper must remain configured with only the modes the endpoint intends to accept; never use `auth: "none"` for private data.

The wrapper reads `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`, and `SUPABASE_JWKS` from the Supabase runtime. Local CLI development uses a single-key setup and also supports `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` fallbacks. If authentication fails locally, check that the function runtime received the expected project configuration and keys. Do not replace credential validation with prefix checks or manual string comparisons.

## Verify a user-only endpoint

Start local Supabase and serve the function. The default local API URL uses port `54321`; use the port configured in `supabase/config.toml` if it differs.

```sh
supabase start
supabase functions serve private-notes
```

Use local or disposable accounts, each with a note whose contents are distinguishable. Store credentials in shell variables and adapt names and IDs to your project; do not put production secrets in source control or logs. Call with each user's own JWT and the publishable key:

```sh
curl -i 'http://127.0.0.1:54321/functions/v1/private-notes' \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  -H "Authorization: Bearer $USER_A_ACCESS_TOKEN"
```

Repeat with `$USER_B_ACCESS_TOKEN`. Verify that each response includes the caller's note and never the other user's note. If the endpoint accepts a user ID parameter for some other purpose, repeat with the other user's ID; it must not change which owner's notes are returned. Check the database policy independently by querying as each user through the user-scoped client, and inspect that no service-role client is used on this path.

Also call without a JWT, with an invalid or expired JWT, and with only a publishable key. These requests must not return private data. With gateway JWT verification enabled they may be rejected before handler execution. A timeout, DNS error, or request that never reaches the function is not a successful isolation check. For deployed verification, confirm the function version and JWT setting, then make the two-user requests against the correct project URL; record network or authentication blocks as unverified rather than treating deployment status as proof of isolation.

## Verify both mixed-endpoint paths locally

Start the local Supabase services and serve the function:

```sh
supabase start
supabase functions serve my-function
```

Use local or disposable test credentials. Adapt the function name, IDs, and variables to your project. Do not paste production secrets into source control or logs.

Signed-in user request:

```sh
curl -i -X POST 'http://127.0.0.1:54321/functions/v1/my-function' \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"user_id":"another-user-id"}'
```

Expected: the response contains only rows owned by the user represented by the JWT, even though the example body names another user. Try the user's own ID and confirm that the same owner boundary holds.

Trusted backend request:

```sh
curl -i -X POST 'http://127.0.0.1:54321/functions/v1/my-function' \
  -H "apikey: $SUPABASE_SECRET_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"user_id":"target-user-id"}'
```

Expected: the validated secret-key caller can request the specified target user's rows without sending a user bearer token.

Also try requests with missing credentials, a forged JWT, a publishable key without a valid user JWT, a user token or key placed in the wrong header, and a forged secret key. Confirm each is rejected and valid responses are JSON. If a request times out or fails before reaching the handler, inspect the local function and runtime logs and treat that as a serving/runtime problem; it does not verify either credential path.