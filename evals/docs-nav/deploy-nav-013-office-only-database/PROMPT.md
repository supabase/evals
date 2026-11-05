---
stage: deploy
interface: mcp
product:
  - database
topic:
  - security
motivation: Checks that the docs navigation works for people, with an agent standing in for a backend engineer who doesn't know where Supabase lets them limit who can connect to the database.
---

Imagine you are a backend engineer at a startup. You know a lot about SQL and Postgres. You don't know where Supabase keeps its settings. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

Only our office should be able to connect directly to our production Postgres database. Our office IP is 203.0.113.7. I don't know where Supabase lets me limit who can connect.

Find the answer in the Supabase docs, then explain what to do.
