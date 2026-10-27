---
stage: build
interface: cli
product:
  - database
  - auth
topic:
  - rls
  - tests
services:
  - gotrue
  - kong
  - postgrest
motivation: >-
  the RLS testing guide is the page agents are pointed at to test Row Level
  Security policies, and a policy test that cannot fail lets a broken policy
  ship while the suite stays green. The persona runs a small app whose access
  rules already exist and were broken once by a change nobody caught. They know
  they want tests in the database but not which tool Supabase uses for that.
  This eval determines whether the page gets an agent to a policy test suite
  that exercises who can and cannot reach each table, and that passes, when the
  user asks for tests and never names the tool. Read README.md before editing
  the prompt.
---

I run a small to-do app where people can share lists, plus a public weather
dashboard, both on the same Supabase project. The access rules are already in
the migrations.

Last month a change to those rules let people keep seeing items on a list
after they had been removed from it, and nobody noticed for a week. I want
tests in the repository that would have caught that, covering who can read and
change each table. I've heard you can run these inside the database, but I
don't know which tool Supabase uses for it.

Don't change the rules themselves. I want tests for the app as it is now.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/database/postgres/testing-row-level-security.md
