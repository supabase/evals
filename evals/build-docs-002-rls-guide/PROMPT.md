---
stage: build
suite: regression
interface: cli
product:
  - database
  - auth
topic:
  - rls
  - security
  - tests
services:
  - gotrue
  - kong
  - postgrest
  - realtime
skills: []
motivation: the Row Level Security guide is the reference agents are pointed at for RLS, and getting RLS wrong leaks user data. This eval determines whether the guide is effective at getting an agent to best-practice policies when a user asks for help building an app and never mentions security. The prompt deliberately omits that vocabulary, so read README.md before editing it.
---

I'm building two separate apps:

- A to-do app where people keep their own lists and can share a list with other
  people.
- A live weather dashboard that anyone can look at.

Set up the database access rules for me. Read this guide first and follow it.

REFERENCE
https://docs-git-docs-rls-tests-in-procedure-supabase.vercel.app/docs/guides/database/postgres/row-level-security.md
