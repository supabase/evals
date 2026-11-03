---
stage: deploy
interface: mcp
product:
  - database
topic:
  - security
motivation: Engineering lead who doesn't know whether a Supabase account can get its own Postgres login.
---

We're bringing on a contractor who needs read-only access to our production Postgres database for a month. I don't want to hand out the main database password. They should have their own login that I can cut off when the contract ends. I don't know whether someone's Supabase account can sign in to Postgres directly. What do the Supabase docs say?
