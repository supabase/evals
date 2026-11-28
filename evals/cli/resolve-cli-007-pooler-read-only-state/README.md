# resolve-cli-007-pooler-read-only-state

These evals are part of the docUrl A/B set (`resolve-cli-002` to `resolve-cli-004`, and the harder round `resolve-cli-005` to `resolve-cli-007`). They test supabase/cli#7749 (https://github.com/supabase/cli/pull/7749). That change adds `error.docUrl` to the JSON error output, and a `Learn more: <url>` last line to the text output, when the error code has a troubleshooting article.

## Scenario

The project enables the local transaction pooler (Supavisor, port 54329, `services: [supavisor]`). The nightly report, `scripts/nightly-report.sql`, runs `set default_transaction_read_only = on` as a session setting. The pooler returns that backend connection to the pool with the setting still on. The next job, the signup insert (`scripts/add-order.sql`), then fails with `25006`: `cannot execute INSERT in a read-only transaction`.

The local stack is already running. The prompt gives the pooler connection string and the two commands, in order. It never names the error code, the article, the setting, or the fix.

## Article

https://supabase.com/kb/troubleshooting/resolving-cannot-execute-update-in-a-read-only-transaction-on-transaction-pooler-connections

The article explains that the transaction pooler keeps session state on the backend connection. It says to move read-only intent into the transaction (`begin transaction read only`), to reset the setting on connections that already carry it, or to connect directly for scripts that need session state.

## Why it is hard

Two things must be right. The script needs a fix that leaves no session state behind, and the backend connections that the earlier run already contaminated need a reset. The obvious fixes each fail one part. A manual reset leaves the script to contaminate the pool again at the next run. Deleting the read-only setting from the report removes the safety guard, and the scorer fails it. Moving the signup to the direct port changes the job and does not clear the pool.

## Checks

All checks gate `passed`.

- `local stack is running for this project`
- `the seeded orders are still there`
- `the report script still asks for read-only`: the script must still mention read-only mode and still read `public.orders`.
- `the signup insert works through the pooler after each report run`: the scorer first runs the signup insert alone through the pooler. This finds a backend that an earlier run left read-only. Then it runs the workspace report script and the signup insert, in that order, four times. Each insert is rolled back.

The metrics `read_doc_url` and `saw_doc_url` ride along as checks that always pass. See the README of `resolve-cli-002-sequence-out-of-sync` for how they work. The evals carry `customMetadata.abGroup: cli-docurl`, so only the `*-cli-docurl-off` and `*-cli-docurl-on` experiments run them.
