---
stage: build
interface: cli
product:
  - database
topic:
  - security
services: []
motivation: >-
  Customers hand a database to a third-party tool and either give it the
  admin login or a login that can see far more than it needs. No evidence for
  this eval was found in agent-skills, so this checks the Postgres Roles guide
  by what an agent builds from it: a login that can do its one job and
  nothing else. The prompt omits the page's vocabulary on purpose, so read
  README.md before editing it.
---

Finance is rolling out a dashboard tool to build sales reports, and it needs
to connect straight to our database. All it has to do is read the orders and
the customers. It must not be able to change anything, and what we pay our
staff is off limits.

Set that up on the local database and fill in the connection string the tool
should use in `integrations/bi-tool.env`.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/database/postgres/roles.md
