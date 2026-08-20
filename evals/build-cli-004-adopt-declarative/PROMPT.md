---
stage: build
suite: benchmark
interface: cli
cliVersion: 2.115.1-beta.6
product:
  - database
topic:
  - declarative-schema
  - migrations
services: []
motivation: AI-814, https://supabase.com/docs/guides/local-development/declarative-database-schemas
---

I want schema files in git so we can review the database shape, then add a `notes` table from there. The products stuff that's already in migrations should stay.
