---
stage: build
interface: rest
product:
  - database
  - data-api
topic:
  - migrations
motivation: https://linear.app/supabase/issue/AI-1399/add-an-agent-eval-suite-for-spark-rest-api
---

Our task tracker already has tasks in the connected Spark project. Add optional due dates to tasks, preserving all existing tasks and their current fields. Use a date column named `due_date`.

Set the due date of "Ship task tracker" to 2026-11-10. Leave the other tasks undated. Verify the saved changes, then list all open tasks ordered by due date ascending, with undated tasks last and ties ordered by ID ascending. Include each task's ID, title, and due date in your answer.
