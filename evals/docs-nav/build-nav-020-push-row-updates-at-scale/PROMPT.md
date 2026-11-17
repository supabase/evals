---
stage: build
interface: mcp
product:
  - realtime
  - database
topic:
  - sql
motivation: Checks that the docs navigation works for people, with an agent standing in for a frontend developer who doesn't know which way of pushing row changes to browsers holds up at scale.
---

Imagine you are a frontend developer who works through supabase-js. You know a lot about JavaScript and supabase-js. You don't know SQL or what happens inside Postgres. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

Whenever a row in our orders table is updated, I want every open browser tab showing that order to get the new status pushed to it instantly. We'll have thousands of people connected at once, so I want the approach that holds up at that scale. What's the right way to set it up?

Find the answer in the Supabase docs, then explain what to do.
