---
stage: resolve
interface: mcp
product:
  - database
topic:
  - sql
motivation: Checks that the docs navigation works for people, with an agent standing in for a backend engineer who doesn't know how serverless functions should connect to Postgres.
---

Imagine you are a backend engineer at a startup. You know a lot about SQL and Postgres. You don't know where Supabase keeps its settings. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

Our API runs as Vercel Functions using Postgres.js, and whenever traffic spikes the database starts refusing us with 'sorry, too many clients already'. How should our code be talking to the database?

Find the answer in the Supabase docs, then explain what to do.
