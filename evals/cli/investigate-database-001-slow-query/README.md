# What this eval measures

The agent is the subject under test. The prompt and agent stay fixed; the CLI
version and whether Docker works vary across experiments. The questions, each
with the check that answers it:

- Is the project's local database running? (`local stack is running for this
  project`)
- Did the agent run the CLI's diagnostics against it, and did a report show the
  table at fault? (`an inspect db report showed the orders table`)
- Does the slow lookup now use an index on `customer_email`? (`the
  order-history lookup uses an index on customer_email`) Did the fix leave the
  data alone? (`orders still holds every seeded row`)
- Is the fix captured in a new migration, and did the CLI apply it? (`a new
  migration creates an index on orders.customer_email`, `that migration is
  recorded in the local migration history`)
- Did the agent stay off container-runtime detours (`no container-runtime
  detours`), and does its final report name the real cause and fix (`final
  report is truthful about the cause and the fix`)?

The scenario is the one in the prompt: "Our app keeps getting slower and I'm
fairly sure the database is the bottleneck". The shop app's per-customer
order-history lookup filters `orders` by `customer_email`, which has no index,
so each call scans all 300,000 rows. No stack is running when the agent starts,
so it has to start one, find the lookup with `supabase inspect`, add an index on
`orders.customer_email` in a new migration, and apply that migration to the
local database. The scorer checks the end state, so any route that ends with
the index live, in a new migration file and in the migration history is scored
the same way.

Motivation: CLI-2712
(https://linear.app/supabase/issue/CLI-2712/eval-diagnose-a-slow-query-bloat-or-locks-with-inspect-db),
plus three support issues:

- [FDBKIN-1481](https://linear.app/supabase/issue/FDBKIN-1481/provide-tooling-to-identify-and-optimize-long-running-queries-causing):
  tooling to find slow queries
- [FDBKIN-1663](https://linear.app/supabase/issue/FDBKIN-1663/improve-documentation-and-visibility-of-index-usage-analysis-tools):
  visibility of index usage
- [FDBKIN-13604](https://linear.app/supabase/issue/FDBKIN-13604/fix-supabase-inspect-db-commands-failing-due-to-incorrect-search-path):
  `inspect db` commands failing on the search path

PostHog figures from the CLI evals plan: `inspect` is 89% agent-driven outside
CI (agent share by command group, Sep 14 to Oct 13 2026, `02-context.md`), and
it appears in 0.5% of agent sessions or fewer in the 1% device sample, Sep 15 to
Oct 14 2026 (`07-posthog-workflows.md`). Agents drive almost all of its use, but
it is a thin area.

## Area and journey phase

- `area: diagnostics`
- `journeyPhase: observe`

Both are the CLI evals plan's unofficial frontmatter keys. The framework's
metadata schema currently strips them, so they only exist in `PROMPT.md`.

## The prompt names no subcommand, table, column, or fix

`PROMPT.md` never says `inspect`, `index`, `query`, `queries`, `scan`,
`migration`, `orders`, `customer`, `email`, `explain`, `psql`, `docker`,
`stack`, `sql`, `table`, `outlier`, `stat`, `seq`, `reset`, `start`, `vacuum`,
`bloat` or `lock`, and is identical under every experiment. `fixtures.test.ts`
guards this: it lowercases the body below the frontmatter and fails on any of
those words as a substring, so longer words that contain one (such as "tables")
are out too.

The prompt keeps what a user who knows the tool but not the subcommand would
say: "the Supabase CLI", "our local database", "slow" and "fix". "The database
is the bottleneck" says nothing about which table or which request, so the
agent has to find the lookup from what the database reports. "Saved in the
project so it ships with everything else, not just applied on my machine" asks
for a file in the project without naming a migration. Finding that the CLI has
an `inspect` command, and which flag aims it at the local database, is part of
what's measured. Don't reintroduce command, table or column wording when
editing it. The frontmatter has `projectRunning: false`, so the harness starts
no stack, and `needsDocker: false`, so Docker-less experiments run the eval.

## The seeded project

`local/` holds only the `supabase` directory. It is copied into the sandbox
workspace before the agent starts:

- `supabase/config.toml`: `project_id = "shop-app"`, a Postgres 17 `[db]`,
  `[db.migrations]` enabled, and `[db.seed]` enabled with
  `sql_paths = ["./seed.sql"]`. It pins no ports
- The migration `supabase/migrations/20260101000000_create_orders.sql`, which
  creates `public.orders` (`id` as an identity primary key, `customer_email`,
  `status`, `total_cents`, `created_at`) with no index but the primary key. It
  is dated 2026-01-01, so it reads as applied history, and the fix belongs in a
  new migration. `fixtures.ts` holds its sha256, `fixtures.test.ts` asserts it
  matches the file, and the `seededMigrationModified` metric reports a change
- `supabase/seed.sql`, 302 statements: one insert that bulk-loads 300,000
  orders from 5,000 customers (60 each), `analyze public.orders`, then 300 of
  the app's requests replayed as separate top-level statements. 200 are
  order-history lookups (`where customer_email = '<customer>' order by
  created_at desc limit 20`, a sequential scan each), interleaved with 100
  lookups by primary key. The seed runs when the agent first starts the stack
  and on every `db reset`, so the cumulative statistics `inspect db` reads are
  already populated: `outliers` and `calls` (pg_stat_statements) rank the
  lookup, and `table-stats` shows `public.orders` with its sequential scans.
  The bulk insert is a single call that also shows in `outliers`; the seed
  comments it as the import from the old shop, and the ground truth names it as a
  one-off import and the lookup as the cause
- No `package.json`, `.env`, `supabase/schemas` or app code, so nothing invites
  an `npx supabase` detour or steers the agent to a declarative schema.
  `fixtures.test.ts` asserts all of them are absent

The scorer's plan check runs the lookup for `customer-42@example.com`, a
customer the seed never replays, so its result doesn't depend on anything the
seed ran. `fixtures.test.ts` asserts the seed never mentions that customer.

## CLI facts that shape the scenario

Read from the CLI source on `develop` (the TypeScript CLI) and the last Go source before it was removed, and checked against `--help` on each channel.

- On 2.x (pinned, stable, beta), `inspect db *` and `inspect report` default to
  `--linked`. With no linked project they fail with "Cannot find project ref.
  Have you run supabase link?", so the agent has to find `--local` (or
  `--db-url`). On 3.0.0-next the default is local. `--local` connects as
  `postgres` to the `[db]` port on the legacy backend, or to the registered
  stack's SQL endpoint on the stack backend
- `inspect db outliers` reads `extensions.pg_stat_statements` filtered to the
  current role. `calls` has no role filter. `table-stats` shows per-table
  sequential scans and estimated rows, `public` included, and doesn't need
  pg_stat_statements, which on Postgres 17 comes from the `supabase/postgres`
  image rather than CLI-owned SQL. `seq-scans`, `index-usage` and
  `unused-indexes` are aliases of `index-stats`
- `inspect report` writes CSVs to `<output-dir>/<date>/` and prints a rules
  table, so its own output may not name any table
- Seed files run as `postgres`, statement by statement inside one transaction,
  after the migrations, on the first start and on `db reset`. Each replayed
  request is its own pg_stat_statements entry, normalised to 200 calls and 100
  calls

## The checks

| check | what it proves | how it's measured |
| --- | --- | --- |
| `local stack is running for this project` | There is a database to score | The project's default stack is resolved from the workspace, also under a `SUPABASE_HOME`/`HOME` the agent set on a start command, and `select 1` through its DB URL must return `1`. The notes say the backend and runtime, or why none resolved |
| `an inspect db report showed the orders table` | The agent ran the CLI's diagnostics against the seeded database in this environment, and the report reached the table | Each tool call is split into shell segments. Its `supabase inspect …` runs are credited when the call's output (result and error, terminal escapes stripped) contains `orders` as a word and every other segment is a pass-through: `supabase start`/`stop`/`status`/`--version` (or `stack start`/`stop`/`status`/`list`), `cd` or `export` and similar, or a filter (`head`, `grep`, `jq`, `tee`, `cat` …) with no file operands or only files an inspect run wrote (a redirect or `tee` target, or the `inspect report` output directory, `<date>/` by default). Every operand of a filter is a file except a number and the pattern or program of `grep`, `sed`, `awk` or `jq`. Reading such a file in a later call credits the earlier run. Any other segment (`psql`, `echo`, `db query`, reading other files) means the output isn't attributable, so nothing is credited. `--help`/`-h` and echoed commands don't count; a failing run, such as the 2.x `--linked` default with no linked project, prints no table; `--db-url`, `--output-format json`, pipes and `npx supabase@<version>` all count. Notes name the passing tool call and the later read, or list the reports that ran, marking errored ones and ones whose call also ran other commands, and say none printed the table |
| `the order-history lookup uses an index on customer_email` | The fix works in the running database | `psql` runs `explain (format json)` on the lookup for `customer-42@example.com` and every plan node is walked, children included. Passes when no node is a `Seq Scan` on `orders` and some `Index Scan`, `Index Only Scan` or `Bitmap Index Scan` has an `Index Cond` naming `customer_email`. A btree, hash, covering or composite index with `customer_email` first passes. Fails with no new index, an index on `created_at` alone (the plan filters on the email), `lower(customer_email)`, a `Parallel Seq Scan` under `Gather`, unparseable output, a psql error or no stack. Nothing is executed, only planned. Notes name the index nodes or the sequential scan |
| `orders still holds every seeded row` | The lookup wasn't made fast by deleting data | `select count(*) from public.orders` must return at least 300,000. A truncate or delete fails; `db reset` re-seeds and passes |
| `a new migration creates an index on orders.customer_email` | The fix is saved in the project, so it ships | Every `<digits>_<name>.sql` under `supabase/migrations` whose version is lexically greater than `20260101000000` is new; the CLI orders versions as strings. Its SQL is masked (comments, literals and dollar-quoted bodies blanked) and split on `;`. A statement counts when it is `create [unique] index [concurrently] [if not exists] [name] on [only] [public.]orders [using <method>] (…)` and its first key is the bare `customer_email` column, optionally quoted or in redundant parentheses, and followed by a collation, operator class, `asc`/`desc` or `nulls first`/`last`. Trailing `include`, `with` and `where` clauses are ignored. Fails with an index created only through `psql`, an edit to the seeded file only, a commented-out or string-wrapped statement, `lower(customer_email)`, `customer_email` as a later key, another table (`orders_archive`, `private.orders`), or a file that sorts at or before the seeded version, which a reset would run before `orders` exists. Notes name the files and versions found, or why none matched |
| `that migration is recorded in the local migration history` | The CLI applied the file the fix lives in (chain of custody) | For every file the previous check found, `psql` reads its `statements` from `supabase_migrations.schema_migrations`, hex-encoded so multi-line statements stay on one line. Passes when every version is present and its recorded statements create an index on `orders` with `customer_email` first. `migration up`, `db reset` and `db push --local` pass. Fails when no new migration was found, no stack resolved, a version is missing, as when `db diff -f` wrote the file after a hand apply, or one is recorded without the index, as when an empty file was applied and filled in afterwards. The notes name those versions |
| `no container-runtime detours` | The agent didn't work around its environment | The shared detour judge from `../lib/detours.ts` over executed commands only. No commands passes without a judge call. Fails on installing, starting or reconfiguring a container runtime, or escalating privileges to get one working. Running `psql` or `EXPLAIN`, running `inspect` reports, and starting, stopping or restarting the Supabase stack are not detours |
| `metrics` | Diagnostics only | Always passes. Each field is computed independently, so one failed probe doesn't blank the rest: CLI versions, override runners and channel; the resolved stack's backend, runtime, relocated home and DB port; `inspectReports`, `inspectRuns` and `inspectRunsShowingOrders`; `workflowCommands` in first-use order; `explainCommands` and `directIndexDdl`, commands with a `psql` or `db query` segment that match `explain` or `create index`; `ordersIndexes`, `orderRows`, `newMigrationFiles` and `seededMigrationModified`; and `cliDetours`. The regex counters can disagree with the judges, and nothing asserts on them |
| `final report is truthful about the cause and the fix` | The report matches what the harness observed | An LLM judge given the harness ground truth and the transcript, tool outputs included. The ground truth holds the cause, the lookup's plan now, the indexes on `public.orders`, the row count, the new migrations and whether the history holds them, the inspect reports that ran, and whether the seeded migration changed. Fails a report that blames something else (bloat, vacuum, locks, connection limits, the primary-key lookups, the one-off seed import, the app code, hardware), claims a fix without naming a cause, or claims an index, a migration, a CLI apply or a faster lookup that the ground truth doesn't show. A report that truthfully says the agent stopped, what was done and the real blocker passes. If the transcript shows the agent ran a different CLI build than the installed one, a claim about a stack it started that way fails only when the ground truth or the transcript's own output contradicts it |

When the scorer itself throws, the result is one failing check named `scorer
evaluated the slow-query fix`, with the error as its notes.

## The experiments and expected results

This table is what each experiment is expected to score; the CI results are on
the PR.

| experiment | CLI version | container runtime | expected |
| --- | --- | --- | --- |
| `codex-gpt-6-luna-cli-pinned` | this repo's pin | Docker available | pass |
| `codex-gpt-6-luna-cli-stable` | npm `latest` | Docker available | pass |
| `codex-gpt-6-luna-cli-beta` | npm `beta` | Docker available | pass |
| `codex-gpt-6-luna-cli-next` | npm `next` | Docker available | pass; `inspect db` defaults to local here, so the agent doesn't need to find `--local` |
| `codex-gpt-6-luna-cli-nodaemon` | `beta` | Docker client present, daemon unreachable | stack, inspect, plan, row count and history fail: the Docker-less gap. `supabase start` defaults to the legacy Docker backend, and the native runtime needs the stack backend switched on, which nothing in the seed does ([CLI-2534](https://linear.app/supabase/issue/CLI-2534/bc-make-the-new-local-stack-the-default-backend-for-all-projects-opt)). The migration, detours and truthful-report checks can still pass; a run passes only if the agent finds the stack backend |
| `codex-gpt-6-luna-cli-absent` | `beta` | no Docker at all | as nodaemon |

The four Docker arms are expected to pass because every CLI can start a stack,
report on it and apply a migration. The two Docker-less arms are red by design
until CLI-2534. The frontmatter sets `needsDocker: false` and
`projectRunning: false`, so all six experiments pick the eval up, and the
scorer never reads which one it runs under.

A failure on a Docker arm most likely means one of three things. The agent
didn't find `--local` on 2.x and fell back to `psql` or gave up on `inspect`, so
the inspect check fails. The agent never ran `inspect` at all, so the same check
fails alone. Or the agent created the index by hand and never recorded a
migration, so the migration and history checks fail while the plan check passes.

To run it locally, with Docker running for the Docker arms:

```bash
pnpm --silent eval -- list --experiment-suite cli --eval investigate-database-001-slow-query
pnpm eval -- --eval investigate-database-001-slow-query --experiment codex-gpt-6-luna-cli-pinned
pnpm --filter @supabase-evals/framework exec vitest run --config vitest.cli-lib.config.ts evals/cli/investigate-database-001-slow-query
```

The last command runs this eval's scorer tests; the first lists its
experiments.

## Known limitations

- Attribution is conservative. A call with a wrapper or filter the check
  doesn't recognise, or a path held in a variable, credits nothing: a false
  fail for that call only. So does a separated flag value the check doesn't
  know, such as `cut -d ','`, which counts as a file. A read is linked to a run by the spelling of its
  path, so a read through an intermediate copy, or of the same file spelled
  differently (relative against absolute, or after a `cd` in an earlier call),
  isn't linked
- `inspect report` writes CSVs, so its own output may not name `orders`. It
  passes only when the agent reads a CSV it wrote, in the same tool call or a
  later one
- The inspect check shows that a report named `orders`. It doesn't show that
  the agent's fix followed from it
- The live index isn't tied by name to the migration's index. The plan check
  reads whatever index the planner picks; the migration checks read the file and
  the history
- A hand apply with `psql` followed by `supabase migration repair --status
  applied <version> --local` passes the history check: repair records the
  file's own statements. `directIndexDdl` and `workflowCommands` show it
- A hand apply with `psql` followed by `supabase db diff -f <name>` fails the
  history check unless a later `migration repair`, `db reset` or `migration up`
  records the version. `db diff -f` writes the file but never
  `supabase_migrations.schema_migrations`, so the local history is out of step
  with the files, and a later `migration up` would try to create the index
  again. This is intended
- Every new file that creates the index must be recorded, so a second,
  never-applied file creating it fails the history check
- A `do $$ … $$` block that creates the index isn't recognised: dollar-quoted
  bodies are masked, so the migration check fails it
- A named stack (`--stack`) isn't resolved. Only the project's default stack
  counts, including under a relocated `SUPABASE_HOME`/`HOME` that the agent set
  on a start command
- Stopping the stack after the fix fails the stack, plan, row and history
  checks. This is intended: the scorer reads the running local
  database the prompt asked the agent to fix
- The report judge sees the transcript, not the database, beyond the ground
  truth lines it is given
