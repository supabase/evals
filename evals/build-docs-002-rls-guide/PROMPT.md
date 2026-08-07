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
motivation: the Row Level Security guide is the reference agents are pointed at for RLS, and getting RLS wrong leaks user data. This eval determines whether the guide is effective at getting an agent to best-practice policies when a user asks for help building an app and never mentions security.
persona: a vibe-coding user who describes the app in product terms and never says RLS, policy, security, role, tenant, or test. Stripping that vocabulary is part of the measurement — see README.md before editing this prompt.
---

I'm building two separate apps:

- A to-do app where people keep their own lists and can share a list with other
  people.
- A live weather dashboard that anyone can look at.

Set up the database access rules for me.

REFERENCE
https://supabase.com/docs/guides/database/postgres/row-level-security.md
