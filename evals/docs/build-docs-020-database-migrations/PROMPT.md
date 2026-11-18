---
stage: build
interface: cli
product:
  - database
topic:
  - migrations
services: []
motivation: >-
  Customers change a table that is already live and end up with a change that
  only works on their own machine: an edit to a file that already shipped, or
  a new column that can't be added to a table that has rows in it. This checks
  that an agent reading the Deploy database migrations guide ships a schema
  change that applies on top of the database that is already out there. The
  prompt omits the page's vocabulary on purpose, so read README.md before
  editing it.
---

Kettle & Crumb is adding a delivery option to every order, standard or
express. Every order we already have went out standard, and nobody should have
to go back and retype them.

Get the change into the repo so it goes out with our next release, and have it
working on my local database today.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/deployment/database-migrations.md
