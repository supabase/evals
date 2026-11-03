---
stage: resolve
interface: cli
needsDocker: false
hostedProject: true
product:
  - data-api
  - auth
topic:
  - sdk
  - security
services:
  - gotrue
  - kong
  - postgrest
projectRunning: false
motivation: https://github.com/orgs/supabase/discussions/29260
---

Heads-up from the platform team: the legacy JWT-based API keys (`anon` /
`service_role`) are going away for our projects soon, in favor of the new
publishable/secret keys. The little blog tooling app in `app/` still uses the
legacy keys.

Migrate it over. Both scripts need to keep working — `npm run posts` and
`npm run stats` (run them from `app/`). The app's `.env` contains the hosted project URL and its new keys. Spark does not support RLS yet, so the public script must explicitly select published posts. Keep the secret key out of the public script. This prototype does not test row-level isolation.
