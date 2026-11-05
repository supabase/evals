---
stage: build
interface: mcp
product:
  - vectors
  - auth
  - database
topic:
  - rls
motivation: Checks that the docs navigation works for people, with an agent standing in for a backend engineer who doesn't know how to limit similarity lookups to documents a user is allowed to see.
---

Imagine you are a backend engineer at a startup. You know a lot about SQL and Postgres. You don't know where Supabase keeps its settings. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

I'm building a chatbot that answers questions from documents our customers upload. When it pulls the most similar chunks out of Postgres to feed the LLM, how do I make sure it only ever gets chunks from documents the signed-in user is allowed to see?

Find the answer in the Supabase docs, then explain what to do.
