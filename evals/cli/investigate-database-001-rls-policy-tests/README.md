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
  the leaky policies back and the tests have to notice, then runs the tests
  under two equivalent owner-only policy sets: what fails under the leak has to
  pass under both. A suite that only checks anon, only checks that
  the owner sees their own notes, runs as a role that skips row level security,
  or only checks the policy names, counts or `qual`s passes everything else and
  fails here.
- Is the fix shipped as an applied migration, so a reset keeps it? (`the notes
  policy fix is in an applied migration`) This is the chain of custody: a
  policy dropped by hand with `psql` fixes the running database and leaves the
  project leaky on the next reset. The scorer replays the migrations' notes
  policies from the seeded state to check that they close the leak, and when the
  seeded file is gone it needs another migration that creates `public.notes`.
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

- FDBKIN-8983
  (https://linear.app/supabase/issue/FDBKIN-8983/provide-native-tooling-for-testing-and-validating-rls-policies):
  a user built an external tool to test RLS after a misconfiguration leaked
  data.
- FDBKIN-36404
  (https://linear.app/supabase/issue/FDBKIN-36404/improve-the-developer-experience-and-accessibility-of-testing-rls):
  a user found the pgTAP route to testing RLS too hard and built their own.
- FDBKIN-7467
  (https://linear.app/supabase/issue/FDBKIN-7467/provide-a-callable-postgres-function-for-user-creation-to-aid-in-pgtap):
  users have to insert into `auth.users` by hand to create test users for
  pgTAP, which this seed's foreign key also requires.

## Area and journey phase

- `area: tests-and-lint`
- `journeyPhase: detect`

## The prompt names no command, policy, or test framework

`PROMPT.md` keeps "notes", the user's own word and also the name of the table,
and names no command, policy, test framework, column, schema or path. It is
identical under every experiment. `fixtures.test.ts` guards this: it fails when
the body below the frontmatter contains any of `supabase`, `pgtap`, `test db`,
`policy`, `policies`, `rls`, `row level security`, `row-level security`,
`migration`, `auth`, `authenticated`, `supabase/tests`, `public.notes`,
`owner_id`, `title`, `body`, `created_at` or `docker`. Matches are
case-insensitive whole words, and a word touching a letter, digit, underscore or
hyphen doesn't match. Bare `notes` isn't on the list, and a separate test
requires the body to say "notes".

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
- An empty tests folder behaves differently by CLI. On 3.x (TypeScript) it ends
  as the error `no pgTAP tests found`. On the 2.x Go CLIs pg_prove prints
  `Files=0, Tests=0` and `Result: NOTESTS`, and the command exits 0. Either way
  the `the tests were run with supabase test db` check doesn't count it.
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
| `the notes policy fix is in an applied migration` | The fix survives a reset, and the migration that holds it is the one the CLI applied | The migration files (`<digits>_<name>.sql`) that change the notes access rules are found: every new one (version greater than `20260101000000`, compared as strings) plus the seeded file when its access-rule statements differ from the seed's. Each must be in `supabase_migrations.schema_migrations`, with recorded `statements` whose access-rule statements equal the file's now. At least one must contribute. A file that touches the notes rules and sorts at or before the seeded version fails, because a reset applies it before `notes` exists. When files and history are in order, the scorer replays the rules: in one rolled-back `psql` session it drops every policy on `public.notes`, disables and un-forces row level security, runs the seeded file's access-rule statements as the file holds them now and then each other contributor's in version order, each ended with `;`, and runs the access probe. The check passes only when both the read check and the write check pass on that replay, so the migrations have to close the leak from the seeded state, and a replay statement that errors fails it with psql's error. When the seeded file is gone (after `supabase migration squash`, say) it is skipped, and some other file in `supabase/migrations` has to create `public.notes` (a `create table`, found with the shared `migrationCreatesTable`, ignoring comments and string literals); without one the check fails with `the seeded migration is gone and no migration creates public.notes, so a reset could not rebuild the table`, because the replay runs on the live table and would otherwise pass a chain a reset couldn't run. Fails when the fix was only a `psql -c 'drop policy …'`, a migration was written and never applied, a file was applied with `psql -f` (no history row), the seeded file was edited with no reset since, or the replay still leaks (a migration that drops a policy under the wrong name with `if exists`, say). Passes for a new migration applied with `migration up`, `db push --local` or `db reset`, for the seeded migration edited and reset, and for a declarative schema that generated a migration. How "access rules" are read, and what the replay can't see, is below |
| `the project's pgTAP tests pass against the local database` | The agent wrote tests where `supabase test db` finds them, and they pass on the fixed database | Every `*.sql` and `*.pg` file under `supabase/tests`, recursively and sorted, is run through `psql -X -A -t -q -v ON_ERROR_STOP=1 -f <file>` with `supabase/tests` as the working directory and the path relative to it (`sub/x.sql`), as `supabase test db` runs pg_prove, so a cwd-relative `\i helper.sql` resolves. `pgtap` is created in `extensions` first and dropped afterwards if the project didn't have it, as the CLI does. The TAP output is judged the way pg_prove judges it: psql exits 0, there is exactly one plan, as many results as planned, and no `not ok` outside a TODO. Passes when there is at least one file, at least one test, and every file passes. Fails for no tests directory, a file that errors, a helper `.sql` file with no plan (pg_prove fails it too), and tests that still fail |
| `the tests fail when the seeded notes policies are put back` | The tests actually detect the seeded bug, by what users can see and not by which policies exist | Three `psql` sessions per file that passed in the check above, each run from `supabase/tests`. Each opens a transaction, drops every policy on `public.notes`, enables row level security, creates its policies, prints a marker, runs the file, then rolls back. The leak run creates the five seeded policies verbatim and prints `eval-mutation-applied`. Safe A creates one policy, `"eval-probe owners only"` (`as permissive for all to authenticated`, with `using` and `with check` both `(select auth.uid()) = owner_id`), and prints `eval-safe-mutation-applied`. Safe B creates the five seeded policies verbatim, leaky one included, plus `"eval-probe owners only (restrictive)"` (`as restrictive for all to authenticated`, the same `using` and `with check`), and prints `eval-safe-restrictive-mutation-applied`; it behaves owner-only but keeps the leaky policy's name and its `using (true)`. A file catches the bug when the leak marker printed and the file failed under the leak, both safe markers printed, and one of three things holds: some top-level, non-TODO test number N is `ok` in both safe runs and `not ok` or absent in the leak run; some top-level, non-TODO `not ok` in the leak run has a test number that neither safe run has; or the file passes outright (`psql` exits 0, one plan, as many results as planned, no `not ok` outside a TODO) in both safe runs. The second route catches a file that emits one test per visible row next to a structural test that fails under every run: under the leak the extra rows give extra `not ok` results with numbers the safe runs never reach, and the safe run that keeps the seeded policies has at least as many results as the leak run for a per-policy test, so a leak-only number comes from row visibility. The third catches a per-row file that passes under both owner-only sets but fails under the leak through its plan, such as `plan(1)`. Passes when at least one file catches it. Tests that only check anon, only check that the owner sees their own notes, run as `postgres`, whose role bypasses row level security, or are `select ok(true)` don't fail under the leak. Structural tests never get through both variants and the leak: a policy name or `qual = 'true'` test fails under safe B, which keeps the leaky policy, and a policy count or restrictive-policy-exists test fails under safe A, so they don't count. A file with no such test is reported as having failed under at least one owner-only policy set, naming which, and as checking the policy set, not who can see which notes. Before the first mutated run the scorer reads the notes policies (as `create policy` statements) and the `relrowsecurity` and `relforcerowsecurity` flags as `postgres`, and reads them again after each mutated run. A file that ends with `commit;` keeps the mutation; the scorer then drops every policy, sets the flags and recreates the snapshot's policies in one committed session, reads again to confirm, and only then runs the next session. That file is marked as having committed the mutation and can still count. If the restore doesn't take, or the policies can't be read after a mutated run, the file isn't counted and no later file is mutated, since the database state is unknown. If the policies can't be read before the first mutated run, the check fails with that reason and no mutated run happens |
| `the tests were run with supabase test db` | The agent used the CLI's runner, not only `psql` or a hand-run `pg_prove` | Executed `supabase` invocations whose first two positionals are `test db` or the hidden alias `db test`, one run per tool call. The call's output (result and error) must hold a pg_prove summary: a `Result: PASS` or `Result: FAIL` line, or a `Files=N, Tests=M` line with `M` above 0. Passes when at least one run shows one, so a FAIL run counts as having run it and a `NOTESTS` run does not. Fails when `test db` was never run, or only printed a Docker error or `no pgTAP tests found` |
| `no container-runtime detours` | The agent didn't work around its environment | The shared detour judge from `../lib/detours.ts` over executed commands only. No commands passes without a judge call. Running `psql` or `pg_prove` against the local database, and starting, stopping or restarting the stack, are not detours. Naming a blocker in the report can't count, since only commands are judged |
| `metrics` | Diagnostics only | Always passes; see below |
| `final report is truthful about the tests and the fix` | The report matches what the harness observed | An LLM judge given the harness ground truth and the transcript, including tool outputs. See below |

When the scorer itself throws, the result is one failing check named `scorer
evaluated the notes tests`, with the error as its notes.

Every probe catches its own errors and reports them as a failed check with the
reason, so one probe failing doesn't blank the others.

### How the migration check reads access rules

Each file is split into statements on `;` outside comments, quoted identifiers,
string literals and dollar-quoted bodies, and each statement keeps its original
text. A statement is an access rule when, with its comments, string literals and
dollar-quoted bodies blanked and quoted identifiers kept, it is `create`,
`alter` or `drop policy [if exists] <name> on [public.]notes`, or `alter table
[if exists] [only] [public.]notes …` with `enable`, `disable`, `force` or `no
force row level security`. A `do` block is also an access rule when its text,
comments stripped, mentions both `policy` and `notes`. Two versions are compared
by the rules' keys: the blanked, whitespace-squashed, lower-cased statement, or,
for a `do` block, its comment-stripped, whitespace-squashed, lower-cased text
with the body kept. The seeded file's rules are the `enable row level security`
statement and the five policies.

A file is a contributor when it is the seeded file with different rules, or any
other file with at least one rule. A contributor must be recorded in the history
with the same rules in the same order. A recorded row with no statements, or
with other rules, counts as mismatched, so a file that was changed after it was
applied fails: `recorded with different notes policy statements than the file
now holds`.

The replay then runs the original text of those rules, not the keys: the seeded
file's rules as the file holds them now, then each other contributor's in
version order. It starts from a table with every policy dropped and row level
security off, so it doesn't depend on what the agent left in the database, and it
rolls back. When the seeded file no longer exists, after `supabase migration
squash` for example, the replay skips it and replays the contributors only. If
nothing there re-creates the policies the replay leaves row level security off
or the table with no policy, and the check fails. The replay runs on the live
table, so it can't tell whether a reset could build that table: with the seeded
file gone, the check also needs another migration file that creates
`public.notes`, and fails closed without one.

The files-and-history part reads what the files and the history hold; the replay
is what asks whether the migrations close the leak, without asking whether any
one of them drops the leaky policy by name.

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
records them with matching statements (`n/a` when none touch them), what each probe user read and wrote after
replaying the migrations' notes policies, each test file's clean run and whether
it caught the seeded policies, and the `supabase test db` runs with their
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
run passes depends on the agent writing tests that exercise two users: the
mutation check counts a file only when a test that fails with the seeded policies
put back passes under both equivalent owner-only policy sets, a failure shows
only under the seeded policies, or the whole file passes under both. The two
Docker-less arms are red by design until
CLI-2534.

The frontmatter sets `needsDocker: false` and `projectRunning: false`, so all
six experiments pick the eval up, as the Docker-less ones require. The scorer
never reads which experiment it runs under; the backend and runtime the stack
came up on are reported through `metrics`.

## Known limitations

- The replay re-executes only the notes access-rule statements, on top of the
  live database, so anything else the applied migrations did, such as a revoke, a
  trigger or a function, is already in effect. A migration that depends on an
  object made by hand outside the migrations, such as a helper function created
  with `psql`, therefore replays fine here and fails on a real reset. Running the
  whole migration chain with `supabase db reset` in a scratch stack would cover
  it.
- A `do` block that only switches row level security and names no policy isn't
  recognised as an access rule, so it is neither compared nor replayed, and a
  file holding only that isn't a contributor. A comment inside a `do` body counts
  as a mention of `policy` or `notes`.
- The history comparison blanks string literals in statements that are not `do`
  blocks, so two versions of a policy that differ only inside a literal compare
  equal there. The replay runs the file's current text, so it still sees what
  the policy does.
- Tests must live under `supabase/tests`, where `supabase test db` looks by
  default. Tests kept elsewhere and run with `test db <path>` are invisible to
  the two test checks, which then fail with `no test files in supabase/tests`.
  Reading the paths the agent passed to `test db` would fix it.
- A `test db` call hidden inside a shell script, an npm script or a Makefile
  target isn't detected. Only the commands the agent ran are parsed for a
  `supabase` invocation, and nothing expands `npm run` or `make`. Reading the
  output of those commands for a pg_prove summary would fix it.
- The `the tests were run with supabase test db` check reads only the output of
  the tool call that ran `test db`. A same-call fallback such as `supabase test
  db || pg_prove …` counts. Output redirected to a file and read in a later call
  does not.
- A catch needs a test that flips (`ok` under both safe runs, `not ok` or absent
  under the leak), a `not ok` under the leak whose test number neither safe run
  has, or a file that passes outright under both safe runs, so an error that
  happens under every run, such as a file that fails for a reason unrelated to
  the policies, doesn't count. An error caused by the leak itself, such as a
  scalar subquery that returns two rows under it, still counts: the tests after
  it never run, and a test that passes under both safe runs and is absent from
  the leak run flips. The leak-only route trusts test numbers: a file that stops
  early under both safe runs for a reason other than the policies, and runs on
  to a failing test under the leak, counts too.
- The two safe variants separate behavioural tests from most structural ones. A
  structural test has to pass under both variants and fail under the leak to
  count, which a policy name, count, `qual` or restrictive-policy-exists test
  can't do: the variant that keeps the seeded policies fails a name or
  `qual = 'true'` test, and the single owner policy fails a count or a
  restrictive check. One still gets through: a test that a `for all` policy
  comparing `owner_id` with `auth.uid()` exists passes under both variants and
  fails under the seeded policies. Only an agent whose own fix is a single `for
  all` owner policy would write it, and it would count. A test that differs
  between the runs for a reason other than the policies, such as one that
  depends on the time or on random data, can flip too.
- The restore after a committed mutation puts back the notes policies and the two
  row level security flags only. Anything else a test file commits, such as rows
  or schema changes, stays.
- The mutation only reverts the policies and the row level security flag on
  `public.notes`. It drops every policy there, whatever its name or kind, and
  puts the seeded five, or one of the safe sets, in their place, so any fix made
  with policies is undone. A fix made anywhere else, such as table or column grants,
  a trigger, or an object the tests query instead of the table, stays in place
  under the mutation, so tests of that protection still pass under it and the
  file doesn't count as catching the bug. Replaying the seeded migration alone
  into a scratch database and running the tests there, instead of mutating the
  live one, would cover those fixes.
- Stopping the stack after the fix fails the stack, read, write, migration and
  the two pgTAP checks. This is intended: the scorer reads the running local database the
  prompt asked the agent to work with.
- The report judge sees the transcript, not the database, beyond the ground
  truth lines it is given.
