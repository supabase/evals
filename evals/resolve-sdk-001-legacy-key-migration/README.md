# resolve-sdk-001-legacy-key-migration

A working blog-tooling app (`local/app/`) authenticates with the **legacy
local demo JWTs** — the deterministic `anon` / `service_role` keys every
local stack issues when `supabase/config.toml` doesn't override the JWT
secret (payload `{"iss":"supabase-demo",…}` signed with the default
`super-secret-jwt-token-with-at-least-32-characters-long`). That's what lets
the seed hardcode valid keys in `.env` before the stack exists.

The task is to migrate the app to the new `sb_publishable_…` / `sb_secret_…`
keys (see the motivation link). The scorer checks behavior, not process:

1. `npm run posts` still prints the published titles (client-key path).
2. `npm run stats` still prints the draft count — drafts are hidden from the
   publishable key by RLS, so a correct count proves a real secret key.
3. No legacy demo JWT remains anywhere in `app/` (matched on the shared
   header+payload prefix, so it catches both keys).
4. The public script doesn't end up holding the secret key, directly or via
   an env var that resolves to one.

Assumptions to keep in mind: the pinned `cliVersion` must expose
`PUBLISHABLE_KEY` / `SECRET_KEY` in `supabase status -o json`, and the stack
must still accept legacy JWTs by default (true as of 2.109.1) or the seeded
app would be broken before the agent starts.
