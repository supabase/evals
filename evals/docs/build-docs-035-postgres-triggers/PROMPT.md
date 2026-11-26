---
stage: build
interface: cli
product:
  - database
topic:
  - sql
  - security
services: []
motivation: >-
  A trigger runs with the rights of whoever made the change. Developers and
  agents write one that works when tested as the database owner and fails for
  signed-in users, or open the target table to those users to make it work.
  This checks that an agent reading the Postgres Triggers guide records every
  real status change, from customers and the back office alike, while
  customers cannot write the record. The prompt omits the guide's vocabulary
  on purpose, so read README.md before editing it.
---

Parcelo's order page should show a timeline of every status an order has been
through. The order_status_history table is already there, but nothing fills
it. Fill it in automatically whenever an order's status changes, no matter who
changes it. Customers change their own orders from the app, and the warehouse
updates orders from the back office. ORDERS.md shows how the app saves orders.

Customers can see the timeline of their own orders, but they must never be
able to add, edit or remove entries. It has to be a record we can trust. Set
it up in the local project and make sure it works on the local database.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/database/postgres/triggers.md
