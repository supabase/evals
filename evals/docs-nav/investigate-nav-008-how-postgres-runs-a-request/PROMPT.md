---
stage: investigate
interface: mcp
product:
  - data-api
topic:
  - sdk
motivation: Checks that the docs navigation works for people, with an agent standing in for a frontend developer who doesn't know how to see what Postgres does with a request sent from supabase-js.
---

Imagine you are a frontend developer who works through supabase-js. You know a lot about JavaScript and supabase-js. You don't know SQL or what happens inside Postgres. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

I'm a frontend developer, and I do everything through supabase-js. One select with a few filters takes about four seconds, and I don't write SQL. I want to see how Postgres actually runs that exact request, straight from my JavaScript code, so I can tell what's slow. I don't know if supabase-js can show me that.

Find the answer in the Supabase docs, then explain what to do.
