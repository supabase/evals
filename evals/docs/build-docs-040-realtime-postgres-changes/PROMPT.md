---
stage: build
interface: cli
product:
  - realtime
  - database
topic:
  - rls
  - security
services:
  - gotrue
  - kong
  - postgrest
  - realtime
motivation: >-
  A screen that should update by itself stays still, or shows rows to people
  who should never see them. Customers and agents make a table send changes
  and stop there, so a signed-in subscriber gets nothing, or open the table to
  everyone so they do. This checks that an agent reading the Postgres Changes
  guide gets each change to the customer who owns the row, with what it was
  before, and to nobody else. The prompt omits the guide's vocabulary on
  purpose, so read README.md before editing it.
---

The order screen in our app is supposed to update by itself when the shop
changes an order, but customers see nothing until they reopen the app.
ORDER_SCREEN.md says what the screen should do. That version of the app is
already out, so the fix has to be on the Supabase side. Customers must only
ever see their own orders. Make the change in the local project and make sure
it works on the local database.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/realtime/postgres-changes.md
