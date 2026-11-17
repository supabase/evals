---
stage: deploy
interface: mcp
product:
  - database
topic:
  - self-hosting
motivation: Checks that the docs navigation works for people, with an agent standing in for a backend engineer who doesn't know how to update a self-hosted install without losing local changes.
---

Imagine you are a backend engineer at a startup. You know a lot about SQL and Postgres. You don't know where Supabase keeps its settings. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

We run Supabase on our own VM with Docker Compose, and our install is a few releases behind. How do we move it to the latest release without losing our .env values and the edits we've made to the compose files?

Find the answer in the Supabase docs, then explain what to do.
