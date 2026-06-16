---
stage: build
suite: benchmark
interface: cli
product:
  - database
  - data_api
topic:
  - migrations
  - rls
services:
  - gotrue
  - kong
  - postgrest
projectRunning: false
motivation: AI-809, https://supabase.com/docs/guides/getting-started/tutorials/with-nextjs
---

We're kicking off a todos app and I want the Supabase side ready for the team
to build on. Set it up the way we'd run it in development, with schema changes
tracked as migrations so they can be reviewed and replayed.

For the first slice we just need a `todos` table. Todos aren't public: anyone
signed in can read all of them, but nothing should be writable through the API
for now. Add a couple of sample todos so there's something to look at.

Before you hand it back, make sure the running API actually behaves that way —
signed-in users get the todos, signed-out requests get nothing.
