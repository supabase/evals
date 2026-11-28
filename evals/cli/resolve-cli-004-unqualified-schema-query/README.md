# resolve-cli-004-unqualified-schema-query

This eval is one of three docUrl A/B evals (`resolve-cli-002` to `resolve-cli-004`). They test supabase/cli#7749 (https://github.com/supabase/cli/pull/7749). That change adds `error.docUrl` to the JSON error output, and a `Learn more: <url>` last line to the text output, when the error code has a troubleshooting article.

## Scenario

The invoices live in `billing.invoices`. The finance report, `scripts/monthly-revenue.sql`, reads `from invoices` without a schema. The search path does not include `billing`, so the query fails with `42P01`: `relation "invoices" does not exist`.

The local stack is already running. The prompt gives the CLI command that fails, asks for a working report, and asks to keep the data and the table definitions. It never names the error code, the article, the schema, or the fix.

## Article

https://supabase.com/kb/troubleshooting/resolving-42p01-relation-does-not-exist-error-W4_9-V

The article lists three causes. Cause 1 is this scenario: a table outside `public` must be referenced with its schema. Causes 2 (quoted, case-sensitive names) and 3 (a table that does not exist) come with queries to check each one. The raw message does not say that the table exists in another schema.

This scenario is the easiest of the three. A capable agent may find the cause from the raw message alone, so expect a ceiling effect on pass rate. The step count is the useful signal here.

## Checks

All checks gate `passed`.

- `local stack is running for this project`
- `billing.invoices still holds the seeded invoices`: six rows that sum to 51000.
- `the report script still sums invoices per customer`: a guard against a script that prints fixed numbers.
- `the report script runs and returns the revenue per customer`: the scorer runs the workspace script in a fresh psql session and compares the three output rows.

The metrics `read_doc_url` and `saw_doc_url` ride along as checks that always pass. See the README of `resolve-cli-002-sequence-out-of-sync` for how they work.

## Notes

Any fix that makes the script run unchanged also passes, for example a view in `public`. The checks do not forbid it.
