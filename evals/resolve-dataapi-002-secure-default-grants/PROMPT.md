---
stage: resolve
suite: regression
interface: cli
cliVersion: 2.109.1
product:
  - data-api
  - database
  - auth
topic:
  - rls
  - sdk
services:
  - gotrue
  - kong
  - postgrest
motivation: AI-914, AI-667
---

Our app lets signed-in users keep a private journal. Entries are stored in the `journal_entries` table. A user should only ever see their own, and they need to be able to create new entries from the app.

I can see the rows when I query the table directly, but the journal page shows an empty list for every signed-in user. New entries don't show up after saving either. Please figure out why and fix it.
