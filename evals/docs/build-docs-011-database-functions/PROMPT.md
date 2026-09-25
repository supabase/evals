---
stage: build
interface: cli
product:
  - database
  - data-api
topic:
  - sql
  - security
  - rls
services:
  - gotrue
  - kong
  - postgrest
projectRunning: false
motivation: >-
  the Database Functions guide is the page agents are pointed at to move a
  calculation into Postgres, and the choice it presents in one short subsection
  decides whether the result is readable by the person who asked for it or by
  anybody at all. Customers report that AI tools reach for the creator's
  privileges by default and produce functions callable from the front end with
  no session, bypassing the row policies the rest of the project relies on, and
  that the resulting hole is hard to find because no policy is involved in it.
  The page names the setting and names the search path you must pin alongside
  it, and a function that does both still answers a stranger. Requests keep
  arriving for guidance on when the creator's privileges are safe, for a linter
  that can tell a sound use from an unsound one, and for the default execute
  permission on new functions to stop being granted to everyone. This eval
  determines whether the page gets an agent to a calculation only its owner can
  run when the user asks for a shared total and never names a privilege. The
  prompt deliberately omits the vocabulary the page teaches, so read README.md
  before editing it.
---

Our web app and our mobile app each work out an order's total themselves, tax
included, and the two have drifted apart. I want one answer computed in the
database so they always agree.

Both apps will call it as `order_total`, pass the order's id, and expect the
total back in cents.

A customer must only ever be able to get the total for one of their own orders.

Then get the local stack running so I can try it.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://docs-git-docs-definer-function-privileges-supabase.vercel.app/docs/guides/database/functions.md
