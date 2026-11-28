# resolve-cli-002-sequence-out-of-sync

This eval is one of three docUrl A/B evals (`resolve-cli-002` to `resolve-cli-004`). They test supabase/cli#7749 (https://github.com/supabase/cli/pull/7749). That change adds `error.docUrl` to the JSON error output, and a `Learn more: <url>` last line to the text output, when the error code has a troubleshooting article.

## Scenario

The `customers` table uses `id serial primary key`. The seed inserts five customers with explicit ids, so the sequence still starts at 1. The signup job runs `scripts/add-customer.sql`, an insert without an id. The first `nextval` returns 1 and the insert fails with `23505` (`duplicate key value violates unique constraint "customers_pkey"`).

The local stack is already running. The prompt gives the CLI command that fails and states the goal only. It never names the error code, the article, or the fix.

## Article

https://supabase.com/kb/troubleshooting/inserting-into-sequenceserial-table-causes-duplicate-key-violates-unique-constraint-error-pi6DnC

The article says the sequence is out of sync after a bulk import. It gives the diagnosis (`select max(id)` and `nextval(pg_get_serial_sequence(...))`) and the fix (`setval` to the maximum id plus one). The raw Postgres message names the duplicate key but not the sequence, so the article adds the cause and the fix.

## Checks

All checks read the live database and gate `passed`.

- `local stack is running for this project`
- `the seeded customers are still there`: the five seeded ids and emails are unchanged.
- `a new customer can be added without an id`: two inserts in the shape of the signup job, in a rolled-back transaction, succeed. This holds for any fix that moves the sequence, and fails for an edit of the script alone.

Two metrics ride along as checks that always pass. Their value is in the notes.

- `read_doc_url`: `true` when a tool call read the article above. The scorer counts a `web_fetch`, a Codex page open, and a `curl` or `wget` call whose command contains the URL (the `.md` page counts). It never gates `passed`.
- `saw_doc_url`: `true` when the URL appears in the output of a shell command, as when the CLI prints it. It is `true` in the "on" arm only.

The framework already records `stepCount` and `toolCallCount` per run. The A/B compares those between the "off" and "on" arms of one model.

## Running the A/B

The evals carry `customMetadata.abGroup: cli-docurl`. Only the `*-cli-docurl-off` and `*-cli-docurl-on` experiments run them. The scheduled CLI experiments skip them. See `experiments/cli/lib/docurl-pair.ts` for the two CLI versions.

This eval has no LLM judge, so a run is cheap and the result is deterministic.
