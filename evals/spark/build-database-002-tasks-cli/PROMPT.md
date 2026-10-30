---
stage: build
interface: cli
product:
  - database
topic:
  - migrations
projectRunning: false
hostedProject: true
needsDocker: false
---

I'm building a small task tracker. Use direct SQL through `supabase db query --linked` to work on the linked hosted Supabase project. Set up a tasks table with `title`, `completed`, and `created_at` columns, and insert three example tasks with one marked complete. Then query the saved data and tell me how many tasks are still open.
