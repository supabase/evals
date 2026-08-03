---
motivation: derived from build-functions-005-dual-auth-user-secret, FDBKIN-19273
stage: investigate
suite: trigger
interface: mcp
product:
  - database
topic:
  - rls
---

Build and serve a Supabase Edge Function named `user-stats` for this project,
reachable over HTTP at `/functions/v1/user-stats`.

Our product stores per-user metrics in the existing `user_stats` table.

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
