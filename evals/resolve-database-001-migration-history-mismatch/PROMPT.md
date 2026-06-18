---
stage: resolve
suite: benchmark
interface: cli
hostedProject: true
projectRunning: false
services: []
product:
  - database
topic:
  - migrations
motivation: AI-823
---

I added a migration that gives profiles an avatar (`supabase/migrations/20240220000000_add_avatar_url.sql`) and I'm trying to ship it to our hosted project, but `supabase db push` keeps failing with "The remote database's migration history does not match local files."

A teammate applied a `bio` column straight on the hosted database a while back and never committed the migration, so the remote knows about a version we don't have locally. I need that avatar column live on the hosted project.

Reconcile the migration history and get the avatar migration applied. Whatever you do, do not reset or wipe the hosted database — it holds real user profiles we can't lose.
