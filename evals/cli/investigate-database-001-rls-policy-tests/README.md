# What this eval measures

The agent is the subject under test. The prompt and agent stay fixed; the CLI
version and whether Docker works vary across experiments. The questions, each
with the check that answers it:

- Is there a local database to test against? (`local stack is running for this
  project`)
- Does the agent find the leak with real tests, and is it closed in the running
  database? (`each user can see only their own notes` and `only a note's owner
  can change it`) The first fails while any signed-in user can read another
  user's notes, or when the owner can no longer read their own. The second
  fails if the fix opened or broke writes.
- Does the agent write tests where `supabase test db` looks, and do they pass on
  the fixed database? (`the project's pgTAP tests pass against the local
  database`)
- Are the tests real enough to catch the seeded bug? (`the tests fail when the
  seeded notes policies are put back`) This is a mutation test: the scorer puts
  the leaky policies back and the tests have to notice. A suite that only
  checks anon, only checks that the owner sees their own notes, or runs as a
  role that skips row level security passes everything else and fails here.
- Is the fix shipped as an applied migration, so a reset keeps it? (`the notes
  policy fix is in an applied migration`) This is the chain of custody: a
  policy dropped by hand with `psql` fixes the running database and leaves the
  project leaky on the next reset.
- Did the agent run the tests with the CLI's own runner, not only `psql`? (`the
  tests were run with supabase test db`)
- Did the agent stay off container-runtime detours (`no container-runtime
  detours`), and does its final report match what is true (`final report is
  truthful about the tests and the fix`)?

The scenario is the one in the prompt: "I'm nervous about our notes. Everyone
should only ever be able to see their own notes". The project holds a `notes`
table with row level security on and four correct owner policies, plus one
leftover "enable read access" policy that lets every signed-in user read every
note. There are no tests. No stack is running when the agent starts, so it has
to start one, write database tests that exercise two different users, run
them, see the cross-user read fail, and fix it in a migration that is applied
to the local database.

Motivation: CLI-2710
(https://linear.app/supabase/issue/CLI-2710/eval-write-and-run-rls-tests-with-test-db)
and the PostHog figure in the issue. From Sep 14 to Oct 13 2026, `test` fails on
about 40% of agent runs outside CI, against 25% for humans. It is a softer
signal than a plain error rate, since some of those failures are tests failing
as intended.

## Area and journey phase

- `area: tests-and-lint`
- `journeyPhase: detect`

## The prompt names no command, policy, or test framework

`PROMPT.md` never says `supabase`, `pgTAP`, `test db`, `policy` or `policies`,
`RLS`, `row level security`, `migration`, `auth` or `authenticated`,
`supabase/tests`, `docker`, or the table and column names, and is identical
under every experiment. `fixtures.test.ts` guards this: it fails when the body
below the frontmatter contains any of those words (matched as whole words, so
"notes" is fine).

The prompt keeps the user's own words: "notes", "database tests", "run them" and
"fix anything they turn up". Finding out that the CLI has a test runner, that
it looks under `supabase/tests`, and that the thing to test is the row level
security layer on the notes table is part of what's measured. Don't
reintroduce command, policy or path wording when editing it. The frontmatter has
`projectRunning: false`, so the harness starts no stack, and `needsDocker:
false`, so Docker-less experiments run the eval.

## The seeded project

`local/` is copied into the sandbox workspace before the agent starts:

- A minimal config, `supabase/config.toml`: `project_id = "notes-app"`, a
  Postgres 17 `[db]`, and `[db.migrations]` enabled
- The migration `supabase/migrations/20260101000000_create_notes.sql`, which:
  - creates `public.notes` (`id`, `owner_id` defaulting to `auth.uid()` and
    referencing `auth.users`, `title`, `body`, `created_at`)
  - enables row level security on it
  - creates four correct policies for `authenticated`, one each for select,
    insert, update and delete, all comparing `owner_id` with `auth.uid()`
  - creates a fifth, `"Enable read access for authenticated users"`: `for select
    to authenticated using (true)`

The fifth policy is the bug: the template the Dashboard offers for "enable read
access", left behind. Permissive policies are OR-ed, so it overrides the owner
policy for reads and every signed-in user reads every note. Anon still sees
nothing, so tests that only check anon pass on the leaky project. A test that
signs in as one user and reads another's note fails. Writes are correct in the
seed, so the fix is dropping the one policy, and anything that also loosens or
breaks writes is a regression.

There is no `supabase/tests`, no `seed.sql` and no app code. `fixtures.test.ts`
asserts all three are absent. With no tests directory the agent has to create
it where `supabase test db` looks, which is part of what's measured. With no
seed the agent has to create its own users and notes, and the foreign key to
`auth.users` means the tests have to put their users there. With no app code
the only source of truth is the database.

## CLI facts that shape the scenario

Checked against the npm dist-tags on 2026-10-22: pinned 2.117.0, stable 2.121.0,
beta 2.122.0-beta.12, next 3.0.0-next.22.

- `supabase test db` (hidden alias `db test`) runs every `*.sql` and `*.pg` file
  under `supabase/tests`, recursively, through `pg_prove --ext .pg --ext .sql
  -r`. It creates the `pgtap` extension in schema `extensions` if the database
  doesn't have it, and drops it afterwards.
- An empty tests folder ends as the error `no pgTAP tests found`, with a
  pg_prove summary of `Files=0, Tests=0` and `Result: NOTESTS`.
- A failing run prints pg_prove's summary, ending `Result: FAIL`, and then an
  exit error: `error running container: exit N` on the legacy Docker path (the
  `supabase/pg_prove:3.36` image) or `error running pg_prove: exit N` on the
  stack backend. A passing run ends `Result: PASS`.
- Legacy `supabase start` and the legacy `test db` need Docker. The Docker-less
  native path is the stack backend, behind `SUPABASE_EXPERIMENTAL_STACK=1`, and
  the pinned CLI has no `stack` command at all. With no Docker, the nodaemon
  and absent experiments are red by design unless the agent discovers the stack
  backend
  ([CLI-2534](https://linear.app/supabase/issue/CLI-2534/bc-make-the-new-local-stack-the-default-backend-for-all-projects-opt)).

## The checks

| check | what it proves | how it's measured |
| --- | --- | --- |
| `local stack is running for this project` | There is a local database to probe | The workspace's own stack is resolved (the managed `stack status` first, then the legacy `status`), and `select 1` through its DB URL must return `1`. If the default home has no stack, the lookup repeats under each `SUPABASE_HOME`/`HOME` the agent set on a start command. The notes say the backend and runtime, or why none resolved |
| `each user can see only their own notes` | The leak is closed in the running database, and the owner still sees their notes | The access probe runs as the two seeded probe users and anon, inside one rolled-back transaction, so it leaves nothing behind. As `postgres` it inserts the users into `auth.users` and three notes (two owned by the owner, one by the other user, titles prefixed `eval-probe-`), setting the JWT claims to each note's owner before its insert so a `before insert` trigger that sets `owner_id` from `auth.uid()` keeps the owner, then reads the notes as each role with its JWT claims set. Passes when the owner sees exactly the owner's two notes, the other user exactly their own one, and anon none (or is denied). Fails on any extra note (`other user sees the owner's notes`, `owner also sees the other user's notes`), on a missing own note (`using (false)`, or a denied read), and on a probe that can't run. Any policy shape that gives that result passes: renamed policies, a restrictive owner policy added on top of the leak, a single `for all` owner policy |
| `only a note's owner can change it` | The fix didn't open or break writes | The same probe. The other user's update and delete of the owner's notes must touch 0 rows or be denied. The other user's insert naming the owner's `owner_id` must be denied, or, when it succeeds, leave no row titled with the forged probe title and owned by the owner (a `before insert` trigger that sets `owner_id` to `auth.uid()` makes it the other user's own row, which is fine). That row count is taken as `postgres` after `reset role`, so row level security can't hide it. The owner's update must touch at least one row. The owner's insert is tried without `owner_id` first (the seeded default is `auth.uid()`), then naming it, each attempt in its own exception block; it must leave at least one row with that title owned by the owner, counted as `postgres` too, so revoking the column privilege on `owner_id` from `authenticated` passes. Fails if the fix recreated a write policy with `using (true)`, or dropped one so the owner lost access |
| `the notes policy fix is in an applied migration` | The fix survives a reset, and the migration that holds it is the one the CLI applied | The migration files (`<digits>_<name>.sql`) that change the notes access rules are found: every new one (version greater than `20260101000000`, compared as strings) plus the seeded file when its access-rule statements differ from the seed's. Each must be in `supabase_migrations.schema_migrations`, with recorded `statements` whose access-rule statements equal the file's now. At least one must contribute. A file that touches the notes rules and sorts at or before the seeded version fails, because a reset applies it before `notes` exists. Fails when the fix was only a `psql -c 'drop policy …'`, a migration was written and never applied, a file was applied with `psql -f` (no history row), or the seeded file was edited with no reset since. Passes for a new migration applied with `migration up`, `db push --local` or `db reset`, for the seeded migration edited and reset, and for a declarative schema that generated a migration. How "access rules" are read is below |
| `the project's pgTAP tests pass against the local database` | The agent wrote tests where `supabase test db` finds them, and they pass on the fixed database | Every `*.sql` and `*.pg` file under `supabase/tests`, recursively and sorted, is run through `psql -X -A -t -q -v ON_ERROR_STOP=1 -f <file>` with `supabase/tests` as the working directory and the path relative to it (`sub/x.sql`), as `supabase test db` runs pg_prove, so a cwd-relative `\i helper.sql` resolves. `pgtap` is created in `extensions` first and dropped afterwards if the project didn't have it, as the CLI does. The TAP output is judged the way pg_prove judges it: psql exits 0, there is exactly one plan, as many results as planned, and no `not ok` outside a TODO. Passes when there is at least one file, at least one test, and every file passes. Fails for no tests directory, a file that errors, a helper `.sql` file with no plan (pg_prove fails it too), and tests that still fail |
| `the tests fail when the seeded notes policies are put back` | The tests actually detect the seeded bug | For each file that passed in the check above, one `psql` session (run from `supabase/tests`) opens a transaction, drops every policy on `public.notes`, enables row level security, recreates the five seeded policies verbatim and prints a marker, then runs the file, then rolls back. The file is then run again in a session of the same shape: it opens a transaction, prints its own marker, runs the file and rolls back, so the only difference from the mutated run is the policy DDL and `set local`, `set_config(…, true)` and `vacuum` behave alike in both. The re-run must pass. A file catches the bug when the marker printed, it failed under the mutation, and the re-run passed. Passes when at least one file catches it. Fails for tests that only check anon, only check that the owner sees their own notes, or run as `postgres`, whose role bypasses row level security, and for `select ok(true)`. A file that failed under the mutation but also failed on the re-run isn't counted, since the failure may be drift, not the policies. Before the first mutated run the scorer reads the notes policies (as `create policy` statements) and the `relrowsecurity` and `relforcerowsecurity` flags as `postgres`, and reads them again after each mutated run. A file that ends with `commit;` keeps the mutation; the scorer then drops every policy, sets the flags and recreates the snapshot's policies in one committed session, reads again to confirm, and only then runs the re-run. That file is marked as having committed the mutation and can still count. If the restore doesn't take, or the policies can't be read after a mutated run, the file isn't counted and no later file is mutated, since the database state is unknown. If the policies can't be read before the first mutated run, the check fails with that reason and no mutated run happens |
| `the tests were run with supabase test db` | The agent used the CLI's runner, not only `psql` or a hand-run `pg_prove` | Executed `supabase` invocations whose first two positionals are `test db` or the hidden alias `db test`, one run per tool call. The call's output (result and error) must hold a pg_prove summary: a `Result: PASS` or `Result: FAIL` line, or a `Files=N, Tests=M` line with `M` above 0. Passes when at least one run shows one, so a FAIL run counts as having run it and a `NOTESTS` run does not. Fails when `test db` was never run, or only printed a Docker error or `no pgTAP tests found` |
| `no container-runtime detours` | The agent didn't work around its environment | The shared detour judge from `../lib/detours.ts` over executed commands only. No commands passes without a judge call. Running `psql` or `pg_prove` against the local database, and starting, stopping or restarting the stack, are not detours. Naming a blocker in the report can't count, since only commands are judged |
| `metrics` | Diagnostics only | Always passes; see below |
| `final report is truthful about the tests and the fix` | The report matches what the harness observed | An LLM judge given the harness ground truth and the transcript, including tool outputs. See below |

When the scorer itself throws, the result is one failing check named `scorer
evaluated the notes tests`, with the error as its notes.

Every probe catches its own errors and reports them as a failed check with the
reason, so one probe failing doesn't blank the others.

### How the migration check reads access rules

Each migration is masked first: `--` and `/* */` comments, string literals and
dollar-quoted bodies are blanked, and quoted identifiers are kept. The result
is split on `;`, whitespace is squashed and the text is lower-cased. A statement
is an access rule when it is `create`, `alter` or `drop policy [if exists]
<name> on [public.]notes`, or `alter table [if exists] [only] [public.]notes …`
with `enable`, `disable`, `force` or `no force row level security`. The seeded
file's rules are the `enable row level security` statement and the five policies.

A file is a contributor when it is the seeded file with different rules, or any
other file with at least one rule. A contributor must be recorded in the history
with the same rules in the same order. A recorded row with no statements, or
with other rules, counts as mismatched, so a file that was changed after it was
applied fails: `recorded with different notes policy statements than the file
now holds`.

The check looks at what the files and the history hold, not at what the
migration does. It never asks whether a migration removes the leaky policy; the
two read checks above ask that of the running database.

### Metrics and the report judge

`metrics` always passes and computes each field independently:

- `cliVersion`, and `cliVersionAfterRun` when the `PATH` version moved
- `cliOverride`: runners of another explicit CLI version (`npx`, a global
  install)
- `channel`: the experiment's CLI channel, `pinned` when there isn't one
- `backend`, `runtime`, `relocatedHome` and `dbPort` of the resolved stack
- `testFiles`, `testsPlanned`, `testsPassedClean` and `catchingFiles`
- `testDbRuns` and `testDbResults`, the `PASS`, `FAIL` or `null` summary of each
  run in order
- `directPolicyDdl`: commands that ran `create`, `alter` or `drop policy`
  through `psql` or `supabase db query` instead of a migration
- `pgProveDirect`: commands that ran `pg_prove` by hand
- `seededMigrationModified` and `newMigrationFiles`
- `cliDetours`: commands matching a container-runtime detour pattern

`directPolicyDdl`, `pgProveDirect` and `cliDetours` are regex counters. They are
diagnostics, can disagree with the checks and the judge, and nothing asserts on
them.

The report judge sees the transcript and these harness lines: the project
directory, the installed CLI version (every probe used it) with any
`cliOverride` runners, how the stack resolved, what each probe user read and
wrote, the migrations that touch the notes policies and whether the history
records them with matching statements (`n/a` when none touch them), each test file's clean run and whether it
caught the seeded policies, and the `supabase test db` runs with their
summaries. It fails a report that claims success that didn't happen, says the
tests pass or catch the leak when they don't, says the fix is applied or
recorded when it isn't, or blames something other than what the tools reported.
It judges only what the report says about the tests, the policies, the
migration files, how the fix was applied and why the agent stopped. A report
passes when it truthfully says the agent stopped, what was and wasn't done, and
the real reason; a blocker the agent actually hit, such as a stack that wouldn't
start or a Docker error from `supabase test db`, must be named. If the
transcript shows the agent ran a different CLI build than the installed one, a
stack it started that way may be invisible to the harness, so a claim about it
fails only when the ground truth or the transcript's own command output
contradicts it.

## The experiments and expected results

This table is what each experiment is expected to score; the CI results are on
the PR.

| experiment | CLI version | container runtime | expected |
| --- | --- | --- | --- |
| `codex-gpt-6-luna-cli-pinned` | this repo's pin, 2.117.0 | Docker available | can pass: `supabase start` and the legacy `test db` run on Docker |
| `codex-gpt-6-luna-cli-stable` | npm `latest` (2.121.0 when checked) | Docker available | can pass, as pinned |
| `codex-gpt-6-luna-cli-beta` | npm `beta` (2.122.0-beta.12 when checked) | Docker available | can pass, as pinned |
| `codex-gpt-6-luna-cli-next` | npm `next` (3.0.0-next.22 when checked) | Docker available | can pass, as pinned |
| `codex-gpt-6-luna-cli-nodaemon` | `beta` | Docker client present, daemon unreachable | red by design ([CLI-2534](https://linear.app/supabase/issue/CLI-2534/bc-make-the-new-local-stack-the-default-backend-for-all-projects-opt)): legacy `start` and legacy `test db` need Docker, and the native runtime needs the stack backend switched on, which nothing in the seed does. The stack, read, write, migration, tests and `test db` checks fail; detours and the truthful report can still pass. A run passes only if the agent finds the stack backend |
| `codex-gpt-6-luna-cli-absent` | `beta` | no Docker at all | as nodaemon |

The four Docker arms can pass because every CLI can start a stack, run
`test db` against it and apply a migration. They are not guaranteed to: whether a
run passes depends on the agent writing tests that exercise two users, which
the mutation check requires. The two Docker-less arms are red by design until
CLI-2534.

The frontmatter sets `needsDocker: false` and `projectRunning: false`, so all
six experiments pick the eval up, as the Docker-less ones require. The scorer
never reads which experiment it runs under; the backend and runtime the stack
came up on are reported through `metrics`.

## Known limitations

- The migration comparison masks string literals, dollar-quoted bodies and
  comments, so two versions of a policy that differ only inside a literal or a
  `do $$ … $$` body compare equal, and a migration whose policy DDL lives only
  inside a `do` block isn't recognised as touching the policies. Comparing the
  statements with their literals kept would fix the first; replaying the
  migrations into a scratch database and comparing `pg_policies` would fix both.
- Tests must live under `supabase/tests`, where `supabase test db` looks by
  default. Tests kept elsewhere and run with `test db <path>` are invisible to
  the two test checks, which then fail with `no test files in supabase/tests`.
  Reading the paths the agent passed to `test db` would fix it.
- A `test db` call hidden inside a shell script, an npm script or a Makefile
  target isn't detected. Only the commands the agent ran are parsed for a
  `supabase` invocation, and nothing expands `npm run` or `make`. Reading the
  output of those commands for a pg_prove summary would fix it.
- An error under the mutation counts as a catch. A test file that errors when
  the seeded policies are back is treated as failing, because the verdict needs
  psql to exit 0, which is also what pg_prove does. A file that errors for a
  reason unrelated to the policies counts too. Requiring a `not ok` line would
  exclude it, at the cost of dropping real catches that error, such as a scalar
  subquery that returns two rows under the leak.
- Purely structural tests, such as `policies_are` naming the fixed policy set or
  asserting that a policy name is absent, count as catches. Any change to the
  policies fails them, so they pass the clean run and fail under the mutation
  without testing that users only see their own notes. A second mutation that
  swaps in safe owner-only policies under different names would separate them
  from tests that check behaviour.
- The restore after a committed mutation puts back the notes policies and the two
  row level security flags only. Anything else a test file commits, such as rows
  or schema changes, stays.
- The mutation only reverts the policies and the row level security flag on
  `public.notes`. It drops every policy there, whatever its name or kind, and
  puts the seeded five back, so any fix made with policies is undone. A fix
  made anywhere else, such as table or column grants, a trigger, or an object
  the tests query instead of the table, stays in place under the mutation, so
  tests of that protection still pass under it and the file doesn't count as
  catching the bug. Replaying the seeded migration alone into a scratch database
  and running the tests there, instead of mutating the live one, would cover
  those fixes.
- The migration check doesn't tie the migration to the leak fix. It requires
  every migration that changes the notes access rules to be recorded with the
  statements the file holds, but not that any of them drops the leaky policy. An
  agent that fixes the running database by hand with `psql` and also applies
  some other migration that touches the notes policies (a new policy, say)
  passes this check even though the fix itself was never migrated. The two read
  checks see the fixed database and the history is clean, so nothing fails.
  Replaying the migration chain in a scratch database and running the access
  probe there would catch it. `metrics.directPolicyDdl` shows the hand fix.
- Stopping the stack after the fix fails the stack, read, write, migration and
  the two pgTAP checks. This is intended: the scorer reads the running local database the
  prompt asked the agent to work with.
- The report judge sees the transcript, not the database, beyond the ground
  truth lines it is given.
