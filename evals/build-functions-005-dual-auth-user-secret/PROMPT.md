---
stage: build
suite: benchmark
interface: cli
product:
  - edge-functions
  - auth
  - database
topic:
  - sdk
  - rls
  - security
services:
  - gotrue
  - kong
  - postgrest
  - edge-runtime
projectRunning: false
motivation: "https://github.com/supabase/server — dual-auth (RLS-scoped user vs service/secret) coverage gap"
---

Build and serve a Supabase Edge Function named `user-stats` for this project.

The database already defines a `user_stats` table with row-level security (see
`supabase/migrations/`):

```sql
user_stats(user_id uuid default auth.uid(), metric text, value int)
-- RLS: a user may select only rows where user_id = auth.uid()
```

The function serves two kinds of caller and must behave differently for each:

1. **Authenticated end users.** The caller sends their Supabase access token
   (JWT) in the `Authorization: Bearer <token>` header. Return only that user's
   own rows. Row-level security must be in force on this path — if the caller
   passes a `user_id` in the body, ignore it; they may never read another user's
   rows.

2. **Trusted backend service.** The caller authenticates with the project's
   service-role secret key sent in the `apikey` header (no user JWT), and passes
   a target `user_id` in the JSON body. Return that user's rows, bypassing
   row-level security.

Also:

3. Reject a request that carries no credentials.
4. Reject a request whose `apikey` is not the service key and that carries no
   valid user JWT — it must not be granted service (RLS-bypassing) access.
5. Return the matched rows as JSON on success.

Get the local stack running so the function is reachable over HTTP at
`/functions/v1/user-stats`. Note that the service path arrives without a user
JWT, so the function must accept requests that the platform would otherwise
gate on JWT verification.
