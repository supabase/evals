---
stage: investigate
interface: mcp
product:
  - database
topic:
  - observability
motivation: Checks that the docs navigation works for people, with an agent standing in for a backend engineer who doesn't know which Postgres settings make the database record long-running queries and queries that error.
---

Imagine you are a backend engineer at a startup. You know a lot about SQL and Postgres. You don't know where Supabase keeps its settings. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

Some of our API requests take several seconds, and now and then one throws a database error, but I can't tell which queries are behind it. I want Postgres to keep a record of every query that takes more than a second, and of every query that errors. I don't know which Postgres settings do that on Supabase.

Find the answer in the Supabase docs, then explain what to do.
