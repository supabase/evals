---
stage: resolve
suite: regression
product:
  - data-api
  - database
topic:
  - rls
motivation: https://supabase.com/docs/guides/troubleshooting/rls-simplified-BJTcS8, supabase/agent-skills#112
---

Our app lets signed-in users manage a personal `tasks` list. Users can create tasks and check them off (`is_done`).

Creating a task works fine, and I can see the row in the table. But when a user checks off a task, the app's update call succeeds with no error, yet `is_done` never actually changes, and the API doesn't return the updated row either.

Find out why the update has no effect and fix it.
