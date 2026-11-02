# Hosted Spark POC

Set `SPARK_API_URL` in the repository's `.env` to the dev control API. The host must have network access to Spark (currently through Cloudflare WARP). Docker and the normal eval provider and Braintrust credentials are required.

Run the task tracker through MCP, then upload the scored trace:

```sh
pnpm eval:upload --suite spark --experiment codex-gpt-6-luna --eval build-database-001-tasks --runs 1
```

To check SQL fixture loading, use `--eval build-database-004-seeded-tasks`. Its `remote/project.sql` is applied through Spark's migration endpoint before the agent starts. The scorer independently reads the saved rows through the Data API. Fixture SQL is sent unchanged, so unsupported SQL fails setup.

The adapter forwards management API SQL requests to the project's `/database/query` endpoint with the secret key. Scorers use the same endpoint for SQL queries. Schema changes through MCP use `/system/v1/migrations`.

These scenarios omit RLS while Spark lacks support. SQL fixtures are supported, but log and function fixtures are not. Hosted projects remain after a run because project deletion is not wired up.

The dev query endpoint currently permits writes. The team intends to restrict it to read-only queries, which would affect scenarios that insert or update rows through `execute_sql`:
https://supabase.slack.com/archives/C0C7XC4AV34/p1793135043970229
