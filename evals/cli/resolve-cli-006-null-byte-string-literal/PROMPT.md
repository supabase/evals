---
stage: resolve
interface: cli
product:
  - database
topic:
  - sql
services: []
motivation: https://github.com/supabase/cli/pull/7749
customMetadata:
  area: diagnostics
  journeyPhase: resolve
  abGroup: cli-docurl
---

The scanner importer registers each new scan with `supabase db query -f scripts/register-asset.sql`, and the scan does not get registered.

Please make the registration work. The importer generates `scripts/register-asset.sql` fresh for every scan, so it has to stay exactly as it is. Keep the existing assets. The local Supabase project in `supabase/` is already running, so apply your fix to it.
