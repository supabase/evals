---
stage: build
interface: mcp
product:
  - auth
topic:
  - security
motivation: Checks that the docs navigation works for people, with an agent standing in for a backend engineer who doesn't know how to check a signed-in user's credential without calling Supabase.
---

Imagine you are a backend engineer at a startup. You know a lot about SQL and Postgres. You don't know where Supabase keeps its settings. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

Our Go API receives the logged-in user's credential from our frontend on every request. How can it check locally that it's genuine and was issued by our Supabase project, without calling Supabase each time?

Find the answer in the Supabase docs, then explain what to do.
