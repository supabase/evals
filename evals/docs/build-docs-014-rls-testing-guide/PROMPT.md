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
  We need to know that the RLS testing guide is encouraging readers to follow secure, performant, accurate, and scalable tests that pass and don't have any false-positive or -negatives.
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

I'm offline after I send this, so I can't answer questions. If you'd check
the rules with me first, take the ones the migrations already enforce as
agreed, list them in the test files, and carry on. The one I care about most is
that someone removed from a list can no longer see the list or its items.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/database/postgres/testing-row-level-security.md
