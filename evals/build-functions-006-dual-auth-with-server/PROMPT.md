---
stage: build
suite: regression
interface: cli
cliVersion: 2.109.1
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
motivation: FDBKIN-19273
---

Build and serve a Supabase Edge Function named `user-stats` for this project,
reachable over HTTP at `/functions/v1/user-stats`.

Implement it with the **`@supabase/server`** package, which is built for exactly
this kind of multi-auth Edge Function. Import it directly in your function:

```ts
import { withSupabase } from "npm:@supabase/server";
```

Our product stores per-user metrics in a `user_stats` table that already exists
(see `supabase/migrations/`), protected by row-level security so a user can read
only their own rows.

Two very different callers need to hit this one endpoint:

1. **Our mobile app**, acting for a signed-in user. It sends that user's
   Supabase access token. The endpoint should return the user's own stats.

2. **Our internal billing service**, a trusted backend with no signed-in user.
   It authenticates with the project's secret (service-role) key in the `apikey`
   header, and names the target user with a `user_id` in the JSON request body.
   It needs that user's stats.

Return the matching rows as JSON. The endpoint must be secure: only ever serve
stats to a caller that is genuinely entitled to them, and turn away callers that
are not.

Get the local stack running so the function is reachable at the path above.
