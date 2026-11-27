---
stage: resolve
interface: cli
product:
  - database
topic:
  - sql
  - security
services: []
motivation: https://github.com/supabase/cli/pull/7749
customMetadata:
  area: diagnostics
  journeyPhase: resolve
  abGroup: cli-docurl
---

Our public profile page lists the members as the `app_reader` database role. I run its query with `supabase db query --remote 'postgresql://app_reader:readerpw@127.0.0.1:54322/postgres?sslmode=disable' --yes -f scripts/list-profiles.sql`, and the list does not come back.

Please make the profile page query work. The page is public, so keep the members' private details private. The local Supabase project in `supabase/` is already running, so apply your fix to it.
