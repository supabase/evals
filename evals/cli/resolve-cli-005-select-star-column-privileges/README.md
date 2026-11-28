# resolve-cli-005-select-star-column-privileges

These evals are part of the docUrl A/B set (`resolve-cli-002` to `resolve-cli-004`, and the harder round `resolve-cli-005` to `resolve-cli-007`). They test supabase/cli#7749 (https://github.com/supabase/cli/pull/7749). That change adds `error.docUrl` to the JSON error output, and a `Learn more: <url>` last line to the text output, when the error code has a troubleshooting article.

## Scenario

The `app_reader` role backs a public profile page. It holds column-level `select` on `public.profiles` for `id`, `display_name` and `joined_at`, and no access to `email`. The page script, `scripts/list-profiles.sql`, runs `select * from public.profiles`. `select *` expands to the email column, so the query fails with `42501` (`permission denied for table profiles`).

The local stack is already running. The prompt gives the exact CLI command that fails (as the `app_reader` role, through `--remote`). It never names the error code, the article, the columns, or the fix.

## Article

https://supabase.com/kb/troubleshooting/database-api-42501-errors

The article lists the causes of a `42501`. The section on column-level restrictions says that queries fail on restricted columns, and that `select *` fails because it expands to the forbidden columns.

## Why it is hard

The message says "permission denied for table", and a table-level privilege check shows nothing wrong, because the grants sit on columns. The obvious fix is `grant select on public.profiles to app_reader`. That fix makes the script run and exposes every email on a public page. The scorer fails it. The correct fix lists the allowed columns in the query.

## Checks

All checks gate `passed`.

- `local stack is running for this project`
- `the seeded profiles are still there`
- `the page role can list the members with the script`: the scorer runs the workspace script as `app_reader` in a fresh psql session and looks for the three display names.
- `the page role still cannot read the emails`: `select email` as `app_reader` must fail with `permission denied`.

The metrics `read_doc_url` and `saw_doc_url` ride along as checks that always pass. See the README of `resolve-cli-002-sequence-out-of-sync` for how they work. The evals carry `customMetadata.abGroup: cli-docurl`, so only the `*-cli-docurl-off` and `*-cli-docurl-on` experiments run them.
