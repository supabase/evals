---
stage: build
interface: mcp
product:
  - auth
  - database
topic:
  - rls
  - security
motivation: Checks that the docs navigation works for people, with an agent standing in for a solo founder who doesn't know how to put a user's role into what they get at login.
---

Imagine you are a solo founder who builds and runs a SaaS alone. You know a lot about your own app and its code. You don't know the Supabase features you haven't used yet. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

Every user in my app is an admin, editor, or viewer, and we keep that in a table. I want that level stamped into what they get at login so my database policies and frontend can read it without querying the table each time.

Find the answer in the Supabase docs, then explain what to do.
