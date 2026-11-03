---
stage: build
interface: cli
hostedProject: true
needsDocker: false
product:
  - database
topic:
  - migrations
projectRunning: false
motivation: AI-825, https://supabase.com/docs/guides/platform/migrating-to-supabase/postgres
---

I have an existing Postgres database I want to migrate to Supabase. There's a binary dump at `source.dump` in the current directory.

Restore its schema and data into the linked hosted Spark project. Row level security is not supported yet, so leave RLS and policies out of this prototype.

Preserve the data, foreign keys, indexes and working generated IDs. PostgreSQL-specific DDL may be adapted to Spark-supported syntax when those behaviors are preserved.
