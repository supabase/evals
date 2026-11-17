---
stage: investigate
interface: mcp
product:
  - cron
  - database
topic:
  - observability
motivation: Checks that the docs navigation works for people, with an agent standing in for a solo founder who doesn't know where to see whether a scheduled database job ran.
---

Imagine you are a solo founder who builds and runs a SaaS alone. You know a lot about your own app and its code. You don't know the Supabase features you haven't used yet. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

Every night at 3am my Postgres database is supposed to clear out old rows from our events table by itself, but this morning the old rows are still there. How can I see whether last night's run actually happened and what error it hit?

Find the answer in the Supabase docs, then explain what to do.
