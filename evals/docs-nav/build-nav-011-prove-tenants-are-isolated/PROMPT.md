---
stage: build
interface: mcp
product:
  - database
topic:
  - rls
  - tests
motivation: Checks that the docs navigation works for people, with an agent standing in for a backend engineer who doesn't know which tool can check the database's access rules on their own.
---

Imagine you are a backend engineer at a startup. You know a lot about SQL and Postgres. You don't know where Supabase keeps its settings. You are standing in for this person, so stay in their role the whole time: you know only what they know, and you learn the rest by reading the Supabase docs. Here is your situation, in your own words.

Our app is multi-tenant. I wrote access rules in the database so users only see rows that belong to their own company. Before every deploy, I want CI to prove that a user from one company can't read another company's rows. I don't know what tool can check rules that live inside Postgres.

Find the answer in the Supabase docs, then explain what to do.
