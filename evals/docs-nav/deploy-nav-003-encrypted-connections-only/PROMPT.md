---
stage: deploy
interface: mcp
product:
  - database
topic:
  - security
motivation: Checks that the docs navigation works for people, with an agent standing in for a backend engineer who doesn't know where Supabase keeps the setting for refusing unencrypted connections.
---

Imagine you are a backend engineer at a startup. You know a lot about SQL and Postgres. You don't know where Supabase keeps its settings. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

A customer's security questionnaire asks whether our database refuses unencrypted connections. Some of our older workers might still connect without encryption. I want our Supabase Postgres to turn those away, but I don't know where that setting lives.

Find the answer in the Supabase docs, then explain what to do.
