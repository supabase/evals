---
stage: build
interface: cli
product:
  - database
topic:
  - sql
services: []
motivation: >-
  the Cascade Deletes guide is the page agents are pointed at when deleting a
  row has to take its related rows with it, and getting it wrong either way
  costs a customer data. A review of production databases found cascade rules
  that silently delete far more than intended and missing rules that leave
  orphans or block deletes (FDBKIN-4474). Customers have lost a project's data
  to a cascade they did not know was there (FDBKIN-30100, and a support case
  restoring from backup in October 2026), have hit "violates foreign key
  constraint" errors when deleting a user (SQLSTATE 23503, #team-support March
  2026), and ask how to delete a parent with its related data at all
  (FDBKIN-20630). An agent has already widened a delete without checking what
  it would cascade into (supabase/agent-skills#149). The page explains each
  action but not how to choose one per relationship, nor that a single
  blocking path fails the whole delete, which is its own worked example. This
  eval determines whether an agent that reads the page deletes the right rows
  and keeps the right ones. The prompt deliberately omits the vocabulary the
  page teaches, so read README.md before editing it.
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
