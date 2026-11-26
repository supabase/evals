---
stage: build
interface: cli
product:
  - database
topic:
  - security
services: []
motivation: >-
  supabase/agent-skills#558: an agent hit a failure running Prisma against a
  Supabase database that the Prisma guide has nothing to say about. The guide
  is the page agents are pointed at to connect Prisma, and what it gives Prisma
  to connect as decides what a migration tool can reach in the project. This
  checks that an agent reading it ends up with Prisma running as an account of
  its own, with no admin powers, and not as the admin login. The prompt omits
  the page's vocabulary on purpose, so read README.md before editing it.
---

Tidewater's help center is moving its tables to Prisma. The Prisma project is
already in app/ with the first model written. I want to run its migrations
against my local database, but I don't want Prisma running as our admin login.
Give it a login of its own that has only what it needs, put the connection
string it should use in app/.env, and run the first migration. Our own
migrations keep adding tables to the project, and Prisma has to keep working
with those too.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/database/prisma.md
