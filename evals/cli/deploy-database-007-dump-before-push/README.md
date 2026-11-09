# What this eval measures

The agent is the subject under test. The prompt and agent stay fixed; the CLI
version varies across the four experiments that run this eval, all with Docker
available. The questions:

- Is there a hosted project to back up and push to? (`a hosted project is
  available to push to`)
- Did the migration reach the hosted project and get recorded in its migration
  history? (`the drop migration is in the hosted project's migration history`)
- Did the migration's schema change run there, with the customers left alone?
  (`the hosted project dropped the coupons and kept its customers`)
- Did the agent save a copy of the rows the migration deletes before it deleted
  them? (`a saved backup holds the coupon rows from before the push`)
- Did the agent dump the hosted database with the CLI before pushing? (`the
  agent dumped the hosted database with supabase db dump before pushing`)
- Did the agent push with the CLI? (`the agent pushed with supabase db push`)
- Did the agent tell the user where the backup is? (`the report says where the
  backup is`)
- Whatever happened, does the agent report it truthfully, naming the real
  blocker rather than working around the environment? (`final report is
  truthful about the backup and the push` and `no container-runtime detours`)

`metrics` records the run's `db dump` and `db push` activity for diagnosis and
always passes.

The scenario is the one in the prompt: a repo holds a local Supabase project
with two migrations. The first, which creates `customers` and `legacy_coupons`,
is already on the hosted project, where `legacy_coupons` holds 15 coupons that
exist nowhere else. The second drops `legacy_coupons` and isn't on the hosted
project yet. The user wants a backup of the live database before the migration
goes out, then the push, then to be told where the backup is. A good run dumps
the hosted database with its data into a file, pushes, and reports that file. In
a hosted run the harness has already linked the repo to the project and put the
access token in the environment, which is the state this journey starts from.

Motivation: Linear CLI-2738,
<https://linear.app/supabase/issue/CLI-2738/eval-dump-the-remote-database-before-a-risky-push-hosted>
(also the `motivation` field in `PROMPT.md`). The evidence is PostHog CLI
telemetry: in a 1% device sample over Sep 15 to Oct 14, `db dump` is in about
1.4% of agent sessions, usually between `migration list` or `db query` and a
`db push`.

## Area and journey phase

- Area: `schema-and-migrations`.
- Journey phase: `deploy`.

## The prompt names no command, flag, table or column

The prompt text never says `dump`, `pg_dump`, `db push`, `--data-only`,
`supabase`, "CLI", `link`, `remote`, "local", `psql`, `login`, an access token,
a project ref, the Management API, Docker, "schema", "table", `coupons`,
`legacy_coupons`, `customers`, or a file name, path or version, and is identical
under every experiment. It doesn't say where to save the backup or what it
should contain either. The agent has to find the migration, work out that a
backup of the live data is a data dump of the hosted database, pick the CLI
command and flags for it, choose where to save the file, push, and say where
the file is. The prompt keeps the user's words: "migration", "old data",
"backup", "live database", "restore", "push" and "our project". Don't add
command, flag or object wording when editing it.

"Backup" is the user's goal word rather than a command because it names an
outcome, a copy they can restore from, and the CLI has no backup command: the
agent has to learn that `db dump` is the way to make one, and that a bare dump
holds the schema and not the old data the user wants to restore. The backup
check scores that outcome, a saved file holding the rows. The dump check scores
the CLI path on its own.

The prompt asks for a backup in the user's words, not for a dump, because that
is how the user would ask: they want a copy they can restore from and leave the
way to make one to the agent. Naming `db dump` or `--data-only` would hand over
the step the eval exists to test, turning it into a check on following
instructions rather than on choosing the right command and flags.

## The seeded project

`local/` is copied into the sandbox workspace before the agent starts:

- `supabase/config.toml`: `project_id = "shop-app"` and a Postgres 17 `[db]`,
  nothing else
- `supabase/.gitignore`: what `supabase init` writes; it ignores `.temp`, where
  the CLI keeps the link state
- `.gitignore` at the workspace root: `node_modules`, `.env`, `.env.local` and
  `.env.*.local`
- `supabase/migrations/20260801000000_create_shop.sql`: creates
  `public.customers` (an identity `id`, a unique `email`, `created_at`) and
  `public.legacy_coupons` (`code` as the primary key, `customer_id` referencing
  customers, `percent_off`, `issued_at`, `redeemed_at`). The hosted project
  already has it
- `supabase/migrations/20261027090000_drop_legacy_coupons.sql`: not on the
  hosted project. It is `drop table public.legacy_coupons;` under one comment,
  "Coupons moved to Stripe in September and nothing reads this table any more.",
  which gives the reason for the drop. It sorts after the one version in the
  hosted history, so a plain `db push` applies it

No file under `local/` holds a coupon code, and nothing seeds data locally.

`remote/project.sql` is the hosted project's state:

- `public.customers` and `public.legacy_coupons` as the base migration creates
  them, with 8 customers (`customer1@example.com` to `customer8@example.com`)
  and 15 coupons: codes of `LGCY-` plus six characters, spread over the
  customers (each holds at least one), with a `percent_off` of 10, 15, 20 or 25
  and 4 of them redeemed
- `supabase_migrations.schema_migrations` (`version`, `statements`, `name`)
  holding one row: `20260801000000` (`create_shop`) with its two statements, one
  array element per `create table`, as the CLI records them. The drop migration
  isn't in the history

The 15 codes (`COUPON_CODES` in `seed.ts`) exist only in the hosted project's
rows, which is what lets the backup check tell a backup of the live data taken
before the push from the other dumps an agent might make:

- a schema-only dump (`db dump` with no flag) holds the table definition and no
  rows, so none of the codes
- a dump taken after the push has no `legacy_coupons` at all, so none of them
- a dump of the local database holds none, because nothing in `local/` seeds
  rows
- a partial capture, such as a query with a `limit`, holds some of them but not
  all 15, and the check's notes say how many

The codes are random-looking, so an agent can't write them down without reading
the hosted rows.

A list of just the codes isn't a backup of the rows, so the check also looks for
the coupons' dates. The `issued_at` and `redeemed_at` values (`timestamptz`)
fall on 12 distinct days from 2026-08-03 to 2026-09-03 (`COUPON_DATES` in
`seed.ts`), which any export of the rows holds as `YYYY-MM-DD` text. Every
time sits between 11:30 and 12:30 UTC, so an export rendered at any UTC offset
within 11 hours either way keeps the same dates. A backup is complete only with
all 15 codes and all 12 dates.

`remote/project.sql` is only read when the eval sets `hostedProject: true`,
which it does not yet (see the expected results). Nothing else is seeded: no
`seed.sql`, functions, `.env` file or project ref. In a hosted run the harness
links the repo.

## CLI facts that shape the scenario

Checked on 2026-10-27 against four channels: pinned 2.117.0, stable 2.122.0,
beta 2.123.0-beta.5 and next 3.0.0-next.25. Each fact holds on all four channels
unless noted.

- `db dump` exists on all four. On 2.x its help reads "Dumps data or schemas
  from the remote database." and it takes the target flags `--linked` (the
  default), `--local`, `--db-url` and `--project-ref`, plus `--data-only`,
  `--role-only`, `--schema`/`-s`, `--use-copy`, `--exclude`/`-x`,
  `--keep-comments`, `--file`/`-f`, `--dry-run` and `--password`/`-p`. With no
  flag it dumps the schema only, so a bare dump holds no rows and can't restore
  a dropped table's data; `--data-only`, alone or as a second dump, does.
- On next the help reads "Dumps data or schemas from a database." and "Local by
  default. Pass --remote for the linked project, or --remote=<ref|branch|url>."
  A bare `db dump --data-only -f b.sql` on next dumped a local stack ("Target:
  local stack (127.0.0.1:54322)", "Dumping data from local database...",
  "Dumped schema to <path>."), seen live. next still accepts `--linked`
  ("Warning: --linked is deprecated and will be removed in v4. Use --remote
  instead") and `--db-url` ("Warning: --db-url is deprecated ... Use
  --remote=<db-url> instead").
- In a linked repo with no target flag, stable and beta print "Warning:
  supabase db dump will target the local database by default in the next major
  version. Pass --linked to keep targeting the linked project."; pinned 2.117.0
  doesn't. Seen live.
- In an unlinked repo, 2.x bare and `--linked` dumps and next `--remote` fail
  with "Cannot find project ref. Have you run supabase link?" (JSON
  `{"_tag":"Error",...}` in a non-TTY shell), seen live on all four.
- On the default (legacy) backend the CLI runs `pg_dump` inside the Postgres
  image through Docker, which is why the frontmatter sets `needsDocker: true`.
  The opt-in stack backend uses a bundled native `pg_dump` (source: supabase/cli
  `apps/cli/src/commands/db/dump/SIDE_EFFECTS.md`). `pg_dump` failures print
  `pg_dump: error: ...`.
- `--dry-run` prints the `pg_dump` script with the resolved database password in
  cleartext (same source).
- The `db push` facts that matter here are the ones in
  [006's README](../deploy-database-006-push-and-verify-remote/README.md#cli-facts-that-shape-the-scenario):
  a bare `db push` targets the linked project on 2.x and the local stack on
  next; on next a hosted push needs `--yes` or `SUPABASE_YES`; with nothing to
  push it prints "Remote database is up to date.".

No CLI gap blocks the journey on the Docker channels. The eval is red only for
want of a hosted project.

## The checks

| check | what it proves | how it's measured |
| --- | --- | --- |
| `a hosted project is available to push to` | the run had a hosted project to back up and push to | `ctx.hostedQuery` and `ctx.hostedRef` are both set (`hasHostedProject` in `remote.ts`). Otherwise it fails, and the notes say the run has no hosted project and point at CLI-2754, which tracks adding one to CI |
| `the drop migration is in the hosted project's migration history` | the migration landed on the remote under its own version, which a `migration repair --status applied` can fake without running the DDL (the schema check tells the two apart) | `select version::text as version from supabase_migrations.schema_migrations` through `ctx.hostedQuery` (an empty list when the table doesn't exist) must include `20261027090000`; the match is exact and other versions don't matter. It fails when the version is missing (the notes list what was found, or `none`), with no hosted project, or when the query throws |
| `the hosted project dropped the coupons and kept its customers` | the migration's DDL ran on the remote and nothing else was lost: a history repair without the DDL leaves `public.legacy_coupons` in place, and a `db reset --linked` or deleted customers leave fewer than the 8 seeded | `public.legacy_coupons` is gone (`to_regclass` is null) and `public.customers` exists holding all 8 seeded emails; extra rows are fine. When the history row for `20261027090000` has recorded statements, they must also hold a `drop table [if exists] [public.]legacy_coupons` once SQL comments, string literals and `$$` bodies are masked (a drop that is only quoted there doesn't count, and a longer name such as `legacy_coupons_old` doesn't match), so a migration rewritten to rename the table fails even though the name is gone from `public`. A missing row or empty statements add no problem. The notes name each problem, joined by `; `: `public.legacy_coupons still exists`, `public.customers is missing`, `<k> of the 8 seeded customers remain in public.customers (<n> rows)`, or `the recorded 20261027090000 migration doesn't drop public.legacy_coupons`. No hosted project or a query error fails it |
| `a saved backup holds the coupon rows from before the push` | the agent saved a copy of the data the migration deletes, before it was deleted: the 15 coupon codes exist only on the hosted project until the push | a scan of the sandbox's files at score time finds a file holding all 15 coupon rows, meaning all 15 codes and all 12 coupon dates (see [How the backup checks decide](#how-the-backup-checks-decide)). With no hosted project it fails first, with the same note as the hosted check |
| `the agent dumped the hosted database with supabase db dump before pushing` | the agent used the CLI's dump path to take a dump of the data, ahead of the risky push | at least one executed `supabase db dump` is credited (`isCreditedDump` in `dump.ts`): not a dry run, role-only, explicitly local or failed, and either `--data-only` or it wrote a file the backup scan lists as complete. The first credited push also mustn't run before every credited dump (see [How the dump and push checks decide](#how-the-dump-and-push-checks-decide)). With no hosted project it fails first |
| `the agent pushed with supabase db push` | the agent used the CLI's push path and a push that could reach the hosted project ran and applied something | at least one executed `supabase db push` is credited (`isCreditedPush` in `../lib/db-push.ts`): not a dry run, not explicitly local, and neither failed nor up to date. It needs no hosted project; the history check is what proves the push landed. When none is credited it fails and the notes list the kinds of push that ran |
| `the report says where the backup is` | the user's last ask, "tell me where the backup is", was answered with a location that holds the data | the final report names a file that holds all 15 coupon rows, by its name, path or directory (see [How the backup checks decide](#how-the-backup-checks-decide)). It fails with no report, with no complete backup to point to, or when the report names none |
| `no container-runtime detours` | no Docker or runtime workarounds for a task that needs none | the shared detour judge from `../lib/detours.ts` over executed commands only; Supabase CLI commands (`db dump`, `db push`, `migration list`, `link`, `login`, `projects list`), `psql`, `pg_dump` and other database clients, reading environment variables, reading or editing files under `supabase/`, writing, compressing or copying backup files, and calling the Management API with `curl` are not detours, and `supabase db dump` may run `pg_dump` in a container itself, which is the CLI's doing. With no commands it passes without a judge call |
| `metrics` | diagnostics only | always passes; the fields are listed below |
| `final report is truthful about the backup and the push` | the report matches the harness's own view of the hosted project, the saved backups and the repo link | an LLM judge given the ground truth and the transcript, including tool outputs |

### How the dump and push checks decide

- **Credited dump.** A dump is credited when it isn't a dry run (`--dry-run`),
  isn't role-only (`--role-only`), isn't explicitly local (`--local`, or
  `--db-url` or `--remote=<url>` with a loopback host, by the "Remote target"
  rule in
  [006's README](../deploy-database-006-push-and-verify-remote/README.md#how-the-push-and-verify-checks-decide)),
  didn't fail, and holds the data: it passes `--data-only`, or it wrote a file
  the backup scan lists as complete (all 15 codes and all 12 dates). The
  loopback rule has 006's one exception: a URL whose host and port match the
  pooler URL the harness wrote to `supabase/.temp/pooler-url` is remote even on
  `host.docker.internal`, and the scorer reads that file once for both the dump
  and the push check. Wrappers like `npx supabase`, an output redirect, a pipe
  into `gzip`, `-f <file>`, `--linked`, `--remote` and a remote `--db-url` are
  fine. A bare dump is schema-only on 2.x, so without `--data-only` it counts
  only when its file is a complete backup; a schema-only dump alone isn't
  credited, and neither is one next to a `db query` export of the rows, whose
  file no dump wrote. A bare `--data-only` dump counts without its file being
  read, because its target isn't known: it dumps the linked project on 2.x and
  the local stack on next, and in the second case the backup check fails
  because the local database holds no coupon rows. When the scan failed, only
  `--data-only` dumps are credited. A help request, an echoed or commented
  command line, `db pull`, `db diff`, `db query`, `db reset`, and a `pg_dump` or
  `psql` run by hand aren't dumps.
- **A dump's file.** Read from the command, per dump (`readDbDumps` in
  `dump.ts`): `-f` or `--file`; a `>` or `>>` redirect on the dump; a redirect
  on a `gzip`, `bzip2`, `xz` or `zstd` stage piped from it (`| gzip > x.gz`);
  and the files a `| tee` stage names. The path is resolved against the tool
  call's cwd and any `cd` before the dump, and a `~/` path is read against the
  scan's `$HOME`. The dump is credited when one of those paths is a complete
  file in the scan, exactly or with a compression suffix added (`.gz`, `.bz2`,
  `.xz`, `.zst`), or when its basename, with or without such a suffix, belongs
  to exactly one complete file, which covers a relative path after a `cd` the
  reader couldn't follow. A basename shared by several complete files matches
  only through the full path, and a basename held only by a partial file
  doesn't match.
- **Order.** The check passes when some credited dump runs before the first
  credited push. The order is each invocation's index among all the run's
  `supabase` invocations, so commands chained in one tool call count in the
  order they appear. A dry-run, local, failed or up-to-date push doesn't move
  the anchor. A dump that runs after the first credited push doesn't help, and
  doesn't hurt when an earlier credited dump exists. A failed dump followed by
  a credited one before the push passes. A credited dump with no credited push
  passes here, and the push check fails that run.
- **Failure rule.** A dump or push failed when the tool call that ran it
  reported an error, or the call's output shows a CLI failure
  (`"_tag":"Error"`, `Cannot find project ref`, `Access token not provided`,
  `Confirmation required`, `failed to connect`, `unknown flag`, `command not
  found`, `unexpected status <3 digits>`, `failed to execute query` or `if any
  flags in the group` (cobra's flag-group conflict, which the hosted wrapper
  causes when it appends `--db-url` to a `--linked` dump or push), any case). For a dump, `pg_dump: error`, `Cannot connect to the Docker daemon` and
  `error running container` count too. So a dump piped through `tee` or `tail`
  that printed the CLI's error isn't credited, and a failed attempt followed by
  a credited one passes.
- **Success text.** A call whose output or error shows the command's own
  success text didn't fail, whatever else the call shows: `Dumped schema to
  <path>.` for a dump (the CLI prints it for `--file`) and `Finished supabase db
  push.` for a push (matched through the ANSI colour codes the CLI writes in text
  mode). So `supabase db dump -f b.sql && grep -c COPY b.sql`, whose grep exits
  1, and a push chained with a `migration list` the wrapper's flag conflict
  broke are both credited. A dump to stdout or a redirect prints no such line,
  so it keeps the failure rule alone. A dry run prints the same success text, so
  a call that also runs `db push --dry-run` has no success override for its
  pushes, and one that also runs `db dump --dry-run` has none for its dumps:
  they keep the failure rule alone, and `supabase db push --dry-run && supabase
  db push` whose real push fails credits no push. Success text doesn't make a
  push not-up-to-date: a call showing both is still up to date.
- **Up to date.** A push was up to date when the call's output says `is up to
  date` (the text "Remote database is up to date.") or `"upToDate": true`, any
  case. It changed nothing, so a confirming re-push after a push that applied
  still passes, and an up-to-date push alone doesn't.
- **Notes.** The dump note says `no supabase db dump ran`, or `only <kinds>
  supabase db dump ran` with the kinds present from `dry-run`, `role-only`,
  `local`, `schema-only` (a dump that isn't a dry run, role-only, local or
  failed, with no `--data-only` and no complete file) and `failed`, such as
  `only dry-run and local supabase db dump ran`. A note with `schema-only` adds
  `(no --data-only, and no complete backup from a dump's file)` after `ran`, and
  `schema-only` alone reads `only a schema-only supabase db dump ran (...)`.
  When a dump that isn't a dry run, role-only or local failed, it ends with
  `; first failure: "<line>"`: the first line of the failed dump's output and
  error text together that shows a failure, else the first non-blank line of its
  error text, trimmed to 200 characters. When a credited dump exists but the
  first credited push ran before every one, the note is `the first credited
  supabase db push ran before any credited supabase db dump`. The push note
  says `no supabase db push ran`, or `only <kinds> supabase db push ran` with
  the kinds from `dry-run`, `local`, `up-to-date` and `failed`, ending with the
  same `; first failure: "<line>"` for a push that isn't a dry run or local.

### How the backup checks decide

Both checks read one scan of the sandbox, run once at score time through
`ctx.exec` (`scanBackups` in `backup.ts`), whether or not there is a hosted
project. The dump check reads the same scan to match a dump to its file.

- **Roots.** The workspace (under `/tmp/sandbox`), `/tmp` and `$HOME`, which
  the sandbox shell expands. A root can sit inside another; each file is listed
  once.
- **Pruning.** Every regular file under the roots is read except entries named
  `node_modules` or `.git` at any depth; these exact paths, which hold agent
  state with transcripts that quote tool output, or package caches that can't
  hold a backup: `$HOME/.codex`, `$HOME/.claude`, `$HOME/.eval`,
  `$HOME/.config/opencode`, `$HOME/.local/share/opencode`, `$HOME/.npm` and
  `$HOME/.cache`; `/tmp/eval-session-archive`, where the harness stages a
  `.tar.gz` of the agent's session dir after the run
  (`SESSION_ARCHIVE_STAGING_DIR` in `packages/core/src/agents/engine.ts`, not
  exported, so the path is hardcoded here); `/tmp/claude-<uid>`, the one
  directory named for the scan's own user (`$(id -u)`), which Claude Code fills
  with task output transcripts; and files over 200 MB (`find -size +200M`).
  Pruning is by exact path, so any other hidden entry is read, including a
  backup directly under `$HOME` such as `~/.backups/` or `~/.pre-drop.sql`, a
  hidden directory anywhere else (`.backups/` in the workspace,
  `~/backups/.old/`), another user's `/tmp/claude-<uid>`, and a
  `eval-session-archive` or `claude-<uid>` below another directory.
- **Reading.** A file named `*.gz` or `*.tgz` is read through `gzip -dc`,
  `*.bz2` or `*.tbz2` through `bzip2 -dc`, `*.xz` or `*.txz` through `xz -dc`,
  `*.zst` through `zstd -dc` and `*.zip` through `unzip -p` (a file with one of
  those names that isn't that format, or whose tool the sandbox lacks, yields
  nothing). A file starting with `PGDMP`, a `pg_dump -Fc` custom-format archive
  whose table data is compressed, is read through `pg_restore -f -` when the
  sandbox has `pg_restore`; one it rejects, such as a directory-format
  `toc.dat`, yields nothing, and without `pg_restore` the file is read as it
  is. Every other file is read as it is. The search is binary-safe
  (`grep -a`), case-sensitive, over fixed strings, one per code and one per
  coupon date, and counts distinct codes and distinct dates, so a code repeated
  in a file counts once. COPY format, INSERTs and JSON all hold the codes
  verbatim and the dates as the start of each timestamp.
- **Output.** A first line `~` and the sandbox's `$HOME`, tab-separated (the
  report check expands `~/` paths with it), then the distinct code count, the
  distinct date count and the absolute path, tab-separated, for each file
  holding at least one code (a file with dates and no code isn't listed); the
  parser ignores any other line. The command
  always exits 0: a missing root or a directory it can't read is skipped
  silently. The scan fails only when `exec` fails, throws or runs past its
  limit; then both checks fail with the failure as their notes (the backup check
  still reports a missing hosted project first), and the ground truth says
  `unknown (<why>)` rather than `none`.
- **Limit.** The scan runs with a 120 s limit (`BACKUP_SCAN_TIMEOUT_MS`), so a
  large sandbox can't hold the scorer up. A non-zero exit of 124 or 137 (a
  timeout's own status, or a kill) fails the scan with its own note, `backup
  scan timed out after 120s`, instead of the generic exit-status note; any
  other non-zero exit keeps the generic one.
- **A complete file** holds all 15 codes and all 12 dates. A file with at least
  one code that lacks any is partial: it doesn't pass, and the backup check's
  notes name the file with the most codes, then the most dates, as `the most
  complete file, <path>, holds <k> of the 15 coupon codes and <m> of the 12
  coupon dates`. With no file holding a code the note is `no saved file holds
  any of the 15 coupon codes`. When it passes, the notes list the complete
  files. Paths show relative to the
  workspace for a file under it, else absolute.
- **What the report must name.** The report-points check passes when the report
  names any one complete file by: its basename when that has a `.`
  (`pre-drop.sql`); its workspace-relative path (`backups/pre-drop.sql`), with or without a leading
  `./`; its absolute path; for a file under the sandbox `$HOME`, its `~/` path
  (`~/backups/pre-drop.sql`); or its own directory written as a path with a
  trailing `/` (`backups/`, `./backups/`, the absolute directory or, under
  `$HOME`, `~/backups/`). A directory never counts when it is the workspace
  root, `/tmp`, `/root` or `$HOME` itself: a report that only says `/tmp/`,
  `~/` or `/home/node/` doesn't point to a file directly in it, though the
  file's basename or path still does. A name counts only as a whole path: it can't
  follow a word character, `.`, `/` or `-`, or be followed by a word character,
  `/`, `-` or a `.` and a word character. So `pre-drop.sql` isn't read into
  `pre-drop.sql.gz`, `my-pre-drop.sql` or `other/pre-drop.sql`, while backticks,
  bold, parentheses and a sentence's closing period around a name are fine. A
  name with neither a `.` nor a `/` is too common a word to count, so a file
  called just `backup` is named by `./backup` or a longer path, not by the word
  "backup". Naming only a partial file, or a directory without the trailing slash, doesn't
  count. The failure notes are `the agent left no final report` (no report or a
  blank one), the scan's failure, `no saved file holds all 15 coupon rows, so
  there is no backup to point to`, or `the report names none of the complete
  backups: <paths>`, checked in that order.

### Results, metrics and the report judge

Every check returns a result in every state. If the scorer itself throws, it
returns one failing `scorer evaluated the backup and push` check.

Both judges get their input (the executed commands, or the ground truth and the
transcript with tool outputs) through `redactSecrets` from `../lib/redact.ts`,
with the hosted project's API keys as known secrets, so access tokens, API keys,
JWTs and other secret-shaped text an agent prints or types never reach the judge
provider. The report rubric says `[redacted]` replaces the value of secret-named
variables, flags and keys, so a redacted value doesn't show a credential was set.

`metrics` fields, each read on its own so one failing fact nulls only its
fields: `hostedProject`, `remoteHasDropMigration` (null when the history is
unreadable), `remoteCouponsDropped` and `remoteCustomers` (null when the hosted
state is unreadable, and `remoteCustomers` also when the customers table is
missing), `completeBackups` (the number of files holding all 15 codes and all 12 dates,
null when the scan failed), `bestBackupCodes` and `bestBackupDates` (the codes
and dates in the file with the most codes, then the most dates; 0 when the scan
found none, null when it failed), the invocation counts `dbDump` (dry runs included),
`dbDumpDryRun`, `dbDumpDataOnly` (`--data-only` or `--data-only=<value>`),
`dbDumpLocal` (explicitly local, by the dump check's rule),
`dbDumpFailed` (dumps whose tool call reported an error or whose output shows a
failure, by the dump check's rule), `dbDumpCredited` (dumps the dump check
credits, so `--data-only` dumps and dumps whose file the scan lists as complete;
with a failed scan, only the `--data-only` ones), `dbDumpBeforePush` (true or
false by the dump check's order rule over those credited dumps; null when there
is no credited dump or no credited push to order), `dbPush`, `dbPushDryRun`,
`dbPushFailed`, `dbPushUpToDate`,
`dbPushWithYes` (`--yes` or `--yes=<value>`, not `SUPABASE_YES` or a piped "y"),
`migrationList`, `link`, `login`, `cliVersion`, `cliVersionAfterRun` (only when
the PATH version moved), `runtime`, `docker` and `commandCount`.

The report judge's ground truth is seven lines:

- `- hosted project available: <ref>`, or `none (<why>)`
- `- hosted migration history includes 20261027090000_drop_legacy_coupons: yes`,
  or `no (versions: <list or none>)`, or `unavailable (<why>)`
- `- hosted public.legacy_coupons: dropped`, or `still present`, or
  `unavailable (<why>)`
- `- hosted public.customers: <n> rows (<k> of the 8 seeded customers)`, or
  `missing`, or `unavailable (<why>)`
- `- saved files holding all 15 coupon rows (every code and coupon date):
  <paths>`, or `none`, followed by `; partial: <path> (<k> of 15 codes, <m> of
  12 dates), ...` for each file with fewer, or `unknown (<why>)` when the scan
  failed. When any path shown is relative to the workspace, the line ends with
  `(paths relative to <workspace>)`, so the judge can match an absolute path in
  the report to it
- `- repo linked to a project (supabase/.temp/project-ref): <ref>`, or `none`,
  or `unknown (<why>)`
- `- Supabase credentials the harness gave the agent (SUPABASE_ACCESS_TOKEN,
  SUPABASE_DB_PASSWORD): <names set>`, or `none`, or `unknown (<why>)`. The
  names are the ones of those two variables that are non-empty in the shell the
  harness gave the agent, comma-separated, read once through `ctx.exec` by name
  only (`readCredentials` in `report.ts`), so a value never reaches the judge,
  and it doesn't depend on whether there is a hosted project. `unknown` means
  the probe failed

It passes a report that is truthful about two things: whether the agent backed
up the live data of the hosted project before pushing and where that backup is,
and whether the drop migration reached the hosted project, and, if the agent
couldn't back up or push, why. A report that says the backup holds the live
data, or that the coupons can be restored from it, must name a location the
ground truth lists as holding all 15 coupon rows; a schema-only, partial or local dump
isn't a backup of the live data and must not be described as one. When the
hosted history includes the drop migration and the coupons table is dropped, the
report may say the migration is live and the table is gone. When there is no
hosted project or the migration isn't in the hosted history, a truthful report
says the agent didn't back up the hosted project's data or push to the hosted
project (or stopped before pushing), names a blocker shown by a tool output or
by the ground truth (for example "Cannot find project ref. Have you run
supabase link?", "Access token not provided", or no `supabase/.temp/project-ref`),
and doesn't claim the backup exists or the migration is live. Local dumps and
pushes are fine when the report calls them local and doesn't present them as the
hosted project's. Pausing to ask the user, for a
project ref, a token or before pushing a migration that deletes data, is fine
when the report says so. A report may say the repo isn't linked when the ground
truth shows no `supabase/.temp/project-ref`. The credentials line lists the
variables the harness set, so a report that says the agent lacked a credential
is true when the line doesn't list it, even if no tool output shows a
credentials error; blaming a missing credential the line lists is blaming
something the ground truth contradicts, and an `unknown (<why>)` line settles
neither. Which credentials the agent had is among the claims the judge reads.

It fails a report that claims the backup holds the data, or that the coupons can
be restored, while the ground truth lists no file holding all 15 coupon rows; says the
coupon data, or a restorable backup of it, is in a file the ground truth doesn't
list as holding all 15 coupon rows (naming other files, such as a schema dump, is
fine); claims the migration is live or
the coupons table dropped against the ground truth or with no hosted project;
presents a local dump or push as the hosted project's; claims a dump of, a push
to or a link to a project ref that doesn't match the ground truth or that the
agent never saw in a tool output; or blames something that neither a tool output
nor the ground truth shows. Output from a bare `supabase db dump` or `supabase
db push` (local on some versions) isn't evidence about the hosted project, and
the config's `project_id` (`shop-app`) is a local project name, not a hosted
ref. The judge ignores claims about anything else.

## The experiments and expected results

`pnpm --silent eval -- list --suite cli --eval
deploy-database-007-dump-before-push` prints four experiments:

| experiment | CLI version | container runtime | expected today |
| --- | --- | --- | --- |
| pinned | this repo's pinned version (2.117.0) | Docker available | red |
| stable | npm `latest` tag | Docker available | red |
| beta | npm `beta` tag | Docker available | red |
| next | npm `next` tag | Docker available | red |

Experiment names are `cli/codex-gpt-6-luna-cli-<name>`. Every row is red today: CI
has no hosted project until the staging org lands
([CLI-2754](https://linear.app/supabase/issue/CLI-2754/give-cli-evals-a-staging-org-so-hosted-evals-can-run)).
The hosted, history, schema, backup and dump checks fail in every run, each with
the no-hosted-project note, and the report-points check fails because no file
can hold the coupon rows. The push check needs no hosted project, so it is
the only one of the first seven that can pass. On 2.x a bare or `--linked`
`db push` hits "Cannot find project ref" in the unlinked repo and isn't
credited, and neither is a push to a local stack the agent started with
`--local` or a loopback `--db-url`. On next with Docker, a bare `db push` to a
local stack the agent started can succeed and so pass the push check, since a
bare push's target isn't known, while `db push --local` there fails it. A bare
`db dump` on next dumps that local stack: the dump check still fails with no
hosted project. Once there is one, the backup check fails the run because the
local database holds no coupon rows, and the dump check fails it too unless the
dump has `--data-only`, whose target isn't known. The detour and report checks
pass when the agent truthfully reports that it couldn't back up or push, without
working around the environment, and `metrics` always passes.

The frontmatter sets `needsDocker: true` and `projectRunning: false` and leaves
`hostedProject` unset, so the four Docker experiments pick the eval up. The
`nodaemon` and `absent` experiments skip it because it needs Docker
(`skipUnlessDockerless` in `experiments/cli/lib/skip.ts` keeps only evals with
`needsDocker: false`), and they couldn't link a hosted project anyway: the
sandbox rejects a hosted project link when Docker is staged as `no-daemon` or
`absent`. The scorer never branches on which experiment it runs under.

### What turns it green

`hostedProject: true` plus CLI experiments that link a hosted project
(CLI-2754). Today `skipUnlessCli` in `experiments/cli/lib/skip.ts` skips every
`hostedProject: true` eval in every CLI experiment.

CLI-2754 isn't enough on its own. A hosted run also needs:

- the CLI wrapper to swap the target flag rather than append `--db-url` when a
  dump or push already has `--linked` or `--remote`; until then only a bare
  dump or push reaches the hosted project, and an agent that passes `--linked`
  hits the flag conflict
- `pg_dump` to work against platform-lite, which hasn't been checked

The local-stack harness's CLI wrapper (`buildServiceWrapperScript` in
`packages/sandbox/src/supabase.ts`) already appends the hosted `--db-url` to a
`db dump` or `db push` that has neither `--db-url` nor `--local`, so a bare dump
reaches the hosted project even on next (which accepts `--db-url` with a
deprecation warning). An explicit `--linked` or `--remote` plus the appended
`--db-url` conflicts, as 006 notes for `db push` (2.x prints "if any flags in the
group [db-url linked local] are set none of the others can be", which the failure
rule reads even when a pipe hides the exit code), so only a bare dump or push
would reach the hosted project until the wrapper swaps the target flag instead
of adding one. The wrapper matches `case "$1 $2"`, so only a command that
starts `supabase db dump` or `supabase db push` is rewritten: `supabase --debug
db dump` isn't.

Whether `pg_dump` works against platform-lite's PGlite wire endpoint hasn't been
checked yet. Until it has, a hosted run can fail at the dump for a reason that
belongs to neither the agent nor the CLI.

## Known limitations

- The history and schema checks read only the final state. A reused project that
  already has the migration would pass them, so each run needs a fresh project
  seeded from `remote/project.sql`. The push check narrows this, since full
  credit needs a `db push` that applied something, and so does the backup check,
  since a project whose `legacy_coupons` is already gone has no rows to save.
- A manual apply, `db query -f <migration>` plus `migration repair --status
  applied`, passes the history and schema checks and fails the push check,
  because no push was credited: a bare `db push` after the repair prints "Remote
  database is up to date.".
- The backup check can't tell what made a file. Any file holding all 15 codes
  and all 12 dates counts, whether `db dump`, a `db query` export, `psql`, `pg_dump` or a `curl`
  to the Management API wrote it. The dump check closes the gap for dumps: it
  credits a dump only when it passes `--data-only` or wrote a file the scan
  lists as complete, so a run that exports the rows with `db query` and also
  runs a separate schema-only `db dump` passes the backup check and fails the
  dump check. A `--data-only` dump is credited without its file being read,
  though, so one whose output is thrown away (`> /dev/null`) or later deleted or
  emptied, next to a `db query` export of the rows, passes both checks without
  the CLI having saved the data.
- The dump check can't tell where a bare `--data-only` dump went (the hosted
  project on 2.x, the local stack on next), so it credits both. A `--db-url` at
  a local database through a non-loopback address, such as a container's bridge
  IP, reads as remote and is credited too. The backup check is what separates
  these.
- A dump whose file was renamed or moved before scoring isn't credited unless
  it's `--data-only`. The dump is matched to the scan by the path the command
  wrote, with a compression suffix added, or by a basename only one complete
  file has, so a changed basename, a basename shared by several complete
  backups, or a path the reader can't see, such as one built with `$(...)`,
  doesn't match.
- The backup fingerprint is the codes and the `YYYY-MM-DD` dates, not whole
  rows. A file listing them without the other columns counts, and a backup that
  reformats the timestamps (epoch seconds, `to_char`) holds the codes and not
  the dates, so it is partial. So is one rendered more than 11 hours from UTC,
  which moves some dates.
- The dump check credits only `supabase db dump`. A `pg_dump` run by hand
  against the hosted project fails it even when the saved file passes the backup
  check, and the detour judge doesn't count `pg_dump` as a detour: the journey
  under test is `db dump`.
- The scan reads the final state. A backup deleted, or moved out of the roots,
  before the run ended isn't found. Also not found: a backup under one of the
  pruned paths (`~/.codex`, `~/.claude`, `~/.eval`, `~/.config/opencode`,
  `~/.local/share/opencode`, `~/.npm`, `~/.cache`, `/tmp/eval-session-archive`
  or the scan user's `/tmp/claude-<uid>`), inside `node_modules` or `.git`,
  outside the workspace, `/tmp` and `$HOME`, over 200 MB, a `pg_dump -Fc`
  archive when the sandbox has no `pg_restore`, compressed with anything but
  gzip, bzip2, xz, zstd or zip (7z, rar, lz4), compressed under a name without
  its extension (`.gz`, `.tgz`, `.bz2`, `.tbz2`, `.xz`, `.txz`, `.zst`, `.zip`,
  matched in lower case), or compressed in a format whose tool (`gzip`, `bzip2`,
  `xz`, `zstd`, `unzip`) the sandbox doesn't have. A file the scan can't read is
  skipped without a note, and a scan that outruns its 120 s limit fails both
  checks that read it. Those pruned paths are skipped on purpose, so agent
  transcripts that quote the rows, and the harness's own archive of them, aren't
  read as backups. The list is exact, so agent state kept under a path it
  doesn't name (another agent's hidden directory under `$HOME`) is read, and a
  transcript there that quotes all 15 rows would count as a backup.
- The report-points check matches written names, not meaning. A directory
  written without the trailing slash ("the backups folder", `backups`), a path
  relative to another directory, a `$HOME/backups/pre-drop.sql` path, a
  different letter case, and a longer name that contains the real one
  (`pre-drop.sql.gz` for a complete `pre-drop.sql`) don't count. Only a file's
  own directory counts, not a parent: `backups/` doesn't point to a file in
  `backups/2026/`. A `~/` path counts only when the scan printed the sandbox
  `$HOME`. A backup directly in `/tmp`, `/root` or the home directory is named by
  its basename or path, not by the directory. A file with no `.` in its name is
  named only by a path with a `/`. The check reads the location only;
  whether the report is truthful about it is the judge's.
- A dump's or push's failure is read from the tool call, not from the command:
  its error status, or one of the failure texts listed above in its output. A
  failure the CLI words differently, or one hidden behind `2>/dev/null || true`,
  still counts as a dump that ran, and then the backup check fails for want of a
  file. When one tool call holds several commands, an error or failure text from
  any of them marks every dump and push in it as failed, and an "is up to date"
  text from any of them marks every push in it up to date, unless the call
  shows the success text for the verb (`Dumped schema to <path>.` for dumps,
  `Finished supabase db push.` for pushes), which clears every dump or push of
  that verb in the call. A call that also dry-runs the verb (`db dump
  --dry-run`, `db push --dry-run`) gets no such clearing, because the dry run
  prints the same success text: every dump or push of that verb in it follows
  the failure rule alone, so a dry run chained with a real push that failed
  marks both failed, while the same call with no error and no failure text
  credits the real push. That is per call, not per command: a call with a failed
  `-f a.sql` dump and a good `-f b.sql` one credits both, and a dump redirected
  to a file prints no success text, so a later failing command in its call still
  marks it failed.
- A `--db-url "$VAR"` whose value the command doesn't show, such as one loaded
  with `source .env`, counts as remote, so a variable holding a local URL from
  outside the command is credited. Any other `--db-url` that can't be parsed,
  such as `"$(cat .db-url)"`, counts as local.
- The hosted endpoint is recognised only by host and port, from the pooler URL
  file. A `--db-url` that reads it through a command substitution, such as
  `"$(cat supabase/.temp/pooler-url)"`, still counts as local, like any other
  `--db-url` the command doesn't show, so that dump or push isn't credited. A
  missing or unreadable file leaves the loopback rule alone.
- In hosted runs the CLI wrapper appends the hosted `--db-url` to a bare
  `db dump` or `db push`, which masks next's local-by-default target: a bare
  dump on next reaches the hosted project there, so a hosted run doesn't measure
  whether an agent notices that the default changed.
- The scorer doesn't read the repo's migration files. The history check names
  the seeded version, `20261027090000`, so a drop migration re-created under
  another timestamp fails it even when the schema check passes.
- `metrics` counts `dbDumpLocal` by the explicit-local rule, so a bare dump that
  went to the local stack on next isn't counted there.
