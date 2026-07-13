---
stage: resolve
suite: regression
interface: cli
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

Our app lets signed-in users save bookmarks and view them on their dashboard. Bookmarks are stored in the `bookmarks` table and are private. A user should only ever see their own, and they need to be able to save new bookmarks from the app.

I can see the rows when I query the table directly, but the dashboard shows an empty list for every signed-in user. New bookmarks don't show up after saving either. Please figure out why and fix it.
