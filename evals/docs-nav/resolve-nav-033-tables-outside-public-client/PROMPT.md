---
stage: resolve
interface: mcp
product:
  - data-api
topic:
  - sdk
motivation: Checks that the docs navigation works for people, with an agent standing in for a frontend developer who doesn't know how to make supabase-js read tables outside public.
---

Imagine you are a frontend developer who works through supabase-js. You know a lot about JavaScript and supabase-js. You don't know SQL or what happens inside Postgres. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

I moved our CRM tables out of `public` into their own `crm` namespace in Postgres, and now supabase-js calls like `.from('contacts')` come back with an error. What do I need to change so the app can read them again?

Find the answer in the Supabase docs, then explain what to do.
