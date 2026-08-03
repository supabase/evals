---
motivation: derived from resolve-dataapi-001-empty-results, AI-822, https://supabase.com/docs/guides/troubleshooting/why-is-my-select-returning-an-empty-data-array-and-i-have-data-in-the-table-xvOPgx
stage: investigate
suite: trigger
interface: mcp
product:
  - database
topic:
  - sql
---

Our app lets signed-in users save bookmarks and view them on their dashboard. Bookmarks are stored in the `bookmarks` table and are private — a user must only ever see their own. 
Users also need to be able to save new bookmarks from the app.

I can see the rows when I query the table directly, but the dashboard shows an empty list for every user.

Find out why the Data API returns nothing and fix it.
