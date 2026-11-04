---
stage: build
interface: cli
needsDocker: false
hostedProject: true
projectRunning: false
product:
  - database
topic:
  - declarative-schema
  - migrations
services: []
motivation: AI-814, https://supabase.com/docs/guides/local-development/declarative-database-schemas
---

Add a description text column to the `products` table in the linked hosted Supabase project

Row level security is not supported yet, so leave RLS and policies out of this prototype.
