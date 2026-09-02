# What this eval measures

The subject under test is the [connecting to Postgres guide](https://supabase.com/docs/guides/database/connecting-to-postgres), not the agent. A gap in the guide counts as a failure.

## Do not reintroduce the vocabulary

`PROMPT.md` never says pooler, pooling, transaction, session, port, prepared statement, or connection string. Stripping it is the measurement.

The prompt says where the code runs and nothing about how to reach the database. It tells the agent to rely on the guide rather than on what it already knows, so a pass is evidence about the page instead of about the model's priors. Keep that instruction when loosening the rest.

## The seed carries the contract

`CONNECT.md` lists three connection strings the way the dashboard Connect panel prints them, with nothing picked. Which one reaches the client is the measurement, so the file carries no guidance about when to use each.

`.env.example` ships with `DATABASE_URL` empty. Filling it is where the choice becomes observable.

`api/items.mjs` fixes three things: the handler signature, `DATABASE_URL` as the variable the deploy reads, and postgres-js as the driver. Each buys a claim the scorer can prove and costs a question the agent would otherwise answer. The contract sits in a seed comment so `PROMPT.md` keeps its vocabulary.

The scorer inserts a row with a run-scoped marker before it calls the handler, so `the handler reads a row the scorer inserted` cannot be satisfied by a literal.

Grants and row level security are left alone. Policy design is what `build-docs-002-rls-guide` measures, and a grant mistake here would fail this eval for the wrong reason.

## Do not drop the positive controls

Every file check passes for an agent that edited an env file and nothing else. `the handler reads a row the scorer inserted` and `the handler writes a row that lands in items` are what make them mean something. Drop either and a run that produced nothing working scores full marks.

The write control reads the row back with a run-scoped marker rather than trusting the handler's own response, so a handler that reports success without writing fails it.

## The client-lifetime check counts connections

`the database client is created once per module, not per request` runs the handler six times in one process and requires one database connection. A factory called once at module scope opens one, and a client constructed per request opens six. Where the `postgres()` call sits in the file does not decide it.

## The probe terminates TLS

The local database speaks no TLS, so a handler that requires it cannot connect. The probe sits in front of the database, answers the SSLRequest, and terminates TLS with a self-signed certificate. postgres-js `ssl: 'require'` does not verify the certificate. `ssl: true` does, and fails.

## `aws-1` is deliberate

`every Supabase host in the workspace is one CONNECT.md lists` is a whitelist. It fails any Supabase host the project was not given, which closes hosts written from memory as a class rather than one spelling at a time.

## The prepared-statement check is conditional

It reads `prepare: false` off the postgres-js call and passes as not applicable when the resolved connection is not pooled. Prepared statements belong on over a direct connection, and `the transaction pooler string is what the app reads at runtime` already carries that failure.

## Dependencies are their own check

`project dependencies installed` exists so a failed `npm install` costs the two handler checks and nothing else. An install error is not evidence about the guide.

## The guide has to actually be read

`the agent read the connecting to Postgres guide the prompt referenced` matches docs calls against the guide's path. Without it, a run that never opened the page and passed on prior knowledge would read as the guide working.

It resolves the url from the harness's own docs result rather than the raw tool call, because a `search_docs` hit carries the guide's url in its result rather than its request.

## What this eval does not score

**IPv4 against IPv6.** The address family of the client network and whether the project holds the IPv4 add-on are properties of the environment. A check would report a Docker networking change as a change in the guide.

**Session against transaction mode, beyond the port.** The local stack serves one pool mode, so the port carries the whole claim.

**Dedicated pooler and PgBouncer.** Hosted and paid, and not reachable from `supabase start`.

**Pool exhaustion.** `the connection pool is capped for a serverless invocation` measures the sizing rule. The exhaustion it prevents needs concurrency the scorer does not generate.

**SSL verification mode.**

**Which access layer to use.** This eval measures the connection decision given a Postgres client in the project.

**Which credential reaches the connection string, and where it lives.** That is `build-docs-003-api-keys-guide`.
