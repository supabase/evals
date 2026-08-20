---
stage: resolve
suite: regression
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

I added a description column to `products` in the schema file, but `db diff` says there are no changes. Can you get that column into a migration so it actually lands on the local database?
