# build-docs-028-database-webhooks

## What this eval measures

The [Database Webhooks](https://supabase.com/docs/guides/database/webhooks) guide, not the agent. The prompt is a
product request plus the page's url, and the checks say whether an agent that read the page ended up with a local
project whose table changes reach a service on this machine. A gap in the page counts as a failure.

One claim: **a table change triggers an HTTP call to a local receiver.** Three things on the page are what this eval
leans on:

- The page's SQL calls `supabase_functions.http_request`, which sends through `pg_net`. The page never says to enable
  that extension. On a local project it isn't enabled, and the first insert into the table then fails with
  `schema "net" does not exist`, so the agent's change breaks the thing it was meant to add to. This was run on a
  real stack (CLI 2.117.0) before any check was written.
- The page's example URL is `http://host.docker.internal:3000`, and its "Local development" section explains why:
  the database runs in a container, so `localhost` is the container itself. With `localhost` the insert succeeds and
  the call fails silently with `Couldn't connect to server`, so nothing in the agent's own work shows it.
- The page's Payload section gives the body: `type`, `table`, `schema`, `record`, `old_record`. A trigger written by
  hand around `net.http_post` has to rebuild that shape, and an update has to carry both the row as it was and as it
  is.

Checked against the page at supabase/supabase `main` as of 2026-11-23.

## Where the checks came from

No user evidence for this page turned up, which the ticket said to expect.

- **Reached:** the page, and the local stack itself: the SQL on the page, the missing extension, and `localhost`
  against `host.docker.internal` were each tried on a real local database before the checks were written.
- **Out of reach:** Linear, Slack, Hex, the internal report.

So the traps come from reading the page against how a local stack behaves, not from a report of an agent failing. If a
user-feedback issue turns up, add it here.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

webhook, trigger, `pg_net`, `net.http_post`, `supabase_functions`, `http_request`, HTTP, request, POST, payload,
event, function, extension, `host.docker.internal`, `localhost`, Docker, insert, update.

"Order", "status", "call" and "port 4100" stay, because they are the user's words.

## The seed carries the contract

- `local/app/receiver.mjs` is the fulfilment service. Its comment fixes the port (4100) and the body the service
  reads (`type`, `record.id`, `record.status`, `old_record.status`), in the user's terms. This is the discovery
  question the eval gives up for an observable answer, and it makes the shape check a control the scorer can prove.
  The cost: an agent that reads the seed's comment gets the body right without the page's Payload section, so the
  shape check is expected to saturate.
- The port is 4100, not the page's 3000, so a memorized answer is wrong.
- `local/supabase/migrations/20240101000000_create_orders.sql` creates `orders` and `customers`. `customers` is the
  absence probe: the prompt says the service only cares about orders.
- `services: []`, because only Postgres is needed.

## Do not drop the positive controls

- `an order added to the table is sent to the service on port 4100` is the control for the other three. It needs the
  call to leave the database and reach a service on the host. When it fails, `a change to the customers table sends
  nothing` fails with a `not run` note instead of passing, because silence only means something once the service is
  known to hear calls.
- The scorer starts its own listener on port 4100 after the agent is done (it stops the seed's service first), so what
  the checks read is what the database sent, and nothing the agent's own service printed can satisfy them.
- Every row carries a run-scoped marker, so a call left behind by the agent's own testing cannot satisfy a check.
- The scorer adds the order, changes it, then adds a customer, in that order, so the silence about customers is read
  after the controls.

## Predicted to saturate, and what failed

The probes ran against a real local stack (CLI 2.117.0, database only) with example solutions, kept local and never
committed. The scorer's own listener and psql were used as in a run. Predictions were written before running and all
held.

| Solution | Red checks |
| --- | --- |
| `pg_net` enabled, trigger on insert and update of `orders` via `supabase_functions.http_request` to `host.docker.internal:4100` | none |
| the page's SQL with port 4100, `pg_net` never enabled | all four (the insert fails) |
| `pg_net` enabled, URL `localhost:4100` | all four, no call arrives |
| trigger on insert only | `a status change is sent...` |
| trigger on `orders` and `customers` | `a change to the customers table...` |
| a hand-written `net.http_post` with `body := to_jsonb(new)` | `the call for a new order carries...`, `a status change...` |
| nothing built | all four |

The signal is in the first row against the second and third. An agent that knows to enable `pg_net` and use
`host.docker.internal` passes everything, which is a correct answer and not a defect. The shape check is expected to
saturate, because the seed's comment gives the body.

## First baseline

`codex-gpt-6-luna-no-skills`, one run: **1 of 6 checks**. The agent read the guide, wrote a migration with the
page's SQL pointed at `host.docker.internal:4100` (insert, and update of `status`), and never applied or tested it
(it read `supabase status`'s list of stopped, excluded services as the whole stack being down). The scorer applied
the migration, and the first insert failed with `schema "net" does not exist`, so the three delivery checks red. The
migration itself is what the page shows, so that red is the page's gap: it never says to enable `pg_net`. One run is a
signal, not proof. Refresh before describing how agents fail.

## The guide has to actually be read

`the agent read the database webhooks guide the prompt referenced` fails unless a docs call returned the page's
content. Read `docs.calls` before the score. Reading the page and knowing Postgres produce the same result on a
mainstream task, so a pass doesn't attribute the work to the page.

## What this eval does not score

- **Deleting an order.** The prompt asks for added and changed orders. A call for a delete is neither required nor
  refused.
- **Sending without blocking the insert.** The page says calls are asynchronous. The probe waits for the call and does
  not time the insert.
- **Calling an Edge Function, or the Vault flow.** A second claim on the same page, with its own stack, key and
  function.
- **The Dashboard.** There is no browser, so the SQL route is the only one an agent can take here.
- **Who inserts the row.** The scorer inserts as the superuser. A trigger function that a signed-in user's role
  can't run is a different page's claim (grants and `security definer`).
- **How the change was persisted.** The scorer applies pending migrations first and gives that its own check, so a
  trigger created straight in the database passes. Whether it survives a reset is the migrations guide's claim.
- **The timeout, headers and method.** Any call the service reads as the seed describes passes.

## Not run against more than one stack

- The probe waits up to 15 seconds for each call. `pg_net` normally sends within a second, so a slower stack would
  read as a missing call.
- The scorer assumes `host.docker.internal` resolves from the database container, which holds on Docker Desktop and
  OrbStack and, via the CLI's host-gateway entry, on Linux. A stack where it doesn't would red a correct solution on
  the environment; check `docs.calls` and the notes before blaming the page.
