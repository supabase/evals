---
stage: build
interface: rest
product:
  - auth
  - database
topic:
  - sdk
  - rls
motivation: >-
  Multi-user todo app on an empty Spark project: the agent must create the
  `todos` table with row-level security so each person only sees and changes
  their own rows, and drive supabase-js from client-side code. The prompt
  mentions neither the SDK nor RLS.
---

Our app in `app/` needs a todo list. Wire up `app/src/todos.mjs`. People sign up
with an email and password and sign back in later. Each person has their own
todo list: they can add todos, see their list, rename or tick them off, and
delete them. Nobody should ever be able to see or change anybody else's todos.

The backend for this app is the provided Spark project (already running). It
is empty, so set up what the todo list needs in it, starting with a `todos`
table that stores each todo's title in a `title` column and its done flag in a
boolean `done` column. Everything in `app/` is client-side code. When you're
done, the functions should work for real against it.
