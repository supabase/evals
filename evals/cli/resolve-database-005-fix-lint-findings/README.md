# What this eval measures

The agent is the subject under test. The prompt and agent stay fixed; the CLI
version and whether Docker works vary across experiments. The questions, each
with the check that answers it:

- Did the agent find and run the CLI's own database checks instead of guessing
  from the SQL? (`ran supabase db lint or db advisors`)
- Is the project's local database running? (`local stack is running for this
  project`)
- Does `db lint` come back clean for the project's functions? (`db lint reports
  no errors or warnings in the project functions`)
- Are the four advisor findings gone? (`advisors no longer flag the seeded
  findings`)
- Did the fixes keep the app working without widening access? (`the app still
  reads only its own orders and totals`)
- Do the fixes live in migration files, so replaying them rebuilds the fixed
  database, and are those files recorded in the local migration history?
  (`replaying the migrations and seed reproduces the fixed database`, `every
  migration file is recorded in the local migration history`)
- Did the agent stay off container-runtime detours (`no container-runtime
  detours`), and does its final report match what is true (`final report
  matches what the checks and database show`)?

The scenario is the one in the prompt: "We're about to launch and I want the
database in good shape first". A small orders app ships three migrations that
plant five findings: one `db lint` error and four `db advisors` findings. Every
migration applies cleanly, so nothing fails until the checks run. No stack is
running when the agent starts, so it has to start one, run the checks, read what
they flag, and fix it in a migration applied through the CLI. The scorer checks
the end state, so a hand-written migration, `migration new`, and editing the
seeded migrations followed by `db reset` are scored the same way. `db diff -f`
is not: it writes the file but records nothing in the migration history, so a
run that fixes the live database by hand and then captures it with `db diff -f`
passes the live checks and the replay but fails `every migration file is
recorded in the local migration history` unless it follows with `db reset` or
`migration repair --status applied`. That is intended, since a later
`migration up` would re-run the file.

Motivation: CLI-2711
(https://linear.app/supabase/issue/CLI-2711/eval-run-lint-or-advisors-and-fix-what-they-flag),
an eval where the agent runs `db lint` or the advisors against a schema with
known problems and fixes what they flag. The issue carries no usage figures; its
evidence is:

- FDBKIN-21143, "enable security and performance advisor for local development
  via the CLI"
  (https://linear.app/supabase/issue/FDBKIN-21143/enable-security-and-performance-advisor-for-local-development-via-the)
- FDBKIN-3130, "expose security and performance advisor results in the Supabase
  CLI"
  (https://linear.app/supabase/issue/FDBKIN-3130/expose-security-and-performance-advisor-results-in-the-supabase-cli)
- supabase/cli#3839, "Add a way to check db advisors using CLI command"
  (https://github.com/supabase/cli/issues/3839), closed: `db advisors` shipped
- supabase/cli#5868, "`db advisors --local` misses API-exposure lints
  (rls_disabled_in_public, etc.)" (https://github.com/supabase/cli/issues/5868),
  closed: fixed in 2.110.0-beta.30, so every experiment's CLI has the fix

## Area and journey phase

- `area: tests-and-lint`
- `journeyPhase: resolve`

Both are the CLI evals plan's unofficial frontmatter keys. The framework's
metadata schema strips them, so they only exist in `PROMPT.md`.

## The prompt names no command, finding, or object

`PROMPT.md` never says `lint`, `advisor(s)`, `db`, `rls`, `policy`/`policies`,
`function`, `migration(s)`, `psql`, `docker`, `security`, `performance`,
`stack`, `reset`, `sql`, `start`, `search_path`, `plpgsql`, `order_total` or
`unit_price`, and is identical under every experiment. `fixtures.test.ts`
guards this: it fails on any of those as a case-insensitive whole word in the
body below the frontmatter. It also asserts the prompt still says "local",
"check" and "fix".

The prompt keeps the user's own words: "database checks", "local database",
"fix whatever they flag" and "about to launch". "Supabase's database checks"
sends the agent to the CLI without naming a command and covers both `db lint`
and `db advisors`; running either counts. "About to launch" makes security and
performance relevant without naming the advisors, and "whatever they flag"
leaves what is wrong to the checks, so the agent has to run them and read the
output. Finding out that the two commands exist, that they read a running local
database, and what each covers is part of what's measured. Don't reintroduce
command, finding or object wording when editing it. The frontmatter has
`projectRunning: false`, so the harness starts no stack, and `needsDocker:
false`, so Docker-less experiments run the eval.

## The seeded project

`local/` is copied into the sandbox workspace before the agent starts:

- A minimal config, `supabase/config.toml`: `project_id = "orders-app"`, a
  Postgres 17 `[db]`, `[db.migrations]` enabled, and `[db.seed]` enabled with
  `sql_paths = ["./seed.sql"]`. It pins no ports
- Three migrations that plant the findings. Each applies cleanly, so
  `supabase start` and `db reset` succeed:
  - `20260101000000_create_orders.sql` creates `public.orders` with row level
    security and the policy "Users read their own orders", which calls a bare
    `auth.uid()`. It creates `public.order_items` and never enables row level
    security on it, and `public.order_total(bigint)`, a plpgsql function with
    `set search_path = ''` that sums `oi.quantity * oi.price`
  - `20260201000000_order_items_policies.sql` adds the policy "Users read their
    own order items", which wraps `auth.uid()` in a `select`. It is the right
    policy, but it does nothing while row level security is off
  - `20260301000000_unit_price_and_updated_at.sql` renames
    `order_items.price` to `unit_price`, adds `orders.updated_at`, and creates
    the trigger function `public.set_updated_at()` with no `search_path` plus
    its trigger. plpgsql doesn't check column names when a function is created,
    so the rename breaks `order_total` without any error
- `supabase/seed.sql`, which inserts three orders for two users (the first owns
  orders 1 and 2, the second order 3) and four items. User `6f1c…` should read 2
  orders, 3 items and totals 30.00 and 12.00; user `b8e4…` 1 order, 1 item and
  total 99.99
- `src/orders.ts`, the app contract, which is not executed. It selects
  `order_items(product, quantity, unit_price)` through `orders` and calls
  `rpc('order_total', { p_order_id })`. It pins what a fix has to keep: the
  column is `unit_price`, so renaming it back to `price` isn't a fix, and
  `order_total` keeps its name and parameter, so dropping it isn't one either

The five findings:

| finding | reported by | object |
| --- | --- | --- |
| error: column oi.price does not exist | `db lint` | `public.order_total(bigint)` |
| `rls_disabled_in_public` (ERROR) | `db advisors` | `public.order_items` |
| `policy_exists_rls_disabled` (ERROR) | `db advisors` | `public.order_items` |
| `auth_rls_initplan` (WARN) | `db advisors` | policy "Users read their own orders" on `public.orders` |
| `function_search_path_mutable` (WARN) | `db advisors` | `public.set_updated_at()` |

Two more things show up and are not scored. `db lint` also prints four
`warning extra` unused-parameter findings on `graphql_public.graphql`, a
Supabase-managed function; leaving them alone is correct. `db advisors` at
`--level info` also shows `unindexed_foreign_keys` on `order_items.order_id`;
it is hidden at the default `--level warn`, and adding the index or skipping it
are both fine.

## CLI facts that shape the scenario

Verified on `supabase@2.117.0` (this repo's pin), `2.121.0` (npm `latest`),
`2.122.0-beta.12` (`beta`) and `3.0.0-next.22` (`next`).

- All four have `supabase db lint` and `supabase db advisors`. On 2.x both take
  `--local`, `--linked`, `--db-url` and `--fail-on`. `db lint` also has
  `--schema`/`-s` and `--level warning|error` (default `warning`, which also
  shows `warning extra` and `warning performance`); `db advisors` has
  `--type all|security|performance` and `--level info|warn|error` (default
  `warn`). On next (3.0) the target flags are replaced by
  `--remote[=<ref|branch|url>]` and local is the default. Output is a JSON array
  on stdout (`--output-format json` wraps it in an envelope), diagnostics go to
  stderr.
- `db lint` runs plpgsql_check in a rolled-back transaction over the plpgsql,
  non-trigger functions in every schema except a managed list
  (`information_schema`, `pg_*`, `_analytics`, `_realtime`, `_supavisor`,
  `pgbouncer`, `pgmq`, `pgsodium`, `pgtle`, `supabase_migrations`, `vault`).
  That is why it also reports `graphql_public.graphql`, and why it skips the
  trigger function `set_updated_at`, which only the advisors catch.
- `db advisors` against the local database runs the splinter lint SQL in a
  rolled-back transaction with `search_path = ''`.
- Both read the running local database, so the stack has to be started first.
  The journey works wherever Docker runs. Without Docker it depends on the stack
  backend: `supabase start` defaults to the legacy Docker backend, and the
  native runtime needs the stack backend switched on, which nothing in the seed
  does
  ([CLI-2534](https://linear.app/supabase/issue/CLI-2534/bc-make-the-new-local-stack-the-default-backend-for-all-projects-opt)).
- The scorer doesn't run `db lint` or `db advisors` itself: their flags differ
  between 2.x and 3.0 (`--remote`), and its own probes run in a rolled-back
  transaction. It mirrors their predicates in SQL instead; see the probe below.

## The checks

| check | what it proves | how it's measured |
| --- | --- | --- |
| `local stack is running for this project` | There is a local database for the checks to read | The project's default stack is resolved from the workspace (the managed `stack status` first, then the legacy `status`), and `select 1` through its DB URL must return `1`. If the default home has no stack, the lookup repeats under each `SUPABASE_HOME`/`HOME` the agent set on a start command. The notes say the backend and runtime, or why none resolved |
| `ran supabase db lint or db advisors` | The agent found the CLI's own checks | Counts the agent's `supabase` invocations with verb `db` and subcommand `lint` or `advisors`, whatever the flags, `npx` runners included. Passes when at least one ran, whether or not it succeeded; the notes read `db lint ×N, db advisors ×M`. Fails when the agent only read the migrations, or ran the advisor SQL by hand |
| `db lint reports no errors or warnings in the project functions` | The broken function is fixed | The probe runs plpgsql_check over the functions `db lint` covers and fails on any issue at level `error` or `warning*`; the notes list `function: level message`. Fails while `order_total` still reads `oi.price`; passes after correcting the body or rewriting it as `language sql`. A probe that errors or doesn't finish fails |
| `advisors no longer flag the seeded findings` | The four advisor findings are gone | The probe evaluates the splinter predicates of the four seeded lint types (`rls_disabled_in_public`, `policy_exists_rls_disabled`, `auth_rls_initplan`, `function_search_path_mutable`) over user schemas. Any finding fails; the notes list `name on object`. Passes with row level security on `order_items`, `(select auth.uid())`, and `set search_path` to `''` or `pg_catalog`, whether the policy was altered or dropped and recreated |
| `the app still reads only its own orders and totals` | The fixes kept the app working and didn't widen access | The probe reads as each seeded user (role `authenticated`, JWT claims set): the order count, the count of `order_items` rows with a non-null `unit_price`, and `order_total(p_order_id => id)` for every visible order. User `6f1c…` must get 2, 3 and totals {30, 12}; user `b8e4…` 1, 1 and {99.99}; totals compare numerically, unordered, within 0.005. Each reader's summed `order_total` over the seeded order ids it can't read must be 0, which catches a `security definer` `order_total` that leaks other users' totals; an error from `order_total` on someone else's order counts as not leaking, while errors in the reader's own reads still fail it. As `anon` it must read 0 orders and 0 items with that same sum 0, or get permission denied (`42501`); any other error fails. It also sets order 1's `updated_at` to 2000-01-01 and requires the trigger to move it to a later time, so a trigger stamping `now()`, `clock_timestamp()` or `statement_timestamp()` passes. One note clause per failing part. Fails when `order_total` or `set_updated_at` was dropped, the orders policy became `using (true)`, `authenticated`'s grants were revoked or the `order_items` policy dropped, or `unit_price` was renamed back. Also revoking `anon`'s grants still passes |
| `every migration file is recorded in the local migration history` | The migration files on disk were recorded in the local migration history | The probe selects `version` from `supabase_migrations.schema_migrations`, and the leading digits of every `<digits>_<name>.sql` under `supabase/migrations` must be among them. Passes after `migration up`, `db reset` or `db push --local`. The notes read `N files recorded` or list the unrecorded files. Fails when a migration was written but applied by hand with `psql`, and when no stack resolved |
| `replaying the migrations and seed reproduces the fixed database` | The fixes live in the migration files, not only in the running database | In a rolled-back transaction the probe drops the tables, views, materialized views, foreign tables, sequences not owned by a column or identity, routines and enum, domain, range and standalone composite types in `public` (extension members stay), and every postgres-owned non-Supabase schema, replays the migration files in version order and then `supabase/seed.sql`, resets session settings, and reruns the lint, advisor and app-behaviour checks. The notes read `N files replayed cleanly`, `<file>: <error> (<SQLSTATE>)` for a replay that stopped, or the failing aspect (`lint`, `advisors`, `app behaviour`) with its notes. Fails when the fixes were made only through `psql` or `db query`, and when a new migration doesn't replay |
| `no container-runtime detours` | The agent didn't work around its environment | The shared detour judge from `../lib/detours.ts` over executed commands only. No commands passes without a judge call. Fails on installing, starting or reconfiguring a container runtime, or escalating privileges to get one working. Supabase CLI commands (start, stop, status, `db lint`, `db advisors`, `db reset`, `db query`, `db diff`, `migration new`, `up` or `list`), `psql` or other database clients, and reading or editing files under `supabase/` are not detours |
| `metrics` | Diagnostics only | Always passes; see below |
| `final report matches what the checks and database show` | The report is honest about what was flagged and changed | An LLM judge given the harness ground truth and the transcript. See below |

When the probe can't run (no stack, no migration files, `psql` failing), the
lint, advisor, behaviour, history and replay checks all fail with its notes.
When the scorer itself throws, the result is one failing check named `scorer
evaluated resolve-database-005-fix-lint-findings`, with the error as its notes.

### The probe

One script goes through `psql` to the stack's DB URL, wrapped in `begin …
rollback`, so nothing it does persists. `plpgsql_check` is created in
`extensions` inside that transaction. Each probe is a `pg_temp` plpgsql function
that catches its own errors and prints one JSON line per row, so a failed probe
fails its own check without blanking the rest.

- Lint, advisors and the replay's drops share one list of Supabase-owned
  schemas: splinter's exclusion list plus the CLI's managed list. Tampering with
  `graphql_public` isn't scored, and leaving its four warnings alone is correct.
- The replay's drops skip sequences owned by a column or identity, which go with
  their table. `plpgsql_check` is dropped before the replay and created again
  after it, so a migration that runs `create extension plpgsql_check` without
  `if not exists` replays as it does under `db reset`.
- The replay runs each file with `execute`. Whole-line transaction-control
  statements (`begin;`, `commit;`, `start transaction;` and the like) are
  stripped first, because `execute` rejects them and the CLI accepts them, so a
  migration wrapped in `begin; … commit;` replays. An error rolls back the whole
  replay and names the file and SQLSTATE.
- The probe takes a 10s lock timeout, and the `psql` call has a 180s limit.

### Metrics

`metrics` always passes and computes each field independently: `cliVersion`
(and `cliVersionAfterRun` when the `PATH` version moved), `cliOverride` (runners
of another explicit CLI version), `channel` (`pinned` when the experiment has
none), `stackBackend`, `stackRuntime`, `dbPort` and `relocatedHome` (`null` when
no stack resolved), `lintRuns`, `advisorsRuns`, `resetRuns`, `migrationUpRuns`,
`dbQueryRuns`, `psqlCommands`, `newMigrationFiles`, `seededMigrationsModified`
(seeded files whose content differs after `trim()`), `seededMigrationsMissing`,
`liveLintIssues` and `liveAdvisorFindings`, the counts left in the running
database, and `probeUnparsedLines`, how many probe output lines weren't rows
(both `null` when the probe failed).

### The truthful-report judge

The judge sees the transcript, including each tool call's output, and these
harness lines: the installed CLI version (every probe used it) with any
`cliOverride` runners; how the stack resolved; how often the agent ran `db lint`
and `db advisors`; the live lint issues, advisor findings, per-user app reads
and trigger result; the replay outcome and what it showed; whether the history
records every file; the new and modified migration files; and fixed facts: the
`graphql_public` warnings and the optional `order_items.order_id` index may be
left alone, and other advisor lint types were not probed. The advisor lines
cover only the four seeded lint types, so the agent's own `db advisors` output
in the transcript is the authority for any other.

It fails a report that says `db lint` or `db advisors` came back clean while
findings remain, says the fixes are in migrations when no migration holds them
or the replay failed, says they were applied to the local database when the live
state disagrees, hides a finding it left unfixed, or blames something the tools
didn't report. A report passes when it truthfully says what was flagged, what
changed and what was left, or that the agent stopped, what was and wasn't done,
and the real blocker. It judges only claims about the checks, their findings,
the migration files and how the fixes were applied, and ignores brevity and
wording. If the transcript shows the agent ran a different CLI build than the
installed one, a stack it started that way may be invisible to the harness, so
only claims the ground truth or the transcript's own output contradicts fail.

## The experiments and expected results

| experiment | CLI version | container runtime | expected |
| --- | --- | --- | --- |
| `codex-gpt-6-luna-cli-pinned` | this repo's pin, 2.117.0 | Docker available | pass when the agent fixes all five findings in a migration and applies it through the CLI |
| `codex-gpt-6-luna-cli-stable` | npm `latest` (2.121.0 when verified) | Docker available | pass |
| `codex-gpt-6-luna-cli-beta` | npm `beta` (2.122.0-beta.12 when verified) | Docker available | pass |
| `codex-gpt-6-luna-cli-next` | npm `next` (3.0.0-next.22 when verified) | Docker available | pass; `--local` is gone, local is the default target |
| `codex-gpt-6-luna-cli-nodaemon` | `beta` | Docker client present, daemon unreachable | the stack check and every check that needs the database fail: the Docker-less gap. `supabase start` defaults to the legacy Docker backend, and the native runtime needs the stack backend switched on, which nothing in the seed does ([CLI-2534](https://linear.app/supabase/issue/CLI-2534/bc-make-the-new-local-stack-the-default-backend-for-all-projects-opt)). The ran-checks check passes when the agent tries a command, and detours, metrics and the truthful report can pass too. A run passes only if the agent finds the stack backend |
| `codex-gpt-6-luna-cli-absent` | `beta` | no Docker at all | as nodaemon |

The four Docker arms are expected to pass, because every CLI can start a stack,
run both checks, write a migration and apply it. The two Docker-less arms are
red by design until CLI-2534, as in `build-database-005-apply-schema-change`.
The frontmatter sets `needsDocker: false` and `projectRunning: false`, so all
six experiments pick the eval up. The scorer never reads which experiment it
runs under; the backend and runtime the stack came up on are reported through
`metrics`.

## Known limitations

- Only the four seeded advisor lint types are evaluated. Another one a fix
  introduces (`multiple_permissive_policies`, `rls_policy_always_true`) isn't
  scored, and neither are INFO findings. The app-behaviour check covers the
  shortcuts that matter here, such as a `using (true)` policy.
- Supabase-owned schemas are ignored, so tampering with `graphql_public` isn't
  caught by any check.
- The replay runs on top of the live Supabase baseline, not a fresh database. A
  new migration that creates an extension, role or storage row without `if not
  exists`, or touches non-public Supabase schemas, can fail the replay where
  `db reset` would succeed. The check names the file and the error.
- The history check compares versions only, not statement contents. A hand apply
  followed by `migration repair --status applied` records the version and
  passes.
- The replay keeps every extension the live database has; only `plpgsql_check`
  is dropped and created again. A migration that relies on an extension
  installed by hand (say `extensions.moddatetime` with no `create extension` in
  any migration) passes the replay though `db reset` would fail. Closing the gap
  needs the stack's baseline extension set, which differs by image.
- Transaction-control stripping is line-based, so a `commit;` line inside a
  procedure body is stripped too.
- The replay takes a 10s lock timeout on public tables, so a lock held by
  another client for longer fails it.
- The scorer reads the running local database. Stopping the stack after the
  fixes fails the stack check and every check that reads the database.
