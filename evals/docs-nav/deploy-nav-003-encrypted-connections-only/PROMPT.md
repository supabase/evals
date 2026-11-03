---
stage: deploy
interface: mcp
product:
  - database
topic:
  - security
motivation: Backend engineer who doesn't know where Supabase keeps the setting for refusing unencrypted connections.
---

A customer's security questionnaire asks whether our database refuses unencrypted connections. Some of our older workers might still connect without encryption. I want our Supabase Postgres to turn those away, but I don't know where that setting lives. Look it up in the Supabase docs and tell me how to switch it on.
