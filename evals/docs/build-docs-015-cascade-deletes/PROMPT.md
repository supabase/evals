---
stage: build
interface: cli
product:
  - database
topic:
  - sql
services: []
motivation: >-
  Customers lose data to cascades they did not expect, or hit blocked deletes
  when a link has no rule. This checks that an agent reading the Cascade
  Deletes guide picks the right action per relationship, so the right rows go
  and the right rows stay. The prompt omits the page's vocabulary on purpose,
  so read README.md before editing it.
---

Customers can close their team from the settings page, but closing a team
fails with a database error and nothing gets removed. When a team closes,
everything that belongs to it should go with it: its people, its projects,
their tasks, and the discussion on those tasks.

Two things have to survive. Finance keeps every invoice, closed team or not.
And people leave teams all the time; when someone leaves, the comments they
wrote stay on the task.

Make the change in the repo's migrations and apply it to the local database.

Read the guide below before you start and rely on it for how to set this up,
rather than on what you already know.

REFERENCE
https://supabase.com/docs/guides/database/postgres/cascade-deletes.md
