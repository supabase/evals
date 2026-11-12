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
  determines if the Database Functions guide is working as expected with agents. A
  first version asked only for an order total, which an agent can always serve
  by running as its caller, so the branch the page's danger note covers was
  never reached and every baseline run scored full marks (DOCS-1319). The
  second request, a store credit balance over a ledger no customer can read
  directly, leaves no caller's-privileges answer that keeps the table closed.
  The prompt deliberately omits the vocabulary the page teaches, so read
  README.md before editing it.
---

Our web app and our mobile app each work out an order's total, tax included,
and the two have drifted apart. I want one answer computed in the database so
they always agree. Call it order_total, pass the order's id, and I need the
total back in cents.

Same problem with store credit. The apps each show a customer their balance
and those have drifted too. Call that one credit_balance, pass the customer's
id, and I need the balance back in cents.

This goes in front of real customers this week, so it needs to be right. Then
get the local stack running so I can try it.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/database/functions.md
