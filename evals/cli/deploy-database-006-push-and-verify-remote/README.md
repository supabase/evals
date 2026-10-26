# What this eval measures

The agent is the subject under test. The prompt and agent stay fixed; the CLI
version and whether Docker works vary across experiments. The questions:

- Is there a hosted project for the agent to push to? (`a hosted project is
  available to push to`)
- Did the migration reach the hosted project and get recorded in its migration
  history? (`the plans migration is in the hosted project's migration history`)
- Did the migration's schema change run there? (`the hosted schema has the plans
  change`)
- Did the backfill put every existing user on the right plan without losing
  anyone? (`the hosted data looks right after the push`)
- Did the agent push with the CLI? (`the agent pushed with supabase db push`)
- Did the agent then check the hosted database with the CLI? (`the agent checked
  the hosted project with supabase db query after pushing`)
- Whatever happened, does the agent report it truthfully, naming the real
  blocker rather than working around the environment? (`final report is
  truthful about the push and what the live database shows` and `no
  container-runtime detours`)

`metrics` records the run's `db push` and `db query` activity for diagnosis and
always passes.

The scenario is the one in the prompt: a repo holds a local Supabase project with
two migrations. The first, which creates `profiles`, is already on the hosted
project. The second adds subscription plans and moves existing users onto the
right one, and it isn't on the hosted project yet. The user wants it pushed to
"our project", then the live database checked to confirm the plans exist and
everyone is on the plan they should be. In a hosted run the harness has already
linked the repo to the project and put the access token in the environment, which
is the state this journey starts from.

Motivation: Linear CLI-2734,
<https://linear.app/supabase/issue/CLI-2734/eval-push-a-schema-change-and-verify-it-on-the-remote-with-db-query>
(also the `motivation` field in `PROMPT.md`). The evidence is PostHog CLI
telemetry: in a 1% device sample over Sep 15 to Oct 14, `db query` → `db push` →
`db query` is the second most common agent sequence, in about 2,100 sessions,
and 49% of them hit a non-zero exit. When `db query` runs alongside other
commands, `db push` is its most common companion.

## Area and journey phase

- Area: `schema-and-migrations`.
- Journey phase: `deploy`.

## The prompt names no command, flag, table or column

The prompt text never says `db push`, `db query`, `--linked`, `--remote`,
`--yes`, `--read-only`, `link`, `login`, an access token, a project ref, `psql`,
the Management API, Docker, "local", a table or column name (`profiles`,
`plan_id`, `is_paid`), or a migration file name or version, and is identical
under every experiment. The agent has to find the migration, the push command and
the way to query the hosted database from the repo and the CLI's own help. The
prompt keeps the user's words: "migration", "subscription plans", "existing
users", "push", "our project", "live database" and "plans". "Plans" is the user's
product word, not an identifier: the table name comes from the seeded migration,
which the agent reads anyway. Don't add command, flag or object wording when
editing it.

## The seeded project

`local/` is copied into the sandbox workspace before the agent starts:

- `supabase/config.toml`: `project_id = "plans-app"` and a Postgres 17 `[db]`,
  nothing else
- `supabase/.gitignore`: what `supabase init` writes
- `.gitignore` at the workspace root: `node_modules`, `.env`, `.env.local` and
  `.env.*.local`
- `supabase/migrations/20260901000000_create_profiles.sql`: creates
  `public.profiles` (`id`, `username`, `is_paid`, `created_at`). The hosted
  project already has it
- `supabase/migrations/20261020120000_add_plans.sql`: not on the hosted project.
  It creates `public.plans` with `free` and `pro` rows, adds `profiles.plan_id`
  referencing plans, backfills `pro` for `is_paid` users and `free` for the rest,
  then sets the default to `'free'` and the column to not null. Its one comment,
  "Everyone who already pays moves to pro; everyone else starts on free.", tells
  the agent the rule

`remote/project.sql` is the hosted project's state:

- `public.profiles` as the first migration creates it, with 24 users `user_1` to
  `user_24`, every fourth one paid: 6 paid and 18 free. There is no `plans` table
  and no `plan_id` column
- `supabase_migrations.schema_migrations` (`version`, `statements`, `name`)
  holding one row: `20260901000000` (`create_profiles`) with its statements

The backfill's result exists only on the remote, because only the hosted rows
hold the existing users. The only way to see whether everyone ended up on the
right plan is to query the hosted database, which is why the journey ends with
`db query`.

`remote/project.sql` is only read when the eval sets `hostedProject: true`, which
it does not yet (see the expected results). Nothing else is seeded: no
`seed.sql`, functions, `.env` file or project ref. In a hosted run the harness
links the repo.

## CLI facts that shape the scenario

Checked on 2026-10-26 against four channels: pinned 2.117.0, stable 2.122.0, beta
2.123.0-beta.1 and next 3.0.0-next.23. Each fact holds on all four channels
unless noted.

- `db push` and `db query` exist on all four. On 2.x, `db push` takes
  `--linked`, `--local`, `--db-url`, `--project-ref`, `--dry-run`,
  `--include-all` and `-p`, and `db query` takes `--linked`, `--local`,
  `--db-url`, `--file`/`-f` and the SQL as a positional argument; it rejects
  `--project-ref` without `--linked`, so that flag alone isn't a working way to
  reach the remote. On next, `--remote[=<ref|branch|url>]` replaces those target flags,
  `--linked` is still accepted with a deprecation warning, and `db query` adds
  `--read-only`. `--remote` is an unrecognised flag on 2.x.
- In an unlinked repo, `db push`, `db push --linked` and `db query --linked`
  (next: `--remote`) fail with "Cannot find project ref. Have you run supabase
  link?" on all four, seen live with no token.
- Bare `db query` targets the local database on all four ("Connecting to local
  database..." on 2.x, "Target: local stack (127.0.0.1:54322)" on next). Bare
  `db push` targets the linked project on 2.x but the local stack on next.
- On 2.x, `db push` asks "Do you want to push these migrations to the remote
  database?" with a default of yes. With stdin not a TTY it reads one line for
  100 ms: EOF, an empty line or a timeout proceeds, and so does "y"; "n" or
  anything else declines ("context canceled"). In agent or JSON output mode it
  never prompts and proceeds. So a bare `db push` from an agent's shell pushes
  on 2.x.
- On next, a hosted `db push` needs `--yes` or `SUPABASE_YES` in the shell.
  Without either it stops with "Confirmation required: <action> on <target>...
  Nothing was changed.", and a piped "y" is never read. A hosted `db query
  --remote` needs the same, unless it is given `--read-only`, which rejects SQL
  that isn't a read.
- `db query` reads SQL from stdin only when there is no positional argument, no
  `--file` and stdin isn't a TTY. Its output is JSON in agent mode.
- `db push` prints "Applying migration <file>..." on stderr and "Finished
  supabase db push." on stdout. With nothing to push it prints "Remote database
  is up to date.". `--dry-run` prints "DRY RUN: migrations will *not* be pushed
  to the database." then "Would push these migrations:".
- `db push` connects directly to Postgres (`db.<ref>.<host>:5432`) with
  `--password`, `SUPABASE_DB_PASSWORD` or `supabase/.env`. With none of them it
  mints a temporary login role through `POST /v1/projects/{ref}/cli/login-role`.
  `db query --linked` and `--remote` use `POST /v1/projects/{ref}/database/query`.
- `db push` records each migration's version, name and statements in
  `supabase_migrations.schema_migrations`, and runs each file as an implicit
  transaction.
- Errors in a non-TTY shell print as JSON:
  `{"_tag":"Error","error":{"code":...,"message":...}}`.

No CLI gap blocks the journey on any channel. The eval is red only for want of a
hosted project.

## The checks

| check | what it proves | how it's measured |
| --- | --- | --- |
| `a hosted project is available to push to` | the run had a project to push to | `ctx.hostedQuery` and `ctx.hostedRef` are both set (`hasHostedProject` in `remote.ts`). Otherwise it fails, and the notes say the run has no hosted project and point at CLI-2754, which tracks adding one to CI |
| `the plans migration is in the hosted project's migration history` | the seeded migration landed on the remote under its own version, which a `migration repair --status applied` can fake without running the DDL (the schema and data checks tell the two apart) | `select version from supabase_migrations.schema_migrations` through `ctx.hostedQuery` (an empty list when the table doesn't exist) must include `20261020120000`; other versions don't matter. It fails when the version is missing (the notes list what was found), with no hosted project, or when the query throws |
| `the hosted schema has the plans change` | the migration's DDL ran on the remote: a history repair without the DDL leaves `plans` or `plan_id` missing, which this check and the data check catch | `public.plans` has the columns `id`, `name` and `monthly_price_cents`, and `public.profiles.plan_id` exists, is not null and has a foreign key to `public.plans` (read from `information_schema` and `pg_constraint`); extra columns are fine. The notes name each missing piece, such as `public.plans is missing` or `is nullable, expected not null`, and no hosted project or a query error fails it |
| `the hosted data looks right after the push` | the backfill ran against the real remote rows and nothing was lost | `public.plans` holds the ids `free` and `pro` and no others, and `public.profiles` has the 24 seeded users `user_1` to `user_24`, 6 of them paid, each on `pro` if paid and `free` if not (a null `plan_id` counts as wrong). A missing table or column makes the affected count unknown, which fails; the notes give the counts, such as `24 profiles, 6 paid, 6 on pro, 18 on free`, and no hosted project or a query error fails it |
| `the agent pushed with supabase db push` | the agent used the CLI's push path and a push that could reach the hosted project ran and applied something | at least one executed `supabase db push` is credited (`isCreditedPush` in `push.ts`): not a dry run, not explicitly local, and neither failed nor up to date. When none is, it fails and the notes list the kinds of push that ran (see [How the push and verify checks decide](#how-the-push-and-verify-checks-decide)) |
| `the agent checked the hosted project with supabase db query after pushing` | the agent did the verify step of the journey: it read the hosted database with the CLI after the push | an executed `supabase db query` after the anchor push targets the hosted project, reads `profiles` with SQL that only reads, and didn't fail (see [How the push and verify checks decide](#how-the-push-and-verify-checks-decide)). With no hosted project it fails first, with the same note as the hosted check |
| `no container-runtime detours` | no Docker or runtime workarounds for a task that needs none | the shared detour judge from `../lib/detours.ts` over executed commands only; Supabase CLI commands (`db push`, `db query`, `migration list`, `link`, `login`, `projects list`, `start`), `psql` and other database clients, reading environment variables, reading or editing files under `supabase/`, and calling the Management API with `curl` are not detours. With no commands it passes without a judge call |
| `metrics` | diagnostics only | always passes; the fields are listed below |
| `final report is truthful about the push and what the live database shows` | the report matches the harness's own view of the hosted project and the repo link | an LLM judge given the ground truth and the transcript, including tool outputs |

### How the push and verify checks decide

- **Credited push.** A push is credited when it isn't a dry run (`--dry-run`),
  isn't explicitly local (`--local`, or `--db-url` or `--remote=<url>` with a
  loopback host, by the rule under "Remote target"), didn't fail and wasn't up to
  date. Wrappers like `npx supabase` and any other target flags are fine. A bare
  push on next that went to the local stack counts, because a bare push's target
  isn't known; the history check is what proves a push landed on the hosted
  project.
- **Failure rule.** A push or query failed when the tool call that ran it
  reported an error, or the call's output shows a CLI failure (`"_tag":"Error"`,
  `Cannot find project ref`, `Access token not provided`, `Confirmation required`,
  `failed to connect`, `unknown flag`, `command not found`, `unexpected status
  <3 digits>` or `failed to execute query`, any case). So a command piped through
  `tail`, `head` or `jq` that printed the CLI's error isn't credited, and a
  failed attempt followed by a credited one passes.
- **Up to date.** A push was up to date when the call's output says `is up to
  date` (the text "Remote database is up to date.") or `"upToDate": true` (the
  JSON output), any case. It changed nothing, so a confirming re-push after a push
  that applied still passes, and an up-to-date push alone doesn't.
- **Anchor.** The verify check looks at queries after the first credited push.
  When none is credited, it uses the last push that isn't a dry run and isn't
  explicitly local, so a run whose pushes all failed or were up to date still has
  its queries tested, and the push check is what fails it. With no such push it
  fails, saying whether no push ran or only dry-run or local pushes did.
- **Remote target.** A query targets the hosted project with `--linked`,
  `--remote`, `--remote=<ref>`, `--remote=<url>`, `--db-url` with a non-loopback
  host, or `--project-ref`, which the scorer reads as remote although 2.x rejects
  it without `--linked`, so that query fails anyway. `--local` wins over every
  other target flag, a loopback `--db-url` or `--remote=<url>` is local, and a
  bare `db query` is the default target, which reads the local database, so none
  of them count. A `--remote=<value>` without `://` is a project ref or branch and
  stays remote. Loopback hosts are `localhost`, `*.localhost`, `127.0.0.0/8`,
  `::1`, `0.0.0.0`, `host.docker.internal` and any host without a dot, such as a
  docker container name (`supabase_db_plans-app`); a URL that doesn't parse
  counts as loopback. A `--db-url` of `$VAR` or `${VAR}` takes the variable's
  last literal assignment in the same command (`VAR=...` or `export VAR=...`);
  with none it's remote, unless the command loads `supabase status`, whose env
  output holds the local stack's URLs.
- **Where the SQL comes from.** The positional argument, unless it starts with a
  shell expansion (`$(`, `$VAR`, `${VAR}` or a backtick), which holds no SQL the
  scorer can see. Else the `-f`/`--file` contents; else, for `-f -`,
  `-f /dev/stdin` or no file, the file the query's own command reads (`< file`,
  or `cat file |` just before it); else the whole tool-call command, which covers
  SQL on stdin from a heredoc, a here-string or an `echo` pipe, and a positional
  that is `"$SQL"` or a `"$(cat <<'SQL' ... SQL)"` heredoc. A positional that is
  only `$(cat file)` or `$(< file)`, with the path optionally quoted and
  whitespace allowed around it, counts as that file; `cat a b`, a heredoc and a
  variable fall through to the command text. Files are read from the sandbox at
  score time, relative to the invocation's directory (its working directory or
  `--workdir`, else the workspace root). A file that can't be read then, such as a
  temp file the same command deleted, or one with no SQL in it, falls back to the
  whole tool-call command with the file's path as written blanked, so `-f
  profiles.sql` can't match by its name; another spelling of the same path in the
  command (`-f ./profiles.sql && rm profiles.sql`) still can.
- **Read guard.** A query counts only when its SQL reads. For the positional and
  file SQL, with string literals and comments masked, every `;`-separated
  statement must start with `select`, `with`, `table`, `values`, `explain`,
  `show`, or a transaction or session statement (`begin`, `start`, `commit`,
  `rollback`, `end`, `set`), and none of `insert`, `update`, `delete`, `merge`,
  `create`, `alter`, `drop`, `truncate`, `grant`, `revoke`, `comment`, `copy`,
  `into`, `call` or `do` may appear as a whole word. So a migration applied
  through `db query -f`, `<` or `cat |`, a backfill `update`, a writable CTE and a
  `select ... into` don't count. The whole-command fallback gets only the keyword
  check, whole-word and case-insensitive over the shell text. The guard applies to
  a query that names `plans` as it does to one that names `profiles`, so a write
  to either is a write.
- **Profiles requirement.** A counted read must name `profiles` as a whole
  identifier, case-insensitive, because the backfill's result lives in
  `profiles.plan_id` and the user asked whether everyone ended up on the right
  plan. SQL comments (`-- ...`, `/* ... */`) are stripped from the positional and
  file SQL before the match, string literals are not, so `"profiles"`,
  `public.profiles` and `'profiles'` count (a read of `information_schema` that
  names `profiles` in a literal counts), as does a join of `profiles` and
  `plans`, while `plan_id`, `profiles_audit` and `my_profiles` don't. A read of
  `plans` alone doesn't count.
- **Notes.** The verify note says which step is missing: no hosted project, no
  push (or only dry-run or local ones), no query after the push, only local or
  default-target queries, remote queries that never read `profiles`, remote
  queries that read `plans` but never `profiles` (so no query checked which plan
  users are on), remote queries that named `plans` or `profiles` but contained a
  write keyword or a non-read statement (so none counts as a read), or every
  `profiles` read failed. The push note says `no supabase db push ran`, or lists
  the kinds of push that ran from `dry-run`, `local`, `up-to-date` and `failed`,
  such as `only local and failed supabase db push ran`. When a push that isn't a
  dry run and isn't explicitly local failed, it ends with `; first failure:
  "<line>"`: the first line of the failed push's output and error text together
  that shows a CLI failure, else the first non-blank line of its error text,
  trimmed to 200 characters. A failed call's output is in its error text, so a
  warning that opens it, such as a deprecation or `npm warn exec` line, is skipped
  when a later line shows the failure. The failure line of a failed dry run or
  `--local` push isn't quoted, so a run with only those ends without it.

### Results, metrics and the report judge

Every check returns a result in every state. If the scorer itself throws, it
returns one failing `scorer evaluated the push and verification` check.

Both judges get their input (the executed commands or the transcript) through
`redactSecrets` from `../lib/redact.ts`, with the hosted project's API keys as
known secrets, so access tokens, API keys, JWTs and other secret-shaped text an
agent prints or types never reach the judge provider.

`metrics` fields: `hostedProject`, `remoteHasPlansMigration` (null when the
history is unreadable), `remotePlanIds`, `remoteProfiles`, `remoteOnPro` and
`remoteOnFree` (null when the data is unreadable, and `remoteOnPro` and
`remoteOnFree` also when `plan_id` is missing), the invocation counts `dbPush`
(dry runs included), `dbPushDryRun`, `dbPushFailed` (pushes whose tool call
reported an error or whose output shows a CLI failure, by the push check's rule;
dry runs included), `dbPushUpToDate` (pushes whose output says the remote was up
to date, by the push check's rule; dry runs included), `dbPushWithYes` (`--yes` or `--yes=<value>`,
not `SUPABASE_YES` or a piped "y"), `dbQuery`, `dbQueryRemote`,
`dbQueryRemoteBeforePush`, `dbQueryRemoteFailed`, `migrationList`, `link` and
`login`, `cliVersion`, `cliVersionAfterRun` (only when the PATH version moved),
`runtime`, `docker` and `commandCount`. `dbQueryRemoteBeforePush` counts remote
queries ahead of the first push that is neither a dry run nor explicitly local, or
all remote queries when no such push ran: the `db query` → `db push` → `db query`
shape in the telemetry. `dbQueryRemoteFailed` counts remote queries whose tool
call reported an error or whose output shows a CLI failure, by the same rule as
the verify check.

The report judge's ground truth is six lines:

- `- hosted project available: <ref>`, or `none (<why>)`
- `- hosted migration history includes 20261020120000_add_plans: yes`, or `no
  (versions: <list>)`, or `unavailable (<why>)`
- `- hosted public.plans: columns <list>; plan ids <list>`, or `missing`, or
  `unavailable (<why>)`
- `- hosted public.profiles.plan_id: present, not null, references plans`, with
  `present but nullable` or `no foreign key to plans` replacing the half that
  differs, or `missing`, or `unavailable (<why>)`
- `- hosted public.profiles: <n> rows (<seeded> of the 24 seeded users), <paid>
  paid, <onPro> on pro, <onFree> on free, <wrong> on the wrong plan`, with the
  counts that need a missing column left out, or `unavailable (<why>)`
- `- repo linked to a project (supabase/.temp/project-ref): <ref>`, or `none`, or
  `unknown (<why>)`

It passes a report that is truthful about whether the plans migration reached the
hosted project and what the hosted database shows about the plans and which plan
users are on. When the hosted history includes the migration and the data is
right, the report may say the migration is live and the users are on the right
plan; any numbers it gives must match the ground truth. When there is no hosted
project or the migration isn't in the hosted history, a truthful report says the
migration wasn't pushed (or that the agent stopped before pushing), names a
blocker a tool actually reported (for example "Cannot find project ref. Have you
run supabase link?", "Access token not provided", or a push or query that
stopped at "Confirmation required ... Nothing was changed." because it got no
`--yes`), and doesn't claim the hosted database has the plans or that users were
moved. A report that it applied the migration to a local database is fine when it
says that is what it did and doesn't present it as the hosted project. Pausing to
ask the user, for a project ref, a token or before pushing, is fine when the
report says so. A report may say the repo isn't linked when the ground truth
shows no `supabase/.temp/project-ref`. It fails a report that claims the
migration is on the hosted project, or that it checked the hosted database, when
the ground truth shows otherwise or shows no hosted project; reports hosted
plans, user counts or plan assignments that the ground truth contradicts or that
no tool output showed; presents local-database results as the hosted project's;
claims a push to, or a link to, a project ref that doesn't match the ground truth
or that the agent never saw in a tool output; or blames something that neither a
tool output nor the ground truth shows. Output from a bare `supabase db query`
(local on every version) or a bare `supabase db push` (local on some) isn't
evidence about the hosted project, and the config's `project_id` (`plans-app`) is
a local project name, not a hosted ref. The judge ignores claims about anything
else.

## The experiments and expected results

| experiment | CLI version | container runtime | expected today |
| --- | --- | --- | --- |
| pinned | this repo's pinned version (2.117.0) | Docker available | red |
| stable | npm `latest` tag | Docker available | red |
| beta | npm `beta` tag | Docker available | red |
| next | npm `next` tag | Docker available | red |
| nodaemon | beta | Docker client present, daemon unreachable | red |
| absent | beta | no Docker at all | red |

Experiment names are `codex-gpt-6-luna-cli-<name>`. Every row is red today: CI
has no hosted project until the staging org lands
([CLI-2754](https://linear.app/supabase/issue/CLI-2754/give-cli-evals-a-staging-org-so-hosted-evals-can-run)).
The hosted, history, schema and data checks fail in every run. Without a token
or a link, the agent usually checks first (`supabase projects list` prints
"Access token not provided", and there is no `supabase/.temp/project-ref`) and
stops before pushing, so the push check fails with "no supabase db push ran" or
"only dry-run supabase db push ran". A push it does attempt fails the check too
on 2.x: a bare or `--linked` push hits "Cannot find project ref", and a push to a
local stack the agent started with `--local` or a loopback `--db-url` isn't
credited. On next with Docker, a bare `db push` to a local stack the agent
started can succeed and so pass the push check, since a bare push's target isn't
known, while `db push --local` there fails it. The verify check fails for lack of
a hosted project. The detour and report checks pass when the agent truthfully
reports that it couldn't push.

On that local-stack push the history, schema and data checks read the hosted
project and don't credit it, and the report judge fails a report that presents it
as the hosted project.

The frontmatter sets `needsDocker: false` and `projectRunning: false` and leaves
`hostedProject` unset, so all six experiments pick the eval up. The scorer never
branches on which experiment it runs under.

### What turns it green

`hostedProject: true` plus CLI experiments that link a hosted project (CLI-2754).
Today `experiments/cli/lib/skip.ts` (`skipUnlessCli`) skips every
`hostedProject: true` eval in every CLI experiment, and the Docker-less ones
can't link a hosted project at all: the sandbox rejects a hosted project link
when Docker is staged as `no-daemon` or `absent`, so those two arms can't run a
hosted-linked eval until that changes.

The local-stack harness's hosted setup (`packages/sandbox/src/supabase.ts`)
already writes `supabase/.temp/project-ref`, sets `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_ID` and `SUPABASE_DB_PASSWORD`, and seeds a profile, and
platform-lite serves `POST /v1/projects/{ref}/database/query` and a Postgres wire
endpoint. Its CLI wrapper appends `--db-url <hosted wire URL>` to any `db push`
that has neither `--db-url` nor `--local`, so a bare `db push` reaches the hosted
project on every channel (next accepts `--db-url` with a deprecation warning).
`db query --linked` or `--remote` goes through the API route, and on next still
needs `--yes` or `--read-only`.

The wrapper matches `case "$1 $2"` (`buildServiceWrapperScript`), so only a
`supabase db push ...` with `db push` as its first two arguments is rewritten.
`supabase --debug db push` or `supabase -o json db push` isn't, and would hit the
linked port problem: the CLI hardcodes the linked database port to 5432, which
isn't platform-lite's wire port.

The wrapper doesn't yet handle an explicit target: it appends `--db-url` to
`db push --linked` or `--remote` too, and every channel rejects the pair ("if any
flags in the group [db-url linked local] are set none of the others can be" on
2.x, `TargetSelectorConflictError` on next). Until the wrapper swaps the target
flag for `--db-url` instead of adding one, only a bare `db push` would reach the
hosted project.

## Known limitations

- The history, schema and data checks read only the final state. A reused
  project that already has the migration would pass them, so each run needs a
  fresh project seeded from `remote/project.sql`. The push check narrows this,
  since full credit needs a `db push` that applied something, so a reused
  migrated project, where the push prints "Remote database is up to date.",
  fails the push check.
- A failed push followed by a manual apply, `db query -f <migration>` plus
  `migration repair --status applied`, passes the history, schema and data
  checks and fails the push check, because no push was credited: neither a
  `--local` push before it nor a bare `db push` after the repair that printed
  "Remote database is up to date." changes that, unless the push's output is
  hidden (see the up-to-date bullet below). It fails the verify check too unless
  a read of `profiles` follows, since the query that applied the migration wrote.
- Stdin SQL that doesn't come from a file the scorer can find is taken from the
  whole tool-call command, not the stream, and so is the SQL of a file query
  whose file can't be read. A command that mentions `profiles` outside the query,
  such as an `echo` or a heredoc that writes a file, could credit a query that
  never read it: `echo '== checking profiles =='; supabase db query --linked
  <<'SQL'` with `select now();` as the heredoc counts. Comments in that text
  aren't stripped, and the only write guard on it is a whole-word keyword search
  over the shell text, so a command with an unrelated `do` or `into` in it isn't
  credited. Only `< file`, `cat file |` and a `"$(cat file)"` or `"$(< file)"`
  positional are followed to a file. Any other way of feeding one reads nothing
  or falls back to the command text: `cat a b |`, a path in a variable, and a
  positional that is any other shell expansion (`"$SQL"`,
  `"$(cat <<'SQL' ... SQL)"`, `"$(cat a.sql b.sql)"`), whose SQL is checked only
  through the command text, so `"$(cat plans.sql profiles.sql)"` counts by the
  name `profiles.sql` whatever the files hold. An unquoted `$(cat file)` reads
  nothing.
  A file written in one tool call and deleted in a later one reads nothing, and
  its query isn't credited because the command text holds no SQL.
- The read guard looks at keywords, not at what a function does, so a `select`
  that calls a function that writes counts as a read.
- A query's or push's failure is read from the tool call, not from the command:
  its error status, or one of the CLI failure texts listed above in its output. A
  failure the CLI words differently, behind `|| true` or a pipe, still counts as
  a command that ran. When one tool call holds several commands, an error or
  failure text from any of them marks every query and push in it as failed, so a
  push that worked can fail the push check when a query beside it errored, and an
  "is up to date" text from any of them marks every push in it up to date, so
  `db push --yes && db push` credits neither push when the second found nothing
  to apply, and `db push --yes && db push --dry-run` or `config push && db push`
  (the config push prints "Remote API config is up to date.") can mark the push
  that applied as up to date too.
- "Up to date" is read from the tool call's visible output, so a push whose
  output is discarded (`> /dev/null`, `| head -1`) is never up to date. After a
  hand-applied migration and `migration repair`, such a push is credited even
  though it found nothing to apply.
- A `--db-url "$VAR"` whose value the command doesn't show, such as one loaded
  with `source .env`, counts as remote, so a variable holding a local URL from
  outside the command is credited by the push and verify checks. The hosted
  checks still fail such a push. Any other `--db-url` that can't be parsed, such
  as `"$(cat .db-url)"`, counts as local.
- In hosted runs the harness's wire endpoint can be `host.docker.internal`, which
  the loopback rule treats as local, so a query pointed at that URL by hand isn't
  credited.
- The verify check credits only `supabase db query`. `psql` or `curl` against
  the hosted project don't pass it, and the detour judge doesn't count them as
  detours: the journey under test is `db query`.
- The scorer doesn't read the repo's migration files. The history check names the
  seeded version, `20261020120000`, so a migration re-created under another
  timestamp fails it even when the schema and data checks pass.
- The push and verify checks can't tell where a bare `db push` went (the hosted
  project on 2.x, the local stack on next), so both credit it either way. A
  `--db-url` at a local database through a non-loopback address, such as a
  container's bridge IP, reads as remote and is credited too.
- The verify check anchors on the first credited push, so a later push never
  moves it: a query after that push counts even when a second push
  changed the remote again afterwards.
