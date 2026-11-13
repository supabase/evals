---
stage: deploy
interface: mcp
product:
  - database
topic:
  - security
motivation: Checks that the docs navigation works for people, with an agent standing in for an engineering lead who doesn't know whether a Supabase account can get its own Postgres login.
---

Imagine you are an engineering lead who is in charge of team access. You know a lot about your team's tools and company accounts. You don't know how Supabase handles team members. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

We're bringing on a contractor who needs read-only access to our production Postgres database for a month. I don't want to hand out the main database password. They should have their own login that I can cut off when the contract ends. I don't know whether someone's Supabase account can sign in to Postgres directly.

Find the answer in the Supabase docs, then explain what to do.
