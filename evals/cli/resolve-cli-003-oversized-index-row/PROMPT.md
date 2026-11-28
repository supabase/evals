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

Our editors publish articles with the SQL in `scripts/publish-article.sql`. I run it with `supabase db query --local -f scripts/publish-article.sql`, and the Q1 handbook does not get published.

Please make publishing work. Keep the existing articles, and keep the table refusing to publish the same body twice. Leave the script as it is, because the editors run it unchanged. The local Supabase project in `supabase/` is already running, so apply your fix to it.
