# build-docs-033-timeouts

## What this eval measures

The [Timeouts](https://supabase.com/docs/guides/database/postgres/timeouts) guide, not the agent. The prompt is a
product request plus the page's url, and the checks say whether an agent that read the page left a project where a
signed-out visitor's slow query is cancelled and the server's own job still finishes.

One claim: **a role's statement timeout cancels a slow query.** The page lists four levels, session, function, role
and global, with the defaults for the Data API's roles (`anon` 3s, `authenticated` 8s, `service_role` none, so the
`authenticator` role's 8s, `postgres` none). It says a role's timeout is changed with
`alter role <role> set statement_timeout = '…'`, and that "for Supabase Client API calls, PostgREST must be reloaded for
changes to take effect" with `NOTIFY pgrst, 'reload config';`.

## Confirming the claim

The ticket's claim is a reading of the page, so I tried it on a real local stack (CLI 2.117.0, `gotrue`, `kong` and
`postgrest` only) with a function that sleeps, called through the Data API.

- **Confirmed: the defaults.** `pg_roles.rolconfig` reads `anon` 3s, `authenticated` 8s, `authenticator` 8s, and
  `service_role` and `postgres` carry no timeout. A 6 second call as a visitor came back `500` with code `57014`
  (`canceling statement due to statement timeout`) after 3.0 seconds. The same call with the secret key finished.
- **Confirmed: a role's setting cancels the call.** After `alter role anon set statement_timeout = '1s'` and a reload,
  the visitor call was cancelled after 1.0 seconds, and a 0.3 second call still finished.
- **Confirmed: the reload matters.** Right after the `alter role`, with no reload, the Data API still cancelled at 3.0
  seconds. After `NOTIFY pgrst, 'reload config'` it cancelled at 1.0. Nothing reloads it for an `alter role`, so a
  setting written into a migration is invisible to visitors until something does.
- **Not confirmed: hosted behavior.** The Dashboard's 60 second ceiling, the pooler modes and the logs are not
  measurable on a local stack.

## Does an existing eval cover it?

No. `statement_timeout` appears in `evals/cli/deploy-database-006-push-and-verify-remote` and
`evals/cli/resolve-database-004-reconcile-migration-history`, both only in test files that run SQL, and no eval has a
docs page about timeouts as its subject. `build-docs-025-postgres-roles` and `build-docs-020-securing-your-api` are
about what a role may read, not how long it may run.

## Where the checks came from

No user evidence for this page turned up, which the ticket said to expect.

- **Reached:** the page and the real stack above.
- **Out of reach:** Linear, Slack, Hex, the internal report. `supabase/agent-skills` has nothing on timeouts.

The reload check comes from the stack as much as the page. The page says the reload is needed and says nothing about
what an agent sees when it is missing: a role that reads back correctly from `pg_roles` and a slow query that still runs
to the old limit.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

timeout, statement timeout, `statement_timeout`, cancel, role, `alter role`, reload, `pgrst`, `NOTIFY`, `pg_sleep`,
session, global, function-level, pooler.

"Cut off after one second", "left to run" and "the whole database crawls" are how the user says it.

## The seed carries the contract

- `local/supabase/migrations/20240101000000_create_slow_report.sql` creates `public.slow_report(pause_seconds)`, which
  sleeps and returns `done`, executable by `anon`, `authenticated` and `service_role`. The scorer needs a call that can be
  made slow on purpose, and the function is the report the prompt describes. It buys an observable answer at the cost of
  the agent not designing the query. The migration's header says it has already run and that anything new goes in a new
  file. Without it an agent can append to the file that already ran, and the change never reaches the database.
- `local/app/report.mjs` (publishable key) and `local/app/nightly.mjs` (secret key) are the two callers. The nightly job
  is the conflict: the same function, a call that must take its full 4 seconds. A function-level timeout cancels it,
  and so does a timeout on the secret key's role, so only a timeout on the visitor's role satisfies both.
- No role is touched in the seed, so every timeout in the project is the platform's default.
- `services: gotrue, kong, postgrest`. Storage and the rest aren't needed. `gotrue` is there because `supabase status`
  reports no keys without it.

## How the scorer works, and why in this order

1. **Apply pending migrations**, so a setting written into a migration and never applied costs one check.
2. **One quick visitor call, then one slow one.** A 0.3 second call must finish, which is the control. A 4 second call
   must be cancelled in under 2.5 seconds. The user asks for one second and the default is 3, so anything cancelled
   by 2.5 seconds was set by the agent, and 2 seconds passes as well.
3. **Reload only if needed.** When the slow call was not cancelled in time, the scorer sends `NOTIFY pgrst, 'reload
   config'`, waits, and calls again. If that call is cancelled in time, the setting was right and the reload was
   missing, which costs `the Data API was reloaded after the role was changed` and nothing else, because the cut-off
   check then reads the reloaded state.
4. **The job's call last**, 4 seconds with the secret key.

Refusals are read from the response's error code `57014` and the time the call took. 503s while PostgREST reloads
are retried and don't count towards the time. A typical correct run spends about 6 seconds in the probes, the
worst case about 15.

## Do not drop the positive controls

An agent that built nothing, and one that set a timeout so short everything is cancelled, both cancel slow queries.

- `a visitor's quick query still finishes` separates a limit from a wall. When it fails, the cut-off check fails with
  a `not run` note instead of passing for a role that runs nothing.
- `the nightly job's 4 second query still finishes` is what stops a global or function-level answer. It is the only
  check that fails a solution that cancels everyone.
- The reload check passes when the reload changed nothing, so a project with no timeout set doesn't fail it as well as
  the cut-off check. Its notes say `nothing to reload`.

## What each check proves

| Check | Proves |
| --- | --- |
| `the agent applied the migrations it wrote` | Nothing the agent wrote is left unapplied. |
| `the Data API was reloaded after the role was changed` | A setting that cancels slow queries is live without the scorer's help. |
| `a visitor's quick query still finishes` | The visitor's timeout is not so short that it breaks real queries. |
| `a visitor's slow query is cut off within 2.5 seconds` | The visitor's role has a timeout under about 2.5 seconds, live in the Data API. |
| `the nightly job's 4 second query still finishes` | The timeout is on the visitor's role and not on everyone. |
| `the agent read the timeouts guide the prompt referenced` | The page was opened with content. |

## Predictions, and what the probes were run against

The probes ran against the real stack above, with each state of the settings written directly. Predictions were
written first and all held.

| State of the project | Red |
| --- | --- |
| `anon` at 1s or at 2s, reloaded | none |
| `anon` at 1s, never reloaded | reloaded |
| nothing changed | cut-off |
| function-level 1s | job |
| `anon` and `service_role` at 1s | job |
| `anon` at 100ms | quick, and cut-off as `not run` |
| `anon` raised to 10s | cut-off |

## The guide has to actually be read

`the agent read the timeouts guide the prompt referenced` fails unless a docs call returned the page's content. Read
`docs.calls` before the score.

## What this eval does not score

- **Signed-in users (`authenticated`).** The prompt is about visitors. Signing up adds the token-timing problem seen in
  `build-docs-020`.
- **Direct and pooler connections, and session-level `set`.** The page says a session setting doesn't reach the Data
  API. The probes only use the Data API.
- **Global timeouts.** `alter database` leaves a role that has its own setting alone, so a global answer fails the
  cut-off check for the right reason. The value is not probed.
- **Lock and idle timeouts, and the 60 second Dashboard ceiling.** Not on the local stack.
- **Reading timeout logs.** The page describes the Dashboard's Explorer. Not asked for.
- **The exact boundary.** One second is asked for and 2.5 seconds is the line, because the platform's default is
  3 seconds.
- **How the setting was persisted.** A migration, `psql` and a seed all land in `pg_roles`. Whether it survives a reset
  is `build-docs-020`'s kind of claim.

## Risks

- **The reload is the scorer's, not the agent's, when it is missing.** The scorer sends `reload config` itself, so
  the reload check is a diagnostic. It passes for a project that set nothing.
- **Refresh twice before describing how agents fail.** One baseline's failure mode is not the eval's.
