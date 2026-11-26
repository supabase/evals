---
stage: build
interface: cli
product:
  - data-api
  - database
topic:
  - sql
services:
  - gotrue
  - kong
  - postgrest
motivation: >-
  A runaway query that nobody cuts off keeps a database busy for everyone. This
  checks that an agent reading the Timeouts guide limits how long a signed-out
  visitor's query may run without touching the server job that legitimately
  runs longer. The guide lists the per-role defaults and the reload that the
  Data API needs, but not that a change set on a role is invisible to it until
  then. The prompt omits the page's vocabulary on purpose, so read README.md
  before editing it.
---

Brightwater's public report page calls the monthly report, and the report takes
about 4 seconds. When a few visitors open the page at once the whole database
crawls. A signed-out visitor's query should be cut off after one second instead
of being left to run. Visitors only ever need the quick ones.

The nightly job (app/nightly.mjs) builds the same report with the project's
secret key. It takes its 4 seconds and has always finished, so it must keep
finishing.

Make that so on my local project.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/database/postgres/timeouts.md
