# build-docs-035-postgres-triggers

## What this eval measures

The subject is [Postgres Triggers](https://supabase.com/docs/guides/database/postgres/triggers), not the agent. The prompt
is a product request plus the page's url, and the checks say whether an agent that read the page records a side effect of
a change that app users cannot write themselves.

One claim: every real status change is recorded once, whether a signed-in customer or the back office makes it, and
customers cannot write the record themselves.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

trigger, function, security definer, security invoker, row level security, RLS, policy, for each row, for each statement,
update of, distinct, plpgsql, search_path, schema-qualified, grant, revoke, privilege, role, authenticated,
service_role, insert, and `before`, `after`, `new`, `old` and `when` as SQL keywords.

## The seed carries the contract

- `order_status_history` exists with row level security on and a read policy for the order's customer. It has no write
  policy, so app users cannot write it. The agent has to make a status change record itself without opening the table.
- `orders` lets customers read and update their own orders, so a customer's update reaches the database as that customer.
- `ORDERS.md` fixes the two app calls the probes replay: the order form saves `status` with `delivery_note` even when the
  status is unchanged, and "Cancel all open orders" changes several rows in one statement.
- `old_status` is nullable, so an agent that also records the first status of a new order passes. The probes count only
  the entry for the change they make.

## Do not drop the positive controls

`saving an order without changing its status adds no entry` and `customers cannot add, change or remove timeline entries`
pass for an agent that built nothing. `a status change by a signed-in customer is recorded on the timeline` makes both
mean something, because it proves the same customer's change does write an entry. The write check also inserts the same
row as the scorer in a rolled-back transaction first, so a row the schema refuses for everyone is not counted as a
refusal.

## How the checks read the end state

- Every probe runs SQL with the role and `request.jwt.claims` set, as `authenticated` for a customer and `service_role`
  for the back office. Each probe makes its own orders for a fresh customer id, so the probes do not share rows.
- The scorer applies pending migrations first with `supabase migration up --local`, so correct SQL that the agent did not
  apply costs one check. That step writes to the database, so score a workspace once per stack.
- `a status change from the back office is recorded on the timeline` passes for a recording step that runs with the
  caller's rights. It separates "nothing records" from "only customers' changes fail".
- The back office, customer and bulk checks also require the order's status to have changed, so a step that drops the
  update fails.

## The guide has to actually be read

`the agent read the Postgres Triggers guide the prompt referenced` requires a docs call that reached the page with
content. Read `docs.calls` before reading a score.

## Checks expected to saturate

The migration check, the back office check, `customers see the timeline of their own orders only`, and the write check.
The signal is expected in the customer, bulk and unchanged checks.

## What this eval does not score

- **The API path.** The probes set the role in SQL rather than calling PostgREST.
- **Who made a change.** The timeline has no column for it.
- **Changes to an order other than its status.** The prompt asks only for status.
- **Where the change lives.** The prompt says to set it up in the local project. The checks read the database, so a
  change applied with no migration file passes.
- **Hardening of the recording step's `search_path`.** App users reach the database only through the API, so the scorer
  does not probe name resolution.
- **Hosted projects and the dashboard.** Out of reach locally.
