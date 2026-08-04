# What the seed withholds

The prompt is the `AiPrompt` panel from the [Row Level Security guide](https://supabase.com/docs/guides/database/postgres/row-level-security), copied verbatim. It says *how* to write policies but not *what* access the app wants, so the intended access rules live in comments at the top of the seed migration. The agent has to read them to know what to enforce.

Every part of the lockdown is missing on purpose, and each omission maps to a rule the prompt states:

| Withheld | Rule |
| --- | --- |
| `enable row level security` on all four tables | 1 |
| grants to `anon` and `authenticated` | 2 |
| all policies | 3, 4, 6 |
| indexes on `documents.owner_id`, `team_members.user_id`, `team_documents.team_id` | 5 |
| a private schema and `security definer` helper | 7 |
| `supabase/tests/` | 9, 10 |

`team_members` has a `(team_id, user_id)` primary key, so `team_id` is already indexed and only `user_id` needs a new index — rule 5's "a column that already leads a primary key does not need another one" is live here.

`team_documents` is what makes rules 6 and 7 measurable: reading it requires a membership check against `team_members`, which the migration comments say clients must never read directly. A policy can only satisfy both by going through a `security definer` helper in a private schema.

Columns are plain `uuid` with no foreign key to `auth.users`, so the migration applies without seeding auth. The scorer signs up its own users and seeds their rows at scoring time.
