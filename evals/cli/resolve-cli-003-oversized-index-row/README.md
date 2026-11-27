# resolve-cli-003-oversized-index-row

This eval is one of three docUrl A/B evals (`resolve-cli-002` to `resolve-cli-004`). They test supabase/cli#7749 (https://github.com/supabase/cli/pull/7749). That change adds `error.docUrl` to the JSON error output, and a `Learn more: <url>` last line to the text output, when the error code has a troubleshooting article.

## Scenario

The `articles` table has a unique btree index on `body`, so one body cannot be published twice. The editors run `scripts/publish-article.sql`, which inserts a body of about 5 KB. The insert fails with `54000`: `index row size 4816 exceeds btree version 4 maximum 2704 for index "articles_body_key"`.

The body is `md5` hex text, which Postgres does not compress, so the failure is the same on every run. The local stack is already running. The prompt gives the CLI command that fails and states the goal only. It also says the table must keep refusing the same body twice, so a fix that drops the index does not pass. It never names the error code, the article, or the fix.

## Article

https://supabase.com/kb/troubleshooting/error-index-row-size-exceeds-btree-version-4-maximum-for-index-LMmoeU

The article explains the btree row size limit. It says to index a hash of the value instead, with `create index on table_name (md5(column_name))`, and to query with the same expression. The raw message states the limit but not what to do about it.

## Checks

All checks read the live database and gate `passed`.

- `local stack is running for this project`
- `the seeded articles are still there`
- `an article with a 5 KB body can be published`: an insert of the same shape as the script succeeds, in a rolled-back transaction.
- `the same body is still refused a second time`: a repeated long body and a repeated short body both raise a unique violation. An `md5` unique index passes. Dropping the index fails.

The metrics `read_doc_url` and `saw_doc_url` ride along as checks that always pass. See the README of `resolve-cli-002-sequence-out-of-sync` for how they work.

## Notes

A unique index on `md5(body)` treats two different bodies with the same hash as equal. This is the trade-off the article accepts, and the scorer accepts it too.
