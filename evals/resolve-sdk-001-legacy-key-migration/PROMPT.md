---
stage: resolve
suite: regression
interface: cli
cliVersion: 2.109.1
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
projectRunning: true
motivation: https://github.com/orgs/supabase/discussions/29260
---

Heads-up from the platform team: the legacy JWT-based API keys (`anon` /
`service_role`) are going away for our projects soon, in favor of the new
publishable/secret keys. The little blog tooling app in `app/` still uses the
legacy keys.

Migrate it over. Both scripts need to keep working — `npm run posts` and
`npm run stats` (run them from `app/`). The local Supabase project in
`supabase/` is already running.
