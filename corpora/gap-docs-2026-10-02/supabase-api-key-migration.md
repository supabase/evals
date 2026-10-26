# Migrate to publishable and secret API keys

Use a publishable key anywhere the application ships to an untrusted device or public source. Use a secret key only in a backend component controlled by your team.

## Choose a key by runtime

| Code location | Key | RLS behavior |
| --- | --- | --- |
| Browser, mobile or desktop app, public CLI or script | Publishable key (`sb_publishable_...`) | Low privilege. RLS policies still control data access. |
| Server, Edge Function, worker or other trusted backend | Secret key (`sb_secret_...`) | Elevated access that bypasses RLS. Protect it as a secret. |

An API key identifies the application component making a request; Supabase Auth identifies the signed-in user. With a publishable key and signed-in user's access token, the request uses the user's identity and RLS policies for the `authenticated` role. The publishable key does not make user data public by itself. Policies and database grants still determine access.

The legacy `anon` key maps to the publishable key's low-privilege role. The legacy `service_role` key maps to the elevated secret key role. A secret key can bypass RLS, so any backend using it must perform its own authorization before accessing user data. Never include a secret key in frontend code, a mobile bundle, public source, or a client-delivered configuration.

## Migrate an existing project incrementally

Prerequisites: project Dashboard access to **Settings > API Keys**, access to deployments and secret stores, and an inventory of clients, servers, CI jobs, workers, webhooks, and database-triggered calls that use project keys.

1. Create the publishable and secret keys in **Settings > API Keys**. Creating them adds the new keys alongside the legacy keys; it does not disable the old ones.
2. Replace legacy `anon` keys in shipped clients with the publishable key. Example to adapt in a JavaScript client:

   ```ts
   import { createClient } from '@supabase/supabase-js'

   const supabase = createClient(
     'https://your-project.supabase.co',
     'sb_publishable_...' // use the project's publishable key
   )
   ```

3. Replace legacy `service_role` keys in trusted backends with a secret key. Store it in the deployment's secret manager or environment, and retain user-specific authorization checks in backend code.
4. Check integrations that send keys in headers. The new keys are not JWTs; send them using the `apikey` header where the integration requires a raw API key. Review Edge Function authorization separately; an API key alone does not identify an authenticated user.
5. Deploy and verify each client and backend path, including older mobile or desktop releases, CI/CD, cron jobs, third-party integrations, and database webhooks.
6. Only after confirming no callers use the legacy keys, deactivate the legacy keys in **Settings > API Keys**. This is a separate, reversible step.

For local development, use the publishable and secret keys printed by `supabase start`. Keep the local secret key out of committed files.

## Verify the migration

- Confirm public clients contain only a publishable key and no secret key.
- With a publishable key, check that signed-out and signed-in requests follow the intended `anon` and `authenticated` policies.
- In a controlled backend, verify the secret-key path only performs actions after the backend's own authorization succeeds; its database requests can bypass RLS.
- Exercise deployed integrations that carry keys in headers, especially Edge Functions and database webhooks.
- Deactivate legacy keys only after the inventory and live callers have been checked. Recheck each deployed path after rotation.
