---
stage: build
interface: mcp
product:
  - database
topic:
  - rls
  - security
motivation: Checks that the docs navigation works for people, with an agent standing in for a backend engineer who doesn't know whether Postgres can turn on RLS for every new table by itself.
---

Imagine you are a backend engineer at a startup. You know a lot about SQL and Postgres. You don't know where Supabase keeps its settings. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

People on my team keep creating new tables in `public` and forgetting to turn on RLS. Can I make Postgres switch RLS on automatically for every new table the moment it's created?

Find the answer in the Supabase docs, then explain what to do.
