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

I added a migration that gives profiles an avatar and I'm trying to ship it to our hosted project, but `supabase db push` keeps failing with "The remote database's migration history does not match local files."

A teammate applied a `bio` column straight on the hosted database a while back and never committed the migration, so the remote knows about a version we don't have locally. I need that avatar column live on the hosted project.

The hosted database's connection string is in `supabase/.temp/pooler-url`; pass it to the db/migration commands with `--db-url`. Reconcile the migration history and get the avatar migration applied — without resetting or wiping the hosted database, it holds real user profiles.
