---
stage: build
suite: benchmark
interface: cli
product:
  - database
topic:
  - migrations
projectRunning: false
motivation: AI-825, https://supabase.com/docs/guides/platform/migrating-to-supabase/postgres
---

I have an existing Postgres database I want to migrate to Supabase. There's a binary dump at `source.dump` in the current directory.

Can you set up a local Supabase project and restore the dump into it?
