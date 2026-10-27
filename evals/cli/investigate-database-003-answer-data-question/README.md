# What this eval measures

The agent is the subject under test. The prompt and agent stay fixed; the CLI
version varies across the experiments that run the eval. The questions, each
with the check that answers it:

- Does an agent asked to use the Supabase CLI for a data question run
  `supabase db query`, and does that command get it the number? (`a supabase db
  query run returned the answer`) The number has to come out of a `db query`
  run's own output, or a later call that processes a file the run saved,
  directly or by simple arithmetic on figures they printed. Another command in
  the same call that can print the number sends the verdict to the judge.
- Does it stay on the CLI rather than psql, a Postgres driver, an HTTP API or
  `docker exec`? (`no psql, client-library or API fallback`)
- Is the number right? (`the reply gives the right count`)
- Did it leave the user's database and stack as it found them? (`the seeded
  customers and orders are unchanged`, `local stack is running for this
  project`) The harness starts the stack before the agent runs, so both are
  guards, not credit for work.
- Is the report honest about the number and the method? (`final report is
  truthful about the count and how it was found`)
- Did the agent stay off container-runtime detours? (`no container-runtime
  detours`)

The scenario is the one in the prompt: "How many of our customers have never
placed an order?" The user wants the exact number for a win-back email and
asks the agent to check the local database with the Supabase CLI. The project
has 1,200 customers and 1,800 orders, and the stack is pre-started with that
data live. The CLI's tool for this is `supabase db query`, which runs SQL
against the local database. The agent has to find the two tables, write a
query that finds customers with no order, and report the number.

Motivation: CLI-2735
(https://linear.app/supabase/issue/CLI-2735/eval-answer-a-data-question-with-db-query-against-the-local-database)
and the PostHog figures in the issue. In a 1% device sample from Sep 15 to Oct
14, `db query` is in about 30% of agent sessions, and in 23% of all agent
sessions it is the only command run. It is the most used agent command. No other
CLI eval scores it on its own: `build-database-005`, `resolve-database-005` and
`investigate-database-001` accept it as one route among several, and
`deploy-database-006` uses it against a hosted project.

## Area and journey phase

- `area: schema-and-migrations`
- `journeyPhase: observe`

## The prompt names no command, flag, SQL, column, port, or URL

`PROMPT.md` never says `db query`, `psql`, `status`, a flag, a port or URL, SQL,
Docker, a stack, or a CLI version, and is identical under every experiment.
`fixtures.test.ts` greps the body for `query`, `queries`, `sql`, `psql`,
`select`, `join`, `count`, `table`, `rls`, `db`, `docker`, `stack`, `rest`,
`api`, `studio`, `dashboard`, `migration` and `start` as whole words. The words
it keeps are the user's own: "customers", "placed an order", "exact number",
"local database" and "Supabase CLI". "customers" and "an order" happen to match
the `customers` and `orders` tables, but which table holds the orders, that it
links to customers by `customer_id`, and how to say "has no row there" in SQL is
for the agent to find.

"Supabase CLI" is in the prompt because the journey is the CLI's data path.
Without it, psql is an equally valid way to answer, and the answer-source and
fallback checks would measure taste, not the CLI (`investigate-database-001`
says "use the Supabase CLI" for the same reason). Don't reintroduce command
wording when editing it. The frontmatter has no `services:` key (the sandbox
shim turns it into `supabase start -x <containers>`, which the managed stack
rejects). `projectRunning: true` and `needsDocker: true` mean the harness
starts the stack before the agent runs, so the agent starts from a live
database instead of spending the run on `supabase start`.

## The seeded project

`local/` is copied into the sandbox workspace and the harness runs
`supabase start` there before the agent starts, so the migration and the seed
are applied and the data is live:

- A minimal config, `supabase/config.toml`: `project_id = "sandbox-shop-crm"`
  (the `sandbox-` prefix is what the harness sweeps leaked stacks by), a
  Postgres 17 `[db]`, `[db.migrations]` enabled, and `[db.seed]` enabled with
  `sql_paths = ["./seed.sql"]`. It pins no ports. `fixtures.test.ts` parses it
  and asserts it holds nothing else
- The migration `supabase/migrations/20260101000000_create_customers_and_orders.sql`,
  the only migration. It creates `public.customers` (`id` uuid, a unique
  `email`, `full_name`, `created_at`) and `public.orders` (`id` uuid,
  `customer_id` uuid referencing `customers`, `total_cents` above 0,
  `created_at`), an index on `orders.customer_id`, and enables row level
  security on both tables with no policies. The ids are uuids so that no
  integer id can be mistaken for the answer. RLS is on because agent-mode
  `db query` prints an advisory in its output when a public table has RLS off,
  and with it on the output holds only the rows
- `supabase/seed.sql`, two inserts. 1,200 customers have digit-free names (12
  first names and 10 last names, cycled) and emails such as
  `ada.okafor263@example.com`, where the customer's number is glued to the name.
  1,800 orders pick their customer by an md5 of the order number, so the
  answer can't be read off the file

The seeded facts: 1,200 customers, 1,800 orders totalling 17,713,300 cents, 937
customers with at least one order and so **263 who never ordered**, the answer.
`fixtures.test.ts` recomputes all of them from the seed formulas with
`node:crypto`, rebuilds both row checksums from the seed model, and asserts none
of the three project files states 263 or 937.
The answer is the same whichever way the agent writes the query: `NOT EXISTS`,
`LEFT JOIN ... IS NULL`, `NOT IN` (no order has a null `customer_id`) and
`count(customers) - count(distinct customer_id)` all give 263. The naive
`count(customers) - count(orders)` gives -600.

The names, emails and uuids are shaped so that no row prints 263 as a value. A
whole-number 263 in a listing would let a run that only listed customers pass
the answer-source check. With `Customer 263`, `customer-263@example.com` or an
integer id, a plain `select * from customers` would print one. Here the 263 in
`ada.okafor263@example.com` is glued to a name, so the value-token match the
check uses ignores it. `fixtures.test.ts` recomputes every customer row (id,
email, name, creation time), asserts the match finds nothing in any of them, and
asserts it would find `Customer 263`, so the guard can fail. The orders hold
only uuids, an integer total of at least 500 and timestamps, none of which can
form a 263 value token.

## CLI facts that shape the scenario

Checked against the npm dist-tags on 2026-10-27, with `npx supabase@<version> db
query --help` and the CLI source: pinned 2.117.0, stable 2.122.0, beta
2.123.0-beta.3, next 3.0.0-next.25.

- `supabase db query [flags] [<sql>]` runs SQL against a database and exists on
  every version. The SQL comes from the positional argument, from `--file`/`-f`,
  or from stdin. On 2.x (pinned, stable, beta) the flags are `--db-url`,
  `--linked`, `--local`, `--project-ref` and `--file`/`-f`. On 3.0.0-next.25
  they are `--remote[=<ref|branch|url>]`, `--file`/`-f` and `--read-only`;
  `--local` is still accepted there, with a warning that it isn't needed and
  will be removed in v4. The local database is the default target on every
  version, so a plain `supabase db query "<sql>"` works without a flag.
- A table is printed for humans. In agent mode (the CLI detects AI tools from
  the environment, or takes `--agent yes`) the output is JSON,
  `{advisory?, boundary, rows, warning}`, where `boundary` is a random string
  that marks the rows as untrusted data. `-o json|table|csv` overrides either.
  `--output-format` is a different, global flag that takes only `text`, `json`
  or `stream-json`, so `--output-format table` errors. The `advisory` appears
  only when a public table has RLS off.
- psql (`postgresql-client`) is installed in the sandbox image, `supabase
  status` prints the database URL, and the `docker` CLI is present, so psql, a
  driver script and `docker exec` are real options the agent can take instead of
  the CLI. The Supabase MCP server in this eval is docs-only, since there is no
  hosted project, so it can't run SQL.
- No CLI gap is known for this journey: the command exists on every arm.
- The scorer's own probes (the stack check, the data check) use psql.

## The checks

| check | what it proves | how it's measured |
| --- | --- | --- |
| `local stack is running for this project` | The agent left the user's stack running; a guard, not credit for work | The workspace's own stack is resolved (the managed `stack status` first, then the legacy `status`), retrying under each `SUPABASE_HOME`/`HOME` the agent started a stack with, and `select 1` through its DB URL must return `1`. The seeded state passes it, since the harness started the stack. The notes say the backend and runtime, or why none resolved |
| `the seeded customers and orders are unchanged` | The agent answered without changing the data | One psql call on the stack's database prints the customer count, the order count, and an md5 over the rows of each table, separated by pipes. The customer rows are `(id, email, full_name, created_at)` ordered by `id`. The order rows are `(customer_id, total_cents, created_at)` ordered by `created_at, customer_id, total_cents`, without the order `id`, since the seed makes it with `gen_random_uuid()` and it differs on every seed. Timestamps go in as epoch seconds, so the `TimeZone` setting can't change the text, and an empty table hashes the empty string. The counts must equal the seeded 1200 and 1800 and the checksums the seeded ones (`3c6f39b6c129b02f75c591f4d9241008` and `990777a6ca755d87935959997d3d1165`). A count that differs is named with its seeded value in the notes (`customers 1199 (seeded 1200)`); a checksum that differs is named as `customer rows differ from the seed` or `order rows differ from the seed`, so an edited name or an order moved to another customer fails with the counts unchanged. A psql error (a dropped table, no stack) or output that isn't two integers and two 32-digit hex strings fails the check with the reason, never passes it. A view or temp table the agent creates, or a `supabase db reset` that re-seeds the same data, passes |
| `a supabase db query run returned the answer` | The number came out of `supabase db query`, not another tool | Executed `supabase` invocations whose first two positionals are `db query`, ignoring a call that asked for `--help` or `-h`, one run per tool call (a call that ran it twice is one run) with its result and error text, terminal escapes stripped. No run fails the check with `no supabase db query ran`. A run whose output holds 263 as a value token passes it, naming the tool call, only when nothing else in the call can have printed the 263. The command text must not hold 263 as a value token (`echo 263`, `printf %d 263`, `awk 'BEGIN{print 263}'` and `select 263` all fail it), and every pipeline in the call (stages joined by `\|`, the call split at `;`, `&&`, `\|\|`, `&` and newlines) must have no database client stage and either a source stage or an inert first stage. A run's source is its `db query` segment, or a segment that names a file the run saved (`db query … > out.json && jq .rows[0] out.json`). An inert stage is `cd`, `export`, `set`, `unset`, `true`, `false` or `sleep`; an `echo` or `printf` whose text has no digit, `$` or backtick; or a `supabase` help or version request (`--help`, `-h`, `--version`, or `help` as the first argument, also through `npx` or `bunx`). So `supabase --version && db query …`, `cd /workspace && db query …`, `export X=1; db query … \| jq .rows` and `db query … \| tee out.json` pass, while `db query "select 1" && echo 263`, `… && cat answer.txt`, `… && echo $((1200-937))` and `… && psql …` go to the judge. A command that doesn't parse goes to the judge too. A run that fails the rule isn't a pass: the gate moves to the next run, then the reads, and leaves the verdict to the judge when none qualifies. A run that exits non-zero after printing keeps its stdout in the error text, so `db query "<count>" && false` passes the same way. A later tool call that is not itself a `db query` run is a read when its command names a file a run wrote, as written, by basename (the agent may `cd` first) or, for a relative path, behind a directory prefix (`/workspace/never.json`, `$PWD/never.json`, `supabase/never.json`), matched as a whole path token (`out` doesn't match `output.json` or `layout`). Two different absolute paths never match. The files a run wrote are the targets of the shell's own `>`, `>>`, `&>` and `N>` operators (not a `>` inside quotes, SQL or a heredoc body) and the arguments of `tee [-a]`, taken only from the `db query` command's own segment or a later stage of the same pipeline (`db query … \| tee out.json`, `… \| jq .rows > out.json`), stopping at a stage led by a database client (`psql`, `pgcli`, `usql`, `pg_dump`), whose output and that of every stage after it isn't `db query`'s. Backslash-newline continuations, LF or CRLF, are joined before any of this. A redirect in another command joined by `;`, `&&`, `\|\|`, `&` or a newline, `/dev/null` and an fd duplication such as `2>&1` never count. `bash -lc` and `sh -c` wrappers and `npx supabase` are seen through; a command that doesn't parse saves nothing, which leaves the verdict to the judge. A call is credited to the latest run before it that wrote the file, and a call that came before the run isn't a read. A read whose output holds 263 as a value token passes the check, naming the tool call, the path and the run that saved it, under the same rule with a segment that names the saved file as its source (`jq '.rows[0]' /tmp/never.json`, `cd /tmp && jq . never.json`; `jq . /tmp/never.json && echo 263` and `jq . /tmp/never.json; cat other.txt` go to the judge). Otherwise the judge gets every run, then every read, in full (tool call number, command, output, and for a read its path and the run that saved it) and passes only output that gives 263 directly or by simple arithmetic on numbers the runs and reads printed, such as a customer total minus a count of customers with orders. Every number the arithmetic uses must appear in that output; a number from the seed file, the agent's own messages or another tool doesn't count. A number printed by a read that processes a saved file (`jq`, `awk`, `wc`, a short script) counts the same as the run's own output. A number printed by another command in the same tool call (`echo`, `printf`, shell arithmetic, a file the agent wrote earlier), or typed into the SQL as a literal, doesn't count. A number from psql doesn't count even when a `db query` ran a trivial statement. `-f`, stdin, `--db-url` to the local database, `-o table`, a `\| jq` filter and `npx supabase` all count as runs |
| `no psql, client-library or API fallback` | The agent stayed on the CLI | An LLM judge over every executed command, numbered and untruncated, never the report. It fails psql, `pg_dump`, `pgcli` or `usql` at the database (including through `docker exec` into the database container), a node, deno, bun, python or ruby script that uses a Postgres driver or supabase-js, `curl`, `wget` or `fetch` against the REST, GraphQL, Studio or pg-meta endpoints, and installing such a client (`npm add pg`, `pip install psycopg`, `apt-get install postgresql-client`). An attempt counts even when it fails. `which psql`, `command -v psql`, `psql --version`, readiness or connectivity probes that read no rows (`pg_isready`, `nc -z` on the database port, a `curl` to a health or status endpoint or the API root), any `supabase` command, reading project files, and processing saved `db query` output with `jq` or `awk` do not fail. A request that selects, counts or returns table rows (`curl …/rest/v1/customers?select=*`) still does. With no commands the check passes without a judge call |
| `the reply gives the right count` | The user got the right number | The reply is every non-empty assistant message after the last tool call, joined with a blank line, so a sign-off in a separate message after the answer still counts. A run with no tool call counts every non-empty assistant message. It must contain 263 as a whole number. An answer that came only before the last tool call doesn't count, whether or not a later message follows, and a run that ends on a tool call has no reply. "1,263", "263,000", "2,630", "263.5" and "1263" don't match; "263 customers", "263.", "**263**", "(263)" and "a 263-customer list" do. The notes quote what the reply said, or say there was no reply |
| `no container-runtime detours` | The agent didn't work around its environment | The shared detour judge from `../lib/detours.ts` over executed commands only. No commands passes without a judge call. Running the Supabase CLI, psql or other clients at the local database, and reading project files, are not detours. Naming a blocker in the report can't count, since only commands are judged |
| `metrics` | Diagnostics only | Always passes; see below |
| `final report is truthful about the count and how it was found` | The report's number and its account of the method match what happened | An LLM judge given the harness ground truth and the transcript, including tool outputs. See below |

`the reply gives the right count` and the `answerInReply` metric use the same
matcher. The value-token match the answer-source check applies to `db query`
output is a different one: 263 not glued to a word character, `.` or `-` on the
left, and not followed by a word character, `-` or a decimal part. It finds
`"count":263`, `"count":"263"`, a table cell `│ 263 │`, a bare `263` from `jq`,
a CSV row `1200,937,263` and `[263,937]`. It ignores `ada.okafor263@example.com`,
`customer-263@`, `Customer263`, uuid fragments such as `…a263f…` and `…-4263-…`,
`1263`, `2630`, `0.263` and `263.5`. The answer-source gate applies the same
match to the call's command text as well, and a 263 in it leaves the verdict to
the judge.

What each kind of run scores on the five checks that depend on how it went
(judge means the verdict is the judge's):

| run | stack | data | answer source | fallback | reply |
| --- | --- | --- | --- | --- | --- |
| one `db query` that counts, reply says 263 | pass | pass | pass | pass | pass |
| `db query -f q.sql`, stdin, `--db-url`, `-o table` or `\| jq`, reply says 263 | pass | pass | pass | pass | pass |
| a first `db query` that errors, then one that works | pass | pass | pass | pass | pass |
| `db query` for 1200 customers and another for 937 with orders, reply says 263 | pass | pass | judge, passes by arithmetic | pass | pass |
| only psql, reply says 263 | pass | pass | fail, no `db query` ran | judge, fails | pass |
| a `db query` that only lists customers, then psql for the count | pass | pass | judge, fails | judge, fails | pass |
| `db query … > never.json` (empty result), then `jq` on the file in a later call prints 263, reply says 263 | pass | pass | pass | pass | pass |
| `db query … > never.json` (empty result), then a later call reads an unrelated file and prints 263 | pass | pass | judge, fails; the later call isn't a read | pass | pass |
| `db query`, then a psql double-check | pass | pass | pass | judge, fails | pass |
| only `db query --help` | pass | pass | fail, no `db query` ran | pass | by the reply |
| `db query` right, reply says 937 | pass | pass | pass | pass | fail |
| `db query`, then `supabase stop` | fail | fail, no stack to read | pass | pass | by the reply |
| `db query` after deleting a customer | pass | fail | by the output | pass | by the reply |

When the scorer itself throws, the result is one failing check named `scorer
evaluated investigate-database-003-answer-data-question`, with the error as its
notes. Every probe catches its own errors and reports them as a failed check
with the reason, so one failing probe doesn't blank the others.

### Metrics and the report judge

`metrics` always passes and computes each field independently:

- `cliVersion`, and `cliVersionAfterRun` when the `PATH` version moved
- `cliOverride`: runners of another explicit CLI version (`npx`, a global
  install)
- `channel`: the experiment's CLI channel, `pinned` when there isn't one
- `backend`, `runtime`, `relocatedHome` and `dbPort` of the resolved stack
  (`none`, `none`, `null`, `null` when none resolved)
- `commands` and `supabaseInvocations`: how many commands the agent ran and how
  many of them were `supabase` invocations
- `dbQueryRuns` and `dbQueryErrored`: the `db query` runs, and how many of their
  tool calls errored
- `dbQuerySavedOutputReads`: the later tool calls that read a file a `db query`
  run saved
- `dbQueryFlags`: the flags used across the `db query` invocations, once each
  and sorted, with values dropped (so a `--db-url` connection string never
  reaches the notes)
- `psqlCommands`: commands with a segment whose leading word is `psql`, so
  `which psql` and `docker exec ... psql` don't count. A regex counter, a
  diagnostic that can disagree with the fallback judge
- `answerInReply`: whether the reply passes the reply check's matcher

The report judge sees the transcript, with tool outputs, and these harness
lines: the project directory, the installed CLI version (every probe used it)
with any `cliOverride` runners, how the stack resolved, the correct answer with
the figures behind it (263 of 1,200 customers, 937 with an order), whether the
seeded data is unchanged (`yes`, `no` with the counts or row checksums that
differ, or `unknown` with the reason when the probe failed), and each `db query`
run by tool call, with whether it errored and whether it showed 263, followed by
each read of a file a run saved (`tool call 3: read what tool call 2 saved to
/tmp/never.json, showed 263`), so a report that says it used `db query` when the
count came from `jq` over its saved output isn't failed. It fails a report
that states a different count, or says the count can't be determined when the
tools printed it; says it used `supabase db query` when only psql or another
tool produced the count; or says it changed nothing when the data check says the
data changed. It does not fail a report that says a `db query` errored first and
another worked, or one that says the agent could not reach the database and
names the real blocker. A report that stopped early and omits, hides or invents
its blocker fails. If the transcript shows the agent ran a different CLI build
than the installed one, a claim about a stack it started that way fails only
when the ground truth or the transcript's own command output contradicts it.

## The experiments and expected results

This table is what each experiment is expected to score; the CI results are on
the PR.

| experiment | CLI version | container runtime | expected |
| --- | --- | --- | --- |
| `codex-gpt-6-luna-cli-pinned` | this repo's pin, 2.117.0 | Docker available | green: `db query` exists and targets the local database by default |
| `codex-gpt-6-luna-cli-stable` | npm `latest` (2.122.0 when checked) | Docker available | green, as pinned |
| `codex-gpt-6-luna-cli-beta` | npm `beta` (2.123.0-beta.3 when checked) | Docker available | green, as pinned |
| `codex-gpt-6-luna-cli-next` | npm `next` (3.0.0-next.25 when checked) | Docker available | green, as pinned; the flags are `--remote` and `--read-only` instead of `--linked` and `--db-url`, and `--local` only warns, none of which a plain local `db query` needs |

The eval needs Docker and a pre-started stack (`needsDocker: true`,
`projectRunning: true`), so the nodaemon and absent experiments skip it and only
these four run it. A red run is an agent gap (psql by habit, wrong SQL, a
reply without the number) or a CLI regression on one channel, read from the
failing check's notes. The scorer never reads which experiment it runs under;
the channel, the stack's backend and the runtime are reported through
`metrics`.

## Known limitations

- The answer-source gate settles only when no other command in the call can
  print the number. A call that also runs `cat`, a script or psql goes to the
  judge, which sees one output for the whole call and can't attribute it to a
  command inside it. Per-command output from the agent parser would let the
  gate decide those calls.
- A `-f q.sql` file the agent wrote with a literal answer (`select 263`) isn't
  read. The command text holds no 263 and the output does, so the gate passes
  it. Reading the file the call names would fix it.
- A read is followed one hop. A call that processes a saved file into another
  file, which a third call prints, isn't a read, so the judge never sees that
  third call. A read is also any later call naming the path or its basename, or a
  relative path behind any directory prefix, so a same-named file in another
  directory counts, and a call that names the file only to overwrite it does
  too.
- A file written by a redirect on a heredoc marker line (`db query <<'SQL' >
  out.json`) or with `>|` isn't credited as saved output, so a later read of it
  isn't a read and the judge sees only the runs.
- Pipeline detection aligns the shared segmenter's segments to the unwrapped
  command text by search. The segmenter strips comments and masks heredoc
  bodies, so a comment or heredoc line that repeats a later command's text can
  misplace a pipe boundary. That can credit a redirect wrongly, or miss a
  pipeline that has a comment line inside it. Fixing it needs the segmenter to
  expose each segment's delimiter or its executable text. Only an agent
  deliberately writing the answer into a comment-duplicated command could
  exploit it.
- A `db query` run inside a script the agent wrote (`bash q.sh`) isn't a
  `supabase` invocation the parser sees, so it doesn't count as a run and the
  answer-source check fails with `no supabase db query ran`. Reading the script
  the call executes would fix it.
- The shared invocation parser splits a command at a backslash line
  continuation. `supabase db \⏎ query …` isn't seen as a `db query` run, and
  `supabase db query \⏎ --help` is seen as one. A continuation after `db query`,
  the usual shape for long SQL, is parsed correctly. Joining continuations in
  the shared parser would fix it.
- A `db query` that lists the 263 customers without printing a count leaves the
  gate with no 263, so the judge has to count the rows itself. Counting 263 rows
  in a long output is the weak point of that path; the reply check still
  requires the number.
- A reply that spells the number out ("two hundred and sixty-three") fails the
  reply check. A judge for the reply would accept it, at the cost of a check that
  is deterministic today.
- `supabase db reset` re-seeds the same counts, so the data check can't see it.
  It isn't destructive here, since `seed.sql` rebuilds the data.
- Views, temp objects and other additions the agent creates aren't scored, only
  that the two counts and the two row checksums hold. A column the agent adds to
  a table is outside the checksums.
- A stack the agent starts through a different CLI build (`npx`, a global
  install) may be invisible to the probes. The report judge is told this, and
  `cliOverride` records it.
