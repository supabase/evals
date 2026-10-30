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

I'm building a small task tracker on the linked hosted Supabase project. Use a code-first workflow so the team can review and replay the schema and sample data:

1. Run `supabase migration new create_tasks` and edit the generated SQL file to create a tasks table with `title`, `completed`, and `created_at` columns.
2. Include three example tasks in the migration, with one marked complete.
3. Apply the migration to the linked hosted project with `supabase db push --linked`.
4. After the push succeeds, query the saved data and tell me how many tasks are still open.

Keep the schema and example inserts in the migration file and apply them through `db push`. If a command is blocked, report its error and what remains unverified.
