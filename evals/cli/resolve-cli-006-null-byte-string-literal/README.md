# resolve-cli-006-null-byte-string-literal

These evals are part of the docUrl A/B set (`resolve-cli-002` to `resolve-cli-004`, and the harder round `resolve-cli-005` to `resolve-cli-007`). They test supabase/cli#7749 (https://github.com/supabase/cli/pull/7749). That change adds `error.docUrl` to the JSON error output, and a `Learn more: <url>` last line to the text output, when the error code has a troubleshooting article.

## Scenario

A migration from the "old import pipeline" sets `standard_conforming_strings = off` on the database. The scanner importer generates `scripts/register-asset.sql`, which inserts the path `'C:\0ps\raw\scan-002.tif'`. With the setting off, `\0` is an octal escape for a null byte, and the insert fails with `22021`: `invalid byte sequence for encoding "UTF8": 0x00`.

The local stack is already running. The prompt gives the CLI command that fails and says the script must stay exactly as it is. It never names the error code, the article, the setting, or the fix.

## Article

https://supabase.com/kb/troubleshooting/error-invalid-byte-sequence-for-encoding-utf8-0x00-when-accessing-triggers-or-webhooks

The article is written for the Dashboard Triggers and Webhooks pages, not for scripts. It says the error means `standard_conforming_strings` is `off`, and gives `alter database postgres set standard_conforming_strings = on`.

## Why it is hard

The error message points at a null byte, not at a setting. The cause sits in a database-level default that a fresh session picks up, so `show standard_conforming_strings` in the same session is the first place a diagnosis can find it. The obvious fix is to escape the backslashes in the script. The prompt forbids that, and the scorer fails an edited script. Quoting tricks in the data change what the importer stores.

## Checks

All checks gate `passed`.

- `local stack is running for this project`
- `the seeded asset is still there`
- `the registration script is unchanged`: the workspace file must match the fixture.
- `the script registers the path with its backslashes as written`: the scorer runs the script in a fresh psql session, in a transaction that it rolls back, and compares the stored path with the literal text.

The metrics `read_doc_url` and `saw_doc_url` ride along as checks that always pass. See the README of `resolve-cli-002-sequence-out-of-sync` for how they work. The evals carry `customMetadata.abGroup: cli-docurl`, so only the `*-cli-docurl-off` and `*-cli-docurl-on` experiments run them.
