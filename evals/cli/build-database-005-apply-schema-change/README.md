# What this eval measures

The agent is the subject under test. The prompt and agent stay fixed; the CLI
version and whether Docker works vary across experiments. The questions, each
with the check that answers it:

- Is the project's local database running? (`local stack is running for this
  project`)
- Does it have the column in the shape the app needs: `tasks.due_date`, as a
  nullable date or timestamp? (`tasks.due_date exists in the local database as
  a nullable date or timestamp`)
- Is the change captured in a new migration file, not only applied to the
  running database? (`a new migration adds due_date to tasks`)
- Was that migration applied through the CLI, so that it is recorded in the
  local migration history? (`that migration is recorded in the local migration
  history`) This is the chain of custody: a column added by hand with `psql`
  and a migration file written afterwards has the column and the file, but no
  history row for it, so it doesn't pass.
- Did the agent stay off container-runtime detours (`no container-runtime
  detours`), and does its final report match what is true (`final report is
  truthful about the schema change`)?

The scenario is the one in the prompt: "I've added due dates to tasks on the
app side, but the database doesn't have them yet". The app code already reads,
writes and orders by a `due_date` column on `public.tasks`, and the project's
only migration creates the table without it. No stack is running when the agent
starts, so it has to start one, add the column in a new migration (written by
hand, or with `migration new`, `db diff -f` or `db schema declarative sync`),
and apply that migration through the CLI. The scorer checks the end state, so
the imperative and the declarative route are scored the same way.

Motivation: CLI-2701
(https://linear.app/supabase/issue/CLI-2701/eval-make-a-schema-change-and-apply-it-locally),
plus PostHog evidence from the CLI evals plan. In a 1% device sample of agent
CLI sessions, Sep 15 to Oct 14 2026, the "new migration, apply, push" workflow
(`migration new` → `db push` / `db reset`) showed up in 12,177 sessions, with a
35% non-zero-exit rate. 39% of those sessions came from Claude Code and 50%
from Codex. `db reset` is in 8.0% of agent sessions and `migration new` in
4.6%.

## Area and journey phase

- `area: schema-and-migrations`
- `journeyPhase: design`

Both are the CLI evals plan's unofficial frontmatter keys. The framework's
metadata schema currently strips them, so they only exist in `PROMPT.md`.

## The prompt names no command, column, or file

`PROMPT.md` never says `supabase`, `migration`, `column`, `due_date`, `alter`,
`psql`, `docker`, `reset`, `stack`, `table` or `sql`, and is identical under
every experiment. `fixtures.test.ts` guards this: it lowercases the body below
the frontmatter and fails on any of those words as a substring, so longer words
that contain one (such as "tables") are out too.

The prompt keeps the user's own words: "due dates", "tasks", "schema change"
and "local database". "The app side" sends the agent to the app code for what
the column is called and what type it has. Finding out that the CLI starts the
local stack, how to write and apply a migration, and where the CLI records
what it applied is part of what's measured, and "schema change" favours neither
the imperative nor the declarative route. Don't reintroduce command, file or
column wording when editing it. The frontmatter has `projectRunning: false`, so
the harness starts no stack, and `needsDocker: false`, so Docker-less
experiments run the eval.

## The seeded project

`local/` is copied into the sandbox workspace before the agent starts:

- A minimal config, `supabase/config.toml`: `project_id = "tasks-app"`, a
  Postgres 17 `[db]`, `[db.migrations]` enabled, and `[db.seed]` enabled with
  `sql_paths = ["./seed.sql"]`. It pins no `[api]` or `[db]` ports
- The migration `supabase/migrations/20260101000000_create_tasks.sql`, which
  creates `public.tasks` (`id`, `title`, `done`, `created_at`). It is dated
  2026-01-01 and the app already depends on the table, so it reads as applied
  history. The change belongs in a new migration, not in an edit of
  this one. The scorer compares the file's sha256 with the one in
  `fixtures.ts`, and `fixtures.test.ts` asserts the checksum matches the file
- `supabase/seed.sql`, which inserts three tasks (`Write the launch post`,
  `Book the venue`, `Send invites`) without naming `due_date`. Applying the
  migration to a database that already has these rows is the realistic case,
  and it is where a `not null` column without a default fails. Since the seed
  runs after the migrations on a first start and on `db reset`, such a column
  breaks the seed insert there too
- `src/tasks.ts`, the source of what the column must be. It names the column
  `due_date`, types it `string | null` on `Task`, selects it and orders by it
  in `listTasks`, writes a string in `setDueDate`, and writes `null` in
  `clearDueDate`. That `null` is why the column must be nullable: a `not null`
  column with a default applies cleanly, but clearing a due date then fails.
  `string` is what supabase-js returns for `date` and for both timestamp types,
  so all three are accepted
- `src/supabase.ts`, a supabase-js client built from `SUPABASE_URL` and
  `SUPABASE_ANON_KEY`. It makes `src/tasks.ts` read like a working app module
  and carries no credentials, URL or port

There is no `package.json`, so nothing invites an `npm install` or an
`npx supabase` detour. There is no `.env`, and no `supabase/schemas` folder, so
nothing steers the agent to a declarative schema. `fixtures.test.ts` asserts
all three are absent.

## CLI facts that shape the scenario

Verified on `supabase@2.117.0` (this repo's pin), `2.121.0` (npm `latest`),
`2.122.0-beta.1` (`beta`) and `3.0.0-next.16` (`next`).

- All four have `migration new|up|list|repair|squash|down|fetch`,
  `db reset|diff|push|query`, and `db schema declarative sync|generate`.
- `migration up` applies pending migrations to the local database and records
  them in `supabase_migrations.schema_migrations`. `db reset` re-applies every
  migration and the seed. `db push --local` applies and records.
  `supabase start` applies the migrations present when the database is first
  created.
- `db diff -f <name>` writes the diff as a new migration file but does not
  apply it or touch the history.
- `db schema declarative sync` diffs `supabase/schemas` against the migrations
  and writes a new migration. `--apply` (or `--yes`) applies it locally and
  updates the history; `--no-apply` only writes the file. On 2.117.0, 2.121.0
  and 2.122.0-beta.1 the command is gated: without `--experimental` or
  `[experimental.pgdelta] enabled = true` it fails with "declarative commands
  require --experimental flag or pg-delta enabled in config". On 3.0.0-next.16
  the gate is gone, and the same call fails only because no declarative schema
  exists yet.
- Every valid path ends with a new migration file and a history row, which is
  why the scorer can check one shape for both the imperative and the declarative
  routes. No CLI gap blocks this journey, so the eval links no CLI issue.

## The checks

| check | what it proves | how it's measured |
| --- | --- | --- |
| `local stack is running for this project` | There is a local database to inspect | The project's default stack is resolved from the workspace (the managed `stack status` first, then the legacy `status`), and `select 1` through its DB URL must return `1`. If the default home has no stack, the lookup repeats under each `SUPABASE_HOME`/`HOME` the agent set on a start command. The notes say the backend and runtime, or why none resolved |
| `tasks.due_date exists in the local database as a nullable date or timestamp` | The schema change reached the local database in the shape the app needs | `psql` against the stack reads `data_type` and `is_nullable` for `public.tasks.due_date` from `information_schema.columns`. Passes for `date`, `timestamp without time zone` or `timestamp with time zone`, when nullable. Fails on a missing column, any other type (a `text` column, say, or a column with another name such as `due_at`), `not null`, or a probe whose output isn't recognised |
| `a new migration adds due_date to tasks` | The change is captured in the project, not only in the running database | Every `<digits>_<name>.sql` under `supabase/migrations` except the seeded file is read, and one passes when it matches the rules below. The notes list the matching files and their versions. Fails when only `psql` or `db query` ran, when only the seeded migration was edited to add the column, or when the match is a look-alike |
| `that migration is recorded in the local migration history` | The migration was applied through the CLI (chain of custody) | `psql` selects the matching files' versions from `supabase_migrations.schema_migrations`. Passes when any one of them is there, so a second matching file that was never applied doesn't fail it. It reads the table, not which CLI command wrote the row. Fails when no matching migration exists, or no stack resolved, or none of the versions is recorded |
| `no container-runtime detours` | The agent didn't work around its environment | The shared detour judge from `../lib/detours.ts` over executed commands only. No commands passes without a judge call. Fails on installing, starting or reconfiguring a container runtime, or escalating privileges to get one working. Running `psql` or other client tools against the local database, and starting, stopping or restarting the Supabase stack, are not detours. Naming a blocker in the report can't count, since only commands are judged |
| `metrics` | Diagnostics only | Always passes; see below |
| `final report is truthful about the schema change` | The report matches what the harness observed | An LLM judge given the harness ground truth and the transcript. See below |

When the scorer itself throws, the result is one failing check named
`scorer evaluated the schema change`, with the error as its notes.

A migration file counts as "a new migration adds due_date to tasks" under these
matcher rules. Its SQL is first masked: `--` and `/* */` comments, string
literals and dollar-quoted bodies are blanked, and quoted identifiers are kept.
The result is split on `;`, and a statement counts when, case-insensitively:

- it starts with `alter table`, then optionally `if exists` and `only`, then
  `tasks`, unqualified or qualified as `public` (either name may be
  double-quoted). `tasks` can't be followed by another identifier character, so
  `tasks_archive` doesn't match, and a table in another schema (`private.tasks`)
  doesn't either
- and the rest of the same statement has `add`, an optional `column`, an
  optional `if not exists`, then `due_date` (optionally double-quoted, not
  followed by another identifier character). `due_date_old` doesn't match, and
  `rename column … to due_date` or `add constraint due_date_check` don't either

A multi-action alter such as `add column a int, add column due_date date`
matches, and so does the quoted form the CLI's diff and declarative sync write
(`alter table "public"."tasks" add column "due_date" date`).

A `create table` in a new migration never counts, whatever columns it lists: a
migration that recreates `tasks` can't be applied to a database that already has
the table, and dropping the table first wipes its rows. A commented-out
statement and DDL inside a string literal don't count either, and neither does
a change that only exists in a `supabase/schemas` file with no migration
generated from it. The seeded migration is excluded from the scan. If it is the
only file that adds the column, the notes say so.

`metrics` always passes and computes each field independently, so one failed
probe doesn't blank the rest:

- `cliVersion`: the staged CLI version, and `cliVersionAfterRun`, the `PATH`
  version when it moved
- `cliOverride`: runners of another explicit CLI version (`npx`, a global
  install)
- `channel`: the experiment's CLI channel, `pinned` when there isn't one
- `backend`, `runtime`, `relocatedHome` and `dbPort` of the resolved stack
  (`none` for the first two and `null` for the others when no stack resolved)
- `workflowCommands`: the distinct `supabase` subcommands the agent ran, in
  first-use order, such as `migration new`, `migration up`, `db reset` and
  `db schema declarative sync`
- `directDdlCommands`: commands that ran `alter table … due_date` straight
  through `psql` or `supabase db query` instead of writing a file
- `cliDetours`: commands matching a container-runtime detour pattern
- `seededMigrationModified`: whether the seeded migration's checksum changed or
  the file is gone
- `newMigrationFiles`: `.sql` files under `supabase/migrations` other than the
  seeded one, whether or not they match
- `declarativeSchemaFiles`: `.sql` files under `supabase/schemas`
- `taskRows`: rows in `public.tasks`, `null` when the stack is down or the probe
  fails

The two regex counters, `directDdlCommands` and `cliDetours`, are diagnostics.
They can disagree with the judges, and nothing asserts on them.

The report judge sees the transcript and these harness lines: the project
directory, the installed CLI version (every probe used it) with any
`cliOverride` runners, how the local stack resolved, the `due_date` column's
type and nullability, the new migration files with their versions, whether the
history has them, and whether the seeded migration was modified. It fails a
report that claims success that didn't happen, misstates the column, the
migration or where the change was applied, or blames something other than what
the tools reported. It judges only what the report says about the schema, the
migration files, how the change was applied and why the agent stopped. A report
passes when it truthfully says the agent stopped, what was and wasn't done, and
the real reason; a blocker the agent actually hit, such as a stack that wouldn't
start or a CLI error, must be named. If the transcript shows the agent ran a
different CLI build than the installed one, a stack it started that way may be
invisible to the harness, so a claim about it fails only when the ground truth
or the transcript's own command output contradicts it.

## The experiments and expected results

This table is the expectation before the first CI refresh; the results get
filled in on the PR.

| experiment | CLI version | container runtime | expected |
| --- | --- | --- | --- |
| `codex-gpt-6-luna-cli-pinned` | this repo's pin, 2.117.0 | Docker available | pass: the imperative route works on every CLI |
| `codex-gpt-6-luna-cli-stable` | npm `latest` (2.121.0 when verified) | Docker available | pass |
| `codex-gpt-6-luna-cli-beta` | npm `beta` (2.122.0-beta.1 when verified) | Docker available | pass |
| `codex-gpt-6-luna-cli-next` | npm `next` (3.0.0-next.16 when verified) | Docker available | pass; the declarative command has no experimental gate here |
| `codex-gpt-6-luna-cli-nodaemon` | `beta` | Docker client present, daemon unreachable | pass via the native runtime, which `supabase start` picks when Docker doesn't answer |
| `codex-gpt-6-luna-cli-absent` | `beta` | no Docker at all | as nodaemon |

Every arm is expected to pass, because every CLI can start a stack, write a
migration and apply it. On 2.117.0, 2.121.0 and 2.122.0-beta.1 an agent that
tries the declarative route without `--experimental` hits the gate and can
retry with the flag or fall back to a plain migration; either way it ends with
a migration file and a history row. On the Docker-less arms the declarative
route may fail if its shadow database needs Docker; an agent that falls back to
a plain migration still passes.

The frontmatter sets `needsDocker: false` and `projectRunning: false`, so all
six experiments pick the eval up, as the Docker-less ones require. The scorer
never reads which experiment it runs under; the backend and runtime the stack
came up on are reported through `metrics`.

## Known limitations

- DDL wrapped in a `DO $$ … $$` block is masked and doesn't count as a new
  migration. It's rare; `add column if not exists` already covers idempotency.
- The scorer can't tell `db reset` from `migration up` by database state, so
  local data loss isn't scored. All rows here come from `seed.sql`, which a
  reset restores. Which commands ran is reported through `workflowCommands`.
- A named stack (`--stack`) isn't resolved. Only the project's default stack
  counts, including under a relocated `SUPABASE_HOME`/`HOME` that the agent or
  the sandbox set on a start command.
- Editing the seeded migration is reported (`seededMigrationModified`) but only
  fails the eval when no new migration adds the column.
- The report judge sees the transcript, not the database, beyond the ground
  truth lines it is given.
