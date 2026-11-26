# build-docs-040-realtime-postgres-changes

## What this eval measures

The subject is [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes), not the agent. The prompt
is a product request plus the page's url, and the checks say whether an agent that read the page gets a table's changes to
the right subscribers.

One claim: a signed-in customer receives each change to their own orders as it happens, with the status it had before,
and nobody else receives it.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

realtime, live, postgres changes, publication, supabase_realtime, replication, replica identity, old record, payload,
RLS, row level security, policy, select, grant, authenticated, anon, auth.uid, JWT, token, subscribe, channel, filter,
broadcast.

The seed is the world the user already has, so its client code uses `postgres_changes` and a filter as shipped code
would.

## The seed carries the contract

- `local/app/order-updates.ts` is the shipped client. It listens to every event on `orders` with
  `customer_id=eq.<user id>` and reads the old status on an update. `local/ORDER_SCREEN.md` says the code cannot change.
  The scorer listens with exactly this subscription, so the work is on the database side.
- `orders` has row level security on and no read rule, because the app read orders through its backend. A customer
  receives nothing until a rule lets them read their own rows.
- `orders` is not sent to subscribers. `shop_status` already is, and anyone can read it. It is the banner the scorer uses
  as a positive control. The banner check stays scored because an agent that rebuilds the publication breaks a feature
  that works today.
- `enable_confirmations = false`, so the scorer's customers sign up with a session at once.

## Do not drop the positive controls

`a customer gets no changes to another customer's orders` and `a visitor who is not signed in gets no order changes` pass
for a project that sends nothing. Each one fails as could-not-measure unless the same connection receives something it
is allowed to: the other customer's own order, or the visitor's banner change plus the owner's new order. The leak
probes listen with no filter, as a client that edits the shipped code would.

The visitor check also requires the server to accept the visitor's subscription to `orders`. A correct project accepts
it and then sends the visitor nothing, so a refusal is could-not-measure, not a pass.

Every row the scorer writes carries a marker scoped to the run, and the changes are written after the listeners connect.

## How the checks read the end state

- The scorer applies pending migrations first with `supabase migration up --local`, so an unapplied migration costs one
  check. That writes to the database, so score a workspace once per stack.
- It signs up two customers, then listens host-side through supabase-js: the owner with the shipped subscription, the
  other customer and a signed-out visitor with no filter, and the visitor on the banner. It waits for the server to
  answer each subscription before writing.
- On a stack where nobody has listened yet, the first change after the first subscription can be lost while the server
  starts delivering. So the scorer first changes the banner and waits up to 30 seconds for it to reach the visitor. If it
  never arrives, the checks that then fail say the result could not be measured.
- As the superuser it adds an order for each customer, changes the owner's order from packed to shipped, changes the
  banner, and deletes the owner's order. It waits up to 20 seconds for the expected changes, then 3 more for leaks.
- An event with no row data, or one marked unauthorized, is not a leak. Realtime sends that to a subscriber whose role
  cannot read the table at all, so the leak checks count only events that carry an order and name the empty ones in the
  note.
- Deletes are left out of both leak checks. Realtime sends a delete to every subscriber whose filter matches, carrying
  only the primary key when row level security is on. That is the platform's behavior, not the agent's.
- A filtered delete and the old status both need the table to send whole old rows. One missing setting fails both
  checks.

## The guide has to actually be read

`the agent read the Postgres Changes guide the prompt referenced` requires a docs call that reached the page with
content. Read `docs.calls` before reading a score.

## Checks expected to saturate

The migration check and the banner check. The signal is expected in the owner's three arrival checks, the old status, and
the two leak checks.

## What this eval does not score

- **The agent's client code.** The client is shipped and fixed, so the scorer replays it.
- **Deletes reaching other subscribers.** The platform decides what a delete carries.
- **Custom tokens, private schemas, column selection and scaling.** Each is a separate claim.
- **Hosted projects.** The dashboard's publication toggle is out of reach locally.
