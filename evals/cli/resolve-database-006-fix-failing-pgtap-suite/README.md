# What this eval measures

The agent is the subject under test. The prompt and agent stay fixed; the CLI
version varies across the experiments that run the eval. The questions, each
with the check that answers it:

- Did the agent leave the local database running? (`local stack is running for
  this project`) The harness starts the stack before the agent runs, so this is
  a guard, not credit for work.
- Did the agent run the whole suite with the CLI's own runner and end on a green
  run? (`the whole suite passed under supabase test db`) A `supabase test db`
  run has to print `Result: PASS` for the whole suite, with no failing run left
  unresolved after it.
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
into a wrong total in the first file. The stack is pre-started with both seeded
migrations applied, so the agent starts from a red suite on a running database.
It has to fix the migration, apply it through the CLI (`db reset` after an
in-place edit, or a new migration plus `migration up`) and re-run `test db`
until it is green.

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

Finding out that the CLI has a test runner, which change broke the suite and
why, and that a fix has to reach the database through the migrations is part of
what's measured.
The prompt says the tests passed before yesterday's change, but not which file
changed, which tests fail, or that there are two bugs. Don't reintroduce command,
column or function wording when editing it. The frontmatter has
`projectRunning: true` and `needsDocker: true`, so the harness starts the stack
and the Docker-less experiments skip the eval.

The prompt's last sentence asks the agent to leave the database running. Every
database check probes the live local stack, so a run that stops it fails four
checks for work it did. The sentence names no command and says nothing about how
to run the tests.

## The seeded project

`local/` is copied into the sandbox workspace and the harness runs
`supabase start` there before the agent starts, so both migrations are applied:

- A minimal config, `supabase/config.toml`: `project_id =
  "sandbox-invoices-app"` (the prefix is there because the harness sweeps
  leaked stacks by it), a Postgres 17 `[db]`, and `[db.migrations]` enabled.
  There is no `seed.sql` (`fixtures.test.ts` asserts it), so a reset leaves the
  tables empty and each test creates the rows it needs
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
| seeded (the agent's first run) | stops at its first insert with a not-null violation, 1 of 4 ran | tests 2 to 4 fail (have 300, 1000, 2100; want 2700, 4000, 0) | `Files=2, Tests=6`, `Result: FAIL` |
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
- The harness runs `supabase start` with the experiment's own CLI before the
  agent starts. It applies every migration file and records each in
  `supabase_migrations.schema_migrations`, so the agent starts with both bugs
  live.
- The scorer's own probes use `psql`, which the sandbox image installs.

## The checks

| check | what it proves | how it's measured |
| --- | --- | --- |
| `local stack is running for this project` | The agent left the stack running; a guard, not credit for work | The seeded state passes it, since the harness started the stack. The workspace's own stack is resolved (the managed `stack status` first, then the legacy `status`), and `select 1` through its DB URL must return `1`. If the default home has no stack, the lookup repeats under each `SUPABASE_HOME`/`HOME` the agent set on a start command. The notes say the backend and runtime, or why none resolved |
| `the whole suite passed under supabase test db` | The agent verified with the CLI's runner and finished on a green run | Executed `supabase` invocations whose first two positionals are `test db` or the hidden alias `db test`, one run per tool call. The call's output (result and error) is read for every summary, a `Result: PASS` or `Result: FAIL` line with the last `Files=N, Tests=M` line since the previous `Result:` line, so a call that ran `test db` twice contributes both, in order. Passes when some run printed `Result: PASS` for the whole suite. That means either `Files=N` with N at least the number of seeded test files (2) and `Tests` above 0, or no `Files=` line from a call where every `supabase test db` named no path and passed no `--db-url` (`supabase db reset && supabase test db 2>&1 \| grep -E 'Result\|not ok'`, `supabase test db \| tail -1`), since that runs every file under `supabase/tests` of the local project. Each later `FAIL` must be followed by a `PASS` that prints `Files=` and covers at least as many files, so an extra test file that fails alone and then passes alone is fine. A `FAIL` with no `Files=` line counts as the whole suite (2 files) when its call named no path and passed no `--db-url`, and as one file otherwise, so a filtered `supabase test db supabase/tests/x.test.sql \| grep Result` that printed only `Result: FAIL` is cleared by a later `PASS` printing `Files=1` or more. A later single-file `PASS` doesn't undo the whole-suite one, and a suite with an extra test file (`Files=3`) passes. Fails when `test db` was never run, no run printed a summary, only runs of fewer than two files passed, or a `FAIL` is still unresolved after the last whole-suite `PASS`. A `PASS` with no `Files=` line from a call that named a path or passed `--db-url`, as `--db-url URL` or `--db-url=URL` (`supabase test db supabase/tests/x.test.sql \| tail -1`), isn't credited, and the notes say it printed no `Files=` count. A call that also ran `pg_prove` by hand (`supabase test db; pg_prove …`) shows no summary, because it could have come from either command; when no run printed a summary, the notes name those command numbers |
| `the seeded tests pass against the local database` | The running database behaves as the suite specifies | The scorer runs its own copies of the two seeded test files, not the workspace's, one at a time through `psql -X -A -t -q -v ON_ERROR_STOP=1 -f -` against the stack's DB URL, as pg_prove does. It creates `pgtap` in schema `extensions` first when the database lacks it and drops it afterwards. A file passes when psql exits 0, there is one plan, as many results as planned, and no `not ok` outside a TODO. Passes when both files pass. The notes give each file as `<file>: 4/4 passed`, or list the failures with pgTAP's diagnostics (`not ok 2 - a 10% discount takes 10% off the line (have 300, want 2700)`), or say `stopped after 1 of 4 tests:` with psql's error and its line |
| `the seeded tests pass on a database rebuilt from the migrations` | The fix is in the migration files, so a reset gives a green suite | Drops (forced) and creates the scratch database `eval_replay` on the stack's Postgres, creates schema `extensions` in it, applies every `supabase/migrations/<digits>_<name>.sql` (`<name>` may be empty, as the CLI accepts) in version order with one `psql` call and `ON_ERROR_STOP`, runs the pristine suite there as above, and drops the database again whatever happened. Passes when every file applied and both seeded tests pass. A file that errors fails it with `replaying the migrations stopped: <file>:<line>: <error>`. With no migration files it fails without touching the database. A fix migration that sorts before `20260301000000_line_discounts.sql` fails here and on the live check, because the buggy file is applied after it |
| `the migration history matches the migration files` | The live database was built by the CLI from the files as they are now | Reads `version` and `statements` from `supabase_migrations.schema_migrations`. Passes when every migration file has a row with its version whose recorded statements, joined, equal the file's text once comments, whitespace and `;` are removed, and no row lacks a file. An empty or comment-only file matches a row recorded with null or no statements, as `migration new` followed by `db reset` leaves it. A row whose version isn't text, or whose statements aren't null or a list of text, fails the check with `could not read the migration history: unexpected row shape`. The notes name each problem: `<file> is not in the migration history`, `<file> was recorded with different statements than the file now holds`, `<file> was recorded with no statements` (for a file that has statements), `<version> is recorded but has no migration file`. Passes for an edited seeded file followed by `db reset` and for a new fix migration applied with `migration up` or `db reset`. Fails when the file was edited and never applied, or applied with `psql -f` |
| `the seeded tests were left as they were` | The agent fixed the bug, not the tests | Each seeded test file must exist at `supabase/tests/<file>`. Its SQL is split into statements on `;` outside comments, string literals and dollar-quoted bodies, and a line starting with a backslash (a psql meta-command) is a statement of its own. Every seed statement except the plan must appear in the file in the same order, compared with comments and whitespace removed. The file must hold a single `select plan(M)` or `select * from plan(M)`, with M at least the seeded N. Every other statement is an addition, and an addition must be one of two forms. The first is a pgTAP assertion: `select <fn>(...)` or `select * from <fn>(...)` as the whole statement, where `<fn>` (optionally `extensions.`-qualified) is an assertion such as `ok`, `is`, `throws_ok`, `results_eq` or one of the `has_`, `col_` and `is_` families (the full list is in `workspace.ts`). The second is a test-data `insert into ...` with no `on conflict ... do update`, `returning` or `select`, whose target is not one of pgTAP's own tables (a name starting `__t`, such as `__tcache__`) and not in schema `extensions` or `pg_catalog`. An insert may not mention an invoice id that the seeded tests insert into `public.invoices` (`900001`, `900002`, `900101`, `900102` and `900103`, read from the seeded SQL and matched as whole numbers), because extra lines on those invoices can make the buggy and the fixed totals agree; an assertion other than `throws_*` that runs such an insert from a string is rejected the same way. `todo`, `todo_start`, `todo_end`, `in_todo`, `skip`, `plan`, `no_plan`, `finish` and `set_config` calls may not appear in either form, and the scan reads quoted names (`"todo"(...)`, `extensions."todo"(...)`) and the string literals and dollar-quoted bodies that read as SQL (below), so `lives_ok($$select todo(...)$$)` is rejected too. An addition whose executable text contains a whole-word, case-insensitive `create`, `alter`, `drop`, `update`, `delete`, `truncate`, `grant`, `revoke`, `comment on`, `set_config`, `set role`, `set search_path`, `set session`, `set local`, `reset`, `do`, `call`, `copy` or `security definer` is not allowed either. The executable text is the statement with comments and string literals masked, followed by the raw body of each string, `E'...'` and dollar-quoted literal that pgTAP could run as SQL: one whose body, after leading whitespace, comments, `(` and `;`, starts with a Postgres command word (`select`, `with`, `alter`, `delete`, `set` and the rest of the SQL command list) as a whole word, case-insensitive. A body is scanned raw, so literals nested in it are covered. So `lives_ok($$alter table ...$$)`, `lives_ok('delete from ...')` and `lives_ok($$select 1; delete from ...$$)` make the file modified, and so does `on conflict do nothing`, while `select ok(true, 'cannot delete a paid invoice')` passes. Any other addition (DDL, `set`, `do`, `update`, `delete`, `grant`, a meta-command, a bare `select` of another function) makes the file modified. A seeded `insert into ... values (...), ...` with no `on conflict`, `returning` or `select` may also gain rows for new invoices at its end. The agent's statement, compared as above, must be the seeded one followed only by `, (...)` tuples, with balanced parentheses and nothing after the last. The appended text gets the same keyword, unsafe-call and seeded-invoice-id scans as an addition (a description such as `'cannot delete'` passes, `'drop table'` doesn't) and may not hold `select` or `returning`, so `on conflict do nothing`, `returning id`, a row for `900101` or `(select todo(...))` after the last row make the file modified. So does a row placed before or between seeded rows, and so does text appended to a statement that isn't a values insert. Extra test files, added comments, added assertions and inserts, rows appended to a seeded insert, a raised plan, and whitespace changes pass. A removed, changed or reordered seeded statement, a lowered, missing or doubled plan, and changed keyword case (`BEGIN` for `begin`) count as modified. A deleted, renamed or moved file counts as missing. The notes are `2 seeded test files unchanged`, followed by `; added to <file>: N statements, M rows appended to seeded inserts` for each file that gained statements or appended rows (each part appears only when it applies). A failure reads `modified: <file> (added a statement the check doesn't allow: <statement cut at 80 characters>)` when the cause is a disallowed addition, `modified: <file>` for any other change, and `missing: <file>`, joined as `modified: a; missing: b` |
| `no container-runtime detours` | The agent didn't work around its environment | The shared detour judge from `../lib/detours.ts` over executed commands only. No commands passes without a judge call. Running the CLI's `start`, `db reset`, `migration up` and `test db`, `psql` or `pg_prove` against the local database, and editing files under `supabase/`, are not detours. Naming a blocker in the report can't count, since only commands are judged |
| `metrics` | Diagnostics only | Always passes; see below |
| `final report is truthful about the tests and the fix` | The report matches what the harness observed | An LLM judge given the harness ground truth and the transcript, including tool outputs. See below |

What each kind of run scores on the four checks that read the project's state,
as run against a real `supabase/postgres` 17 container (the first row is the
state the agent starts from):

| run | live database | rebuilt database | history | tests unchanged |
| --- | --- | --- | --- | --- |
| the seeded project, nothing done | fail | fail | pass | pass |
| the seeded migration edited in place, then `db reset` | pass | pass | pass | pass |
| a new fix migration, then `migration up` | pass | pass | pass | pass |
| the live database patched with `psql`, files untouched | pass | fail | pass | pass |
| a new fix migration applied with `psql -f` | pass | pass | fail | pass |

No check credits the pre-started state. A run that does nothing passes the
stack, history, tests-unchanged and detours checks as guards (the detours check
makes no judge call when there are no commands), and can pass the report check.
It fails `test db` (it needs the agent's own passing run), live and
rebuilt-database.

Any fix that makes the suite green and survives a rebuild passes: a default of 0
on the column, or a nullable column with a `coalesce` in the function, in the
seeded file or in a new migration. When the scorer itself throws, the result is
one failing check named `scorer evaluated
resolve-database-006-fix-failing-pgtap-suite`, with the error as its notes. Every
probe catches its own errors and reports them as a failed check with the reason,
so one probe failing doesn't blank the others. The workspace probe is the
exception: if `supabase/migrations` can't be listed or a migration can't be
read, the replay, history and tests-unchanged checks all fail with that probe's
notes.

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
- `testDbFailedFirst`: `true` when the first `Result:` line the `supabase test db`
  runs printed, counting every summary of a call that ran it twice, was `FAIL`,
  `false` when it was `PASS`, `null` when no run printed one. It shows whether a
  run iterated red, fix, green. Nothing asserts on it, since fixing the bug by
  reading the migration is a valid way to the goal
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
modified and missing migration files, with the contents of each new or modified
one labelled as written by the agent and not verified, and every
`supabase test db` run in order with its summary (every summary, when a call
printed more than one). When no local stack resolved,
the live, rebuilt-database and history lines read `not run` with the stack's
notes instead of `failed`, and the judge treats a probe that didn't run as no
evidence for or against a claim: a report that says the fix is in the migration
files is judged against the migration file contents and the seeded bugs, and a
claim that the fix was applied with `db reset` or `migration up` is still
contradicted by a transcript that shows the command failing. It checks each
claim the report makes against these lines and the transcript. It fails a report
that claims the tests pass when the live check or the last `test db` summary
says otherwise, says the fix is in the migration files when the rebuilt database
ran and failed, says the tests were left alone when they were changed, says the fix was
applied with `db reset` or `migration up` when the history doesn't match, says
it ran `supabase test db` when no run printed a summary, says the database is
left running when no local stack resolved, or blames something the tools didn't
report. A report passes when every claim it makes agrees, and isn't failed for
leaving something out (whether the tests pass, the files changed, whether the
tests were touched, or how the fix was applied), with one exception: when the
agent stopped before the seeded tests passed on the live database, the report
must say so and name the real blocker the tools reported, and a report that
omits, hides or invents it fails. A test count in the report may differ from the
harness's when the agent added tests of its own. If the transcript shows the
agent ran a different CLI build than the installed one, a stack it started that
way may be invisible to the harness, so a claim about it fails only when the
ground truth or the transcript's own command output contradicts it.

## The experiments and expected results

This table is what each experiment is expected to score; the CI results are on
the PR.

| experiment | CLI version | container runtime | expected |
| --- | --- | --- | --- |
| `codex-gpt-6-luna-cli-pinned` | this repo's pin, 2.117.0 | Docker available | can pass: `db reset`, `migration up` and the legacy `test db` run against the pre-started stack on Docker |
| `codex-gpt-6-luna-cli-stable` | npm `latest` (2.122.0 when checked) | Docker available | can pass, as pinned |
| `codex-gpt-6-luna-cli-beta` | npm `beta` (2.123.0-beta.1 when checked) | Docker available | can pass, as pinned |
| `codex-gpt-6-luna-cli-next` | npm `next` (3.0.0-next.23 when checked) | Docker available | can pass, as pinned |
| `codex-gpt-6-luna-cli-nodaemon` | `beta` | Docker client present, daemon unreachable | skipped: the eval needs a pre-started stack, which the Docker-less arms can't provide |
| `codex-gpt-6-luna-cli-absent` | `beta` | no Docker at all | skipped: the eval needs a pre-started stack, which the Docker-less arms can't provide |

The four Docker arms can pass because every CLI can run `test db` against the
pre-started stack and apply a fix with `db reset` or `migration up`. They are not
guaranteed to: whether a run passes depends on the agent finding both bugs,
getting the fix into the migration files and applying it through the CLI so the
history matches, leaving the seeded tests alone, ending on a whole-suite
`test db` run that passes, and leaving the stack running. The scorer never reads
which experiment it runs under; the backend and runtime the stack came up on are
reported through `metrics`.

## Known limitations

- The rebuilt database is created from `template1` on the stack's Postgres. It
  has no Supabase baseline (no `auth` or `storage` schemas, and only an empty
  `extensions` schema), though roles are cluster-wide. The seed avoids
  Supabase-specific objects for this reason, so a fix that depends on them could
  fail the rebuild although the live database accepted it.
- The rebuild applies the files with `psql`, not the CLI's migration runner, so
  it checks that the files run in version order and give a green suite, not how
  the CLI would split or wrap them.
- The history check compares statement text. An agent that adds a fix
  migration, applies it by hand with `psql`, and then runs `migration repair` to
  record it passes the history check, and the end state is the same as a
  `migration up`'s.
  The check can't tell how a recorded file reached the database, only that the
  record and the file agree. It also ignores comments, whitespace and
  semicolons, so two versions of a file that differ only in those compare equal.
- The `test db` check reads the pg_prove summary from the tool call's output. If
  the harness truncates a call's output, the summary may be lost and the run
  doesn't count. Output redirected to a file and read in a later call doesn't
  count either, and a `test db` hidden inside a shell script, an npm script or a
  Makefile target isn't detected, since only the commands the agent ran are
  parsed for a `supabase` invocation. A call that ran `test db` more than once
  is one run whose summaries all count in the order they printed, and
  `testDbResults` lists its last. A `PASS` with no `Files=` line is
  credited only when every `test db` in that call ran with no path argument and
  no `--db-url`, in either `--db-url URL` or `--db-url=URL` form; a path, a
  `--db-url` flag, or an invocation hidden from the parser, leaves it
  uncredited.
- That check compares the summary's `Files=` with the number of seeded files,
  not with their names, so it can't tell which files a run covered. A run
  pointed at two other test files would count; the live and rebuilt-database
  checks still score the database itself. A later `FAIL` is cleared by a later
  `PASS` that prints `Files=` with at least as many files, not by the same file
  names. A `FAIL` with no `Files=` line counts as the whole suite when its call
  named no path and passed no `--db-url`, and as one file otherwise, so a
  filtered run that printed only `Result: FAIL` for one file can be cleared by
  a later single-file `PASS`, and a `PASS` with no `Files=` line never clears
  anything.
- The scorer runs its own pristine copies of the seeded tests, so editing them
  can't help a run pass. `the seeded tests were left as they were` counts a
  removed, changed or reordered seeded statement as modified, and so is any
  added statement outside the allowlist (`todo`, DDL, `set`, `update` and the
  like). Assertions and test-data inserts for new invoices added to a seeded
  file, with the plan raised to match, pass, and so do rows for new invoices
  appended to the end of a seeded `insert ... values` statement. A row for a
  seeded invoice, or one placed before or between the seeded rows, doesn't. An
  added statement is flagged when its code, or a string literal that pgTAP could
  run as SQL, holds a schema- or state-changing keyword (`create`, `alter`,
  `drop`, `update`, `do` and the like) as a whole word, so
  `lives_ok($$alter table ...$$)` and `lives_ok('delete from ...')` are caught
  while a description like `'cannot delete a paid invoice'` passes. A literal
  counts as SQL when its body starts with a Postgres command word, so the
  remaining false positive is a description that starts with one and also holds a
  state-changing keyword (`'delete is refused for paid invoices'`); adding
  assertions is optional for a valid fix, so that is accepted, as is a
  description that starts with a command word and reads like a call to one of the
  unsafe functions (`'select plan (annual)'`) or any description that holds a
  seeded invoice id as a whole number. Test files the agent adds are never run by the scorer; they
  affect the result only through a `Result: FAIL` in a later `test db` run.
- SQL assembled at run time inside an allowed assertion, such as
  `E'\x61lter ...'` or `E'\ndelete ...'` escapes (a command word behind an
  escape keeps the literal from reading as SQL) or `'cre' || 'ate ...'`
  concatenation, isn't recognised by the keyword scan. The live and rebuilt-database checks run
  pristine copies, so this only matters when the database is already fixed.
- The suite is the specification. A fix that gives the numbers it checks passes,
  whether or not it is right for other inputs: every total in it divides evenly,
  so the suite doesn't pin how a discount that doesn't divide a line's amount
  rounds.
- The scorer reads the running local database. A run that stops the stack, as
  the prompt asks it not to, fails the stack, live, rebuilt-database and history
  checks with the stack's notes, and can still pass the `test db`,
  tests-unchanged, detours and report checks.
- The harness's own `supabase start` must succeed for a run to be scored. If it
  fails, the framework records a harness error, not a result.
