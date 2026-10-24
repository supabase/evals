# Recover hosted Supabase migration history

Use this guide when `supabase db push` reports that local migration files and the linked project's migration history do not match. A migration file is executable SQL in your repository; the remote history table records which migration timestamps Supabase considers applied. Correcting one does not automatically correct the other.

## Prerequisites

- Run commands from the repository containing `supabase/config.toml` and `supabase/migrations/`.
- Install a Supabase CLI version supported by the project and authenticate with `supabase login`.
- Confirm the intended project reference in the Supabase Dashboard. Check that it matches the project's CLI link before any remote command. If linking fails, do not assume the existing link is correct; verify the target through the Dashboard and restore a working connection before changing remote state.
- Have permission to inspect the remote schema and migration history, and coordinate with the team so another deployment is not pushing concurrently.
- Ensure the migration files are current and committed or otherwise safely backed up. Before changing production history or schema, make an appropriate database backup and know how to restore it.
- If the CLI cannot connect or the remote schema cannot be inspected, do not repair history or push based on a guess. Use the network recovery steps below to regain an authorized inspection path; if that remains unavailable, pause and ask the database owner to investigate.

## Compare local files with remote history

First confirm the working directory, project link, and local migration files. Restore missing files from the intended branch or repository history before changing remote state.

```sh
supabase migration list
supabase db push --dry-run
```

`migration list` compares local migration timestamps with the linked project's recorded history. The dry run previews what `db push` would do and does not apply migrations. Read both outputs. A version shown only on remote means the history contains a timestamp with no corresponding local file; a version shown only locally is a local migration not recorded as applied remotely. Neither mismatch alone establishes what SQL is present in the live schema.

## Recover an inspection connection

A linked-project command can fail before it reads the database. An IPv6 compatibility error is a connection-path problem, not evidence that a migration ran or did not run. Supabase direct database endpoints use IPv6 by default. To investigate:

1. Confirm the project reference in the Dashboard. In the project's **Connect** dialog, inspect the connection methods available for that project.
2. If the machine or network cannot reach IPv6, use an IPv6-capable network or a connection method supported by the client and available to your project. The shared Supavisor session pooler is an IPv4-capable option; copy its host, port, and username from **Connect** rather than constructing them. Use the database password securely and do not paste a connection string containing credentials into logs, source files, or chat.
3. If the CLI still cannot connect, use the Dashboard's SQL Editor for read-only inspection, or ask an administrator with an authorized database connection to run the checks below. Do not mark the inspection complete merely because `supabase link` succeeds; run a query and confirm it reaches the intended project.
4. Retry the CLI dry run only after connection and project identity are confirmed. A CLI parsing, authentication, link, or network error must be resolved separately from the migration mismatch.

The SQL Editor and commands here are inspection aids. Replace example timestamps and object names with values from your repository and deployment records.

```sql
-- Inspect migration versions recorded by the target project.
select version
from supabase_migrations.schema_migrations
order by version;

-- Inspect relevant columns in the application schema.
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
order by table_name, ordinal_position;
```

Compare those results with the actual SQL and intended effects of each mismatched local migration. Schema shape alone may not show whether data transformations, functions, triggers, or other side effects ran. Consult reviewed deployment records and inspect any relevant data or database objects before choosing a history repair.

## Choose a repair from the confirmed database state

Do not treat a CLI recovery suggestion as proof of the schema state. For every mismatched timestamp, identify the corresponding SQL from source control, deployment records, or a reviewed remote inspection. If you cannot establish what actually ran, stop and ask the database owner to investigate.

### Remote history has a version with no local file

1. Check whether the file was omitted by an incomplete checkout, branch, or merge. Restore the original migration if available; preserve its original timestamp and SQL rather than creating a different migration with the same intended change.
2. If the SQL ran and the resulting schema is present, recover the migration file when possible so the repository remains reproducible. If the original file is unavailable, inspect and back up the remote state, then capture the current remote schema with `supabase db pull`. Review the generated migration carefully, commit it, and compare the resulting history before proceeding. A pulled schema snapshot is not necessarily a substitute for the original migration's data transformations or other side effects.
3. Only when investigation confirms the recorded migration did not run and its schema changes are not present or required should you mark that history entry reverted. `migration repair` removes the history record; it does not undo SQL or restore data.

### A local migration is absent from remote history

Determine whether its SQL is already present remotely. If it is present and the migration's intended effects are complete, mark the version applied to prevent re-running it. If it is not present, leave it pending for `db push` to apply. If only some statements ran, assess and repair the partial schema/data state deliberately before deciding; marking it applied or blindly replaying it may leave damage or fail.

### Apply a history correction only after inspection

Use the exact timestamp from the migration filename or history listing. These are adaptable examples; replace the timestamp with the version you investigated and ensure the connected project is the intended target.

```sh
# Record a migration as applied only when its intended effects are already present.
supabase migration repair --status applied <migration-timestamp>

# Remove an applied history record only when investigation confirms it did not run.
supabase migration repair --status reverted <migration-timestamp>
```

Repair updates `supabase_migrations.schema_migrations` metadata only. It does not execute, reverse, or validate migration SQL. Do not use `--yes` to bypass review when the target or state is uncertain.

## Preview and deploy pending migrations

After any correction, compare the history again and inspect the dry-run plan. Confirm every pending migration file is expected, ordered correctly, and safe for the target database. Review destructive operations, data changes, locks, and application compatibility; prepare an appropriate rollout for changes that may block live traffic.

```sh
supabase migration list
supabase db push --dry-run
```

Proceed only when the connected target and preview are correct:

```sh
supabase db push
```

Coordinate a single deployer for the project so concurrent pushes cannot race. If the dry run still reports an unmatched version or unexpected change, stop and investigate rather than repeating repair commands.

## Verify independently

After the push completes, check migration history and ask the CLI for another dry run:

```sh
supabase migration list
supabase db push --dry-run
```

Confirm that the expected local versions appear on the remote and that the dry run reports no pending migrations. Then use the Dashboard SQL Editor or another authorized SQL connection to verify the important schema and data effects on the intended project. Run an application-level check appropriate to the change. A clean migration list and dry run establish migration tracking agreement; they do not prove application behavior or data correctness. Record the project checked and the verification results without exposing credentials.

If commands fail because of network, IPv4/IPv6, authentication, project-link, or CLI parsing errors, diagnose that connection/tooling problem separately. Do not interpret such an error as evidence for either migration repair status.