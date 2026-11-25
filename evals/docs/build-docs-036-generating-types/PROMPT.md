---
stage: build
interface: cli
product:
  - database
  - data-api
topic:
  - sdk
services: []
motivation: >-
  Typed Supabase apps break when their types miss part of the database.
  Customers report a second schema missing from the generated types
  (supabase/supabase#54000), a schema silently left out of a types file
  (supabase/cli#7625), and database functions typed as never until types are
  generated. This checks that an agent reading the Generating Types guide gives
  an app types that match the local database, including a second schema and a
  function, and a refresh command that picks up a database change. The prompt
  omits the guide's vocabulary on purpose, so read README.md before editing it.
---

The TypeScript in src/ for our bookshop app talks to the local Supabase
database, but `npm run typecheck` fails and nothing tells us when the code and
the database drift apart. Get the app's types in line with the local database
so the check passes, and make the refresh command in CONTRIBUTING.md work so we
can keep them current after each database change.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/api/rest/generating-types.md
