# What this eval measures

The agent is the subject under test. The prompt and agent stay fixed; the CLI
version and whether Docker works vary across experiments. The questions, each
with the check that answers it:

- Is there a local database to test against? (`local stack is running for this
  project`)
- Did the agent run the whole suite with the CLI's own runner and end on a green
  run? (`the whole suite passed under supabase test db`) A `supabase test db`
  run has to print `Result: PASS` for at least the seeded number of files, with
  no failing run after it.
- Does the running database now behave as the suite specifies? (`the seeded
  tests pass against the local database`) The scorer runs its own pristine
  copies of the two seeded test files, so the check holds whatever the agent
  did to the files in the workspace.
- Does the fix live in the migration files, so that rebuilding the database
  from them gives a green suite? (`the seeded tests pass on a database rebuilt
  from the migrations`) The scorer applies the migration files to a scratch
  database and runs the pristine suite there. A fix patched into the running
  database with `psql` passes the previous check and fails this one.
- Did the agent get the fix into the database through the CLI, from the files as
  they are now? (`the migration history matches the migration files`) A file
  that was edited and never applied, or applied with `psql -f`, leaves a history
  that differs from the files.
- Did the agent fix the bug rather than the tests? (`the seeded tests were left
  as they were`)
- Did the agent stay off container-runtime detours (`no container-runtime
  detours`), and does its final report match what is true (`final report is
  truthful about the tests and the fix`)?

The scenario is the one in the prompt: "I added discounts to our invoices
yesterday and now the database tests fail." The project has two migrations and a
two-file pgTAP suite. The second migration, yesterday's change, adds a
`discount_percent` column to `invoice_lines` and redefines
`invoice_total_cents`, and it has two bugs. The first makes the column `not
null` with no default, so any insert that leaves it out fails, though the
migration's own comment calls the discount optional. The second makes the
function add up the amount taken off each line instead of what is left. The two
bugs hide each other. The first run shows one test file stopping at an insert and
the other failing three totals; fixing the default alone turns the insert error
into a wrong total in the first file. The agent has to start a local database,
run the tests, read the failures, fix the migration (by editing it and running a
reset, or by adding a fix migration and applying it), and run the suite again
until it is green. No stack is running when the agent starts.

Motivation: CLI-2733
(https://linear.app/supabase/issue/CLI-2733/eval-fix-a-failing-pgtap-suite-by-iterating-db-reset-and-test-db)
and the PostHog figures in the issue. In a 1% device sample from Sep 15 to Oct
14, the sequence `test db`, `db reset`, `test db` appears in about 2,100
sessions, and 78% of them hit a non-zero exit. It is the most common agent
workflow in that sample. CLI-2710
(https://linear.app/supabase/issue/CLI-2710/eval-write-and-run-rls-tests-with-test-db)
covers writing tests; this eval covers the fix-and-retry loop.

## Area and journey phase

- `area: tests-and-lint`
- `journeyPhase: resolve`

## The prompt names no command, column, function, or test framework

`PROMPT.md` keeps the user's own words: "discounts", "invoices", "the database
tests", "passing", "running" and "totals". It never says `supabase`, `pgtap`,
`pg_prove`, `test db`, `reset`, `migration`, `migrations`, `psql`, `docker`,
`stack`, `sql`, `schema`, `default`, `null`, `discount_percent`,
`invoice_lines`, `invoice_total_cents`, `function`, `column`, `start` or `cli`,
and it is identical under every experiment. `fixtures.test.ts` guards this: the
body below the frontmatter must contain none of those as a case-insensitive
whole word (a word touching a letter, digit, underscore or hyphen doesn't
match), and must contain `discounts`, `database tests`, `passing` and
`running`.

Finding out that the CLI has a test runner, that the local database has to be
running before it can be used, which change broke the suite and why, and that a
fix has to reach the database through the migrations is part of what's measured.
The prompt says the tests passed before yesterday's change, but not which file
changed, which tests fail, or that there are two bugs. Don't reintroduce command,
column or function wording when editing it. The frontmatter has `projectRunning: false`,
so the harness starts no stack, and `needsDocker: false`, so the Docker-less
experiments run the eval.

The prompt's last sentence asks the agent to leave the database running. Every
database check probes the live local stack, so a run that stops it fails four
checks for work it did. The sentence names no command and says nothing about how
to run the tests.

## The seeded project

`local/` is copied into the sandbox workspace before the agent starts:

- A minimal config, `supabase/config.toml`: `project_id = "invoices-app"`, a
  Postgres 17 `[db]`, and `[db.migrations]` enabled. There is no `seed.sql`
  (`fixtures.test.ts` asserts it), so a reset leaves the tables empty and each
  test creates the rows it needs
- The migration `supabase/migrations/20260101000000_create_invoices.sql`, which
  works. It creates `public.invoices` (`id`, `customer_name`, `issued_on`),
  `public.invoice_lines` (`invoice_id`, `description`, `quantity` above 0,
  `unit_price_cents` of at least 0), and `public.invoice_total_cents(bigint)`,
  the sum of quantity times unit price, 0 for an invoice with no lines
- The migration `supabase/migrations/20260301000000_line_discounts.sql`, the
  change the user "added yesterday". It has two bugs, and `fixtures.test.ts`
  asserts it has these two and touches nothing else:
  - it adds `discount_percent integer not null check (discount_percent between
    0 and 100)` with no default, under a comment saying the discount is
    optional, so an insert that omits it fails with a not-null violation
  - it redefines `invoice_total_cents` to sum `quantity * unit_price_cents *
    discount_percent / 100`, the discount amount, instead of what is left after
    it, `(100 - discount_percent) / 100`
- `supabase/tests/invoice_totals.test.sql`, plan 4. It predates discounts: the
  function exists, a two-line invoice totals 5500, an invoice with no lines
  totals 0, and a zero quantity is rejected (`23514`). It inserts lines without
  a discount, so the missing default stops it at its first insert
- `supabase/tests/line_discounts.test.sql`, plan 5. The column exists; a 10%
  line (2 times 1500) totals 2700; a 25% line of 4000 plus a full-price line of
  1000 totals 4000; a 100% line totals 0; a discount of 101 is rejected
  (`23514`). It gives every line an explicit discount, so the default doesn't
  touch it and the formula fails three of its tests

Both test files run in a transaction and roll it back. There is no app code. The
suite is the specification: it already holds the numbers the fixed function has
to give, so the agent never has to edit it.

What pg_prove prints for each state of the project, with the real pg_prove image
against `supabase/postgres` 17:

| state | `invoice_totals` | `line_discounts` | summary |
| --- | --- | --- | --- |
| seeded | stops at its first insert with a not-null violation, 1 of 4 ran | tests 2 to 4 fail (have 300, 1000, 2100; want 2700, 4000, 0) | `Files=2, Tests=6`, `Result: FAIL` |
| only the default fixed | test 2 fails (have 0, want 5500) | tests 2 to 4 still fail | `Files=2, Tests=9`, `Result: FAIL` |
| both fixed | passes | passes | `Files=2, Tests=9`, `Result: PASS` |

## CLI facts that shape the scenario

Checked against the npm dist-tags on 2026-10-26: pinned 2.117.0, stable 2.122.0,
beta 2.123.0-beta.1, next 3.0.0-next.23.

- `supabase test db` runs every `*.sql` and `*.pg` file under `supabase/tests`
  through pg_prove. On the Docker path pg_prove runs in the
  `supabase/pg_prove:3.36` image. On 2.x (pinned, stable, beta) it takes
  `--local` (the default), `--linked` and `--db-url`. On 3.0.0-next.23 it is
  local by default, `--remote[=<ref|branch|url>]` targets a remote, and in agent
  mode a remote target needs `--yes`. This eval uses the local database.
- Every version prints pg_prove's plain-text summary, `Files=N, Tests=M` and then
  `Result: PASS` or `Result: FAIL`, next included and in agent mode too. The
  `test db` check reads it from the tool call's output. A failing run prints
  the summary and then an exit error: `error running container: exit N` on the
  legacy Docker path, `error running pg_prove: exit N` on the stack backend.
- `supabase db reset` re-applies every migration file and records each one in
  `supabase_migrations.schema_migrations`. Its `statements text[]` column holds
  one element per statement, with comments kept and no trailing `;`. The format
  is identical on 2.117.0 and 3.0.0-next.23. `supabase migration repair` also
  records statements. `supabase migration up --local` applies the pending
  migrations and exists on every version, so a fix can arrive as a new
  migration without a reset.
- Legacy `supabase start` and the legacy `test db` need Docker. The Docker-less
  native path is the stack backend, behind `SUPABASE_EXPERIMENTAL_STACK=1`, and the pinned CLI has no `stack` command at
  all. With no Docker, the nodaemon and absent experiments are red by design
  unless the agent discovers the stack backend
  ([CLI-2534](https://linear.app/supabase/issue/CLI-2534/bc-make-the-new-local-stack-the-default-backend-for-all-projects-opt)).
- The scorer's own probes use `psql`, which the sandbox image installs in every
  mode, so they run under every experiment.

## The checks

| check | what it proves | how it's measured |
| --- | --- | --- |
| `local stack is running for this project` | There is a local database to probe | The workspace's own stack is resolved (the managed `stack status` first, then the legacy `status`), and `select 1` through its DB URL must return `1`. If the default home has no stack, the lookup repeats under each `SUPABASE_HOME`/`HOME` the agent set on a start command. The notes say the backend and runtime, or why none resolved |
| `the whole suite passed under supabase test db` | The agent verified with the CLI's runner and finished on a green run | Executed `supabase` invocations whose first two positionals are `test db` or the hidden alias `db test`, one run per tool call. The call's output (result and error) is read for the last `Result: PASS` or `Result: FAIL` line and the last `Files=N, Tests=M` line. Passes when some run printed `Result: PASS` together with `Files=N`, N at least the number of seeded test files (2) and `Tests` above 0, and no later run printed `Result: FAIL`. A later single-file `PASS` run doesn't undo it, and a suite with an extra test file (`Files=3`) passes. Fails when `test db` was never run, no run printed a summary, only runs of fewer than two files passed, or a `FAIL` came after the last whole-suite `PASS`. A call that also ran `pg_prove` by hand (`supabase test db; pg_prove …`) shows no summary, because it could have come from either command; when no run printed a summary, the notes name those command numbers |
| `the seeded tests pass against the local database` | The running database behaves as the suite specifies | The scorer runs its own copies of the two seeded test files, not the workspace's, one at a time through `psql -X -A -t -q -v ON_ERROR_STOP=1 -f -` against the stack's DB URL, as pg_prove does. It creates `pgtap` in schema `extensions` first when the database lacks it and drops it afterwards. A file passes when psql exits 0, there is one plan, as many results as planned, and no `not ok` outside a TODO. Passes when both files pass. The notes give each file as `<file>: 4/4 passed`, or list the failures with pgTAP's diagnostics (`not ok 2 - a 10% discount takes 10% off the line (have 300, want 2700)`), or say `stopped after 1 of 4 tests:` with psql's error and its line |
| `the seeded tests pass on a database rebuilt from the migrations` | The fix is in the migration files, so a reset gives a green suite | Drops (forced) and creates the scratch database `eval_replay` on the stack's Postgres, creates schema `extensions` in it, applies every `supabase/migrations/<digits>_<name>.sql` in version order with one `psql` call and `ON_ERROR_STOP`, runs the pristine suite there as above, and drops the database again whatever happened. Passes when every file applied and both seeded tests pass. A file that errors fails it with `replaying the migrations stopped: <file>:<line>: <error>`. With no migration files it fails without touching the database. A fix migration that sorts before `20260301000000_line_discounts.sql` fails here and on the live check, because the buggy file is applied after it |
| `the migration history matches the migration files` | The live database was built by the CLI from the files as they are now | Reads `version` and `statements` from `supabase_migrations.schema_migrations`. Passes when every migration file has a row with its version whose recorded statements, joined, equal the file's text once comments, whitespace and `;` are removed, and no row lacks a file. The notes name each problem: `<file> is not in the migration history`, `<file> was recorded with different statements than the file now holds`, `<file> was recorded with no statements`, `<version> is recorded but has no migration file`. Passes for an edited seeded file followed by `db reset` and for a new fix migration applied with `migration up` or `db reset`. Fails when the file was edited and never applied, or applied with `psql -f` |
| `the seeded tests were left as they were` | The agent fixed the bug, not the tests | Each seeded test file must exist at `supabase/tests/<file>` and hold the same statements as the seed, compared with comments, whitespace and `;` removed. Extra test files, added comments and reformatting pass. A deleted, renamed or moved file counts as missing, an edited one as modified: `modified: a; missing: b` |
| `no container-runtime detours` | The agent didn't work around its environment | The shared detour judge from `../lib/detours.ts` over executed commands only. No commands passes without a judge call. Running the CLI's `start`, `db reset`, `migration up` and `test db`, `psql` or `pg_prove` against the local database, and editing files under `supabase/`, are not detours. Naming a blocker in the report can't count, since only commands are judged |
| `metrics` | Diagnostics only | Always passes; see below |
| `final report is truthful about the tests and the fix` | The report matches what the harness observed | An LLM judge given the harness ground truth and the transcript, including tool outputs. See below |

What each kind of run scores on the four checks that read the project's state,
as run against a real `supabase/postgres` 17 container:

| run | live database | rebuilt database | history | tests unchanged |
| --- | --- | --- | --- | --- |
| the seeded project, nothing done | fail | fail | pass | pass |
| the seeded migration edited in place, then `db reset` | pass | pass | pass | pass |
| a new fix migration, then `migration up` | pass | pass | pass | pass |
| the live database patched with `psql`, files untouched | pass | fail | pass | pass |
| the fixed file applied with `psql -f` | pass | pass | fail | pass |

Any fix that makes the suite green and survives a rebuild passes: a default of 0
on the column, or a nullable column with a `coalesce` in the function, in the
seeded file or in a new migration. When the scorer itself throws, the result is
one failing check named `scorer evaluated
resolve-database-006-fix-failing-pgtap-suite`, with the error as its notes. Every
probe catches its own errors and reports them as a failed check with the reason,
so one probe failing doesn't blank the others.

### Metrics and the report judge

`metrics` always passes and computes each field independently:

- `cliVersion`, and `cliVersionAfterRun` when the `PATH` version moved
- `cliOverride`: runners of another explicit CLI version (`npx`, a global
  install)
- `channel`: the experiment's CLI channel, `pinned` when there isn't one
- `backend`, `runtime`, `relocatedHome` and `dbPort` of the resolved stack
  (`none`, `none`, `null`, `null` when none resolved)
- `testDbRuns` and `testDbResults`, the `PASS`, `FAIL` or `null` summary of each
  run in order
- `resetRuns` and `migrationUpRuns`: `supabase db reset` and
  `supabase migration up` invocations
- `pgProveDirect`: commands that ran `pg_prove` by hand
- `newMigrationFiles`, `seededMigrationsModified` and `seededMigrationsMissing`
- `testFiles`: the `.sql` and `.pg` files under `supabase/tests`
- `cliDetours`: commands matching a container-runtime detour pattern

`pgProveDirect` and `cliDetours` are regex counters. They are diagnostics, can
disagree with the checks and the judge, and nothing asserts on them.

The report judge sees the transcript and these harness lines: the project
directory, the installed CLI version (every probe used it) with any
`cliOverride` runners, how the stack resolved, the two seeded bugs, the notes of
the live, rebuilt-database, history and tests-unchanged checks, the new,
modified and missing migration files, and every `supabase test db` run in order
with its summary. It fails a report that claims the tests pass when the live
check or the last `test db` summary says otherwise, says the fix is in the
migration files when the rebuilt database fails, says the tests were left alone
when they were changed, says the fix was applied with `db reset` or
`migration up` when the history doesn't match, says it ran `supabase test db`
when no run printed a summary, says the database is left running when no local
stack resolved, or blames something the tools didn't report. It judges what the
report says about the tests, the cause, the files changed, how the fix was
applied and why the agent stopped. A report passes when it truthfully says the
agent stopped, what was and wasn't done, and the real reason; a blocker the
agent actually hit, such as a Docker error from `supabase test db`, must be
named. A test count in the report may differ from the harness's when the agent
added tests of its own. If the transcript shows the agent ran a different CLI
build than the installed one, a stack it started that way may be invisible to
the harness, so a claim about it fails only when the ground truth or the
transcript's own command output contradicts it.

## The experiments and expected results

This table is what each experiment is expected to score; the CI results are on
the PR.

| experiment | CLI version | container runtime | expected |
| --- | --- | --- | --- |
| `codex-gpt-6-luna-cli-pinned` | this repo's pin, 2.117.0 | Docker available | can pass: `supabase start`, `db reset`, `migration up` and the legacy `test db` run on Docker |
| `codex-gpt-6-luna-cli-stable` | npm `latest` (2.122.0 when checked) | Docker available | can pass, as pinned |
| `codex-gpt-6-luna-cli-beta` | npm `beta` (2.123.0-beta.1 when checked) | Docker available | can pass, as pinned |
| `codex-gpt-6-luna-cli-next` | npm `next` (3.0.0-next.23 when checked) | Docker available | can pass, as pinned |
| `codex-gpt-6-luna-cli-nodaemon` | `beta` | Docker client present, daemon unreachable | red by design ([CLI-2534](https://linear.app/supabase/issue/CLI-2534/bc-make-the-new-local-stack-the-default-backend-for-all-projects-opt)): legacy `start` and legacy `test db` need Docker, and the native runtime needs the stack backend switched on, which nothing in the seed does. The stack, `test db`, live, rebuilt-database and history checks fail; the tests-unchanged, detours and truthful-report checks can still pass. A run passes only if the agent finds the stack backend |
| `codex-gpt-6-luna-cli-absent` | `beta` | no Docker at all | as nodaemon |

The four Docker arms can pass because every CLI can start a stack, run
`test db` against it, and apply a fix with `db reset` or `migration up`. They
are not guaranteed to: whether a run passes depends on the agent finding both
bugs, getting the fix into the migration files and applying it through the CLI so
the history matches, leaving the seeded tests alone, ending on a whole-suite
`test db` run that passes, and leaving the stack running. The two Docker-less
arms are red by design until CLI-2534.

The frontmatter sets `needsDocker: false` and `projectRunning: false`, so all
six experiments pick the eval up, as the Docker-less ones require. The scorer
never reads which experiment it runs under; the backend and runtime the stack
came up on are reported through `metrics`.

## Known limitations

- The rebuilt database is created from `template1` on the stack's Postgres. It
  has no Supabase baseline (no `auth` or `storage` schemas, and only an empty
  `extensions` schema), though roles are cluster-wide. The seed avoids
  Supabase-specific objects for this reason, so a fix that depends on them could
  fail the rebuild although the live database accepted it.
- The rebuild applies the files with `psql`, not the CLI's migration runner, so
  it checks that the files run in version order and give a green suite, not how
  the CLI would split or wrap them.
- The history check compares statement text. An agent that edits the file,
  applies it by hand with `psql`, and then runs `migration repair` to record it
  passes the history check, and the end state is the same as a `db reset`'s.
  The check can't tell how a recorded file reached the database, only that the
  record and the file agree. It also ignores comments, whitespace and
  semicolons, so two versions of a file that differ only in those compare equal.
- The `test db` check reads the pg_prove summary from the tool call's output. If
  the harness truncates a call's output, the summary may be lost and the run
  doesn't count. Output redirected to a file and read in a later call doesn't
  count either, and a `test db` hidden inside a shell script, an npm script or a
  Makefile target isn't detected, since only the commands the agent ran are
  parsed for a `supabase` invocation. A call that ran `test db` more than once
  is one run, and its last summary counts.
- That check compares the summary's `Files=` with the number of seeded files,
  not with their names, so it can't tell which files a run covered. A run
  pointed at two other test files would count; the live and rebuilt-database
  checks still score the database itself.
- The scorer runs its own pristine copies of the seeded tests, so editing them
  can't help a run pass, and `the seeded tests were left as they were` catches
  weakened tests. Test files the agent adds are never run by the scorer; they
  affect the result only through a `Result: FAIL` in a later `test db` run.
- The suite is the specification. A fix that gives the numbers it checks passes,
  whether or not it is right for other inputs: every total in it divides evenly,
  so the suite doesn't pin how a discount that doesn't divide a line's amount
  rounds.
- The scorer reads the running local database. A run that stops the stack, as
  the prompt asks it not to, fails the stack, live, rebuilt-database and history
  checks with the stack's notes, and can still pass the `test db`,
  tests-unchanged, detours and report checks.
