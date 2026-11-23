# build-docs-020-database-migrations

## What this eval measures

The [Deploy database migrations](https://supabase.com/docs/guides/deployment/database-migrations) guide, not
the agent. The prompt is a product request plus the page's url, and the checks say whether an agent that read
the page shipped a schema change that applies on top of the database that is already out there. A gap in the
page counts as a failure.

One claim: **a schema change ships as a new migration that applies cleanly.** The page teaches it in steps
4 to 6 of its walkthrough (`migration new`, add the SQL, `migration up`) and in the golden rule of the team
section. It does not say two things the claim leans on: a migration that has already shipped is never edited,
and a column added to a table that has rows needs a value for those rows. Both are what this eval asks for.

Checked against the page at supabase/supabase `6ac5ba4322`. The page's own example adds a column with a
default, which is the one hint it gives.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

migration, migrate, schema, `supabase/migrations`, `migration new`, `migration up`, `db reset`, `db push`,
`db diff`, timestamp, version, history, alter table, add column, default, backfill, not null, seed.

"Release" and "goes out" stay, because they are how the user would say it. They tell the agent the change has
to reach a database that is live without naming how.

## The seed carries the contract

- `local/supabase/migrations/` holds two migrations. `local/README.md` says production runs exactly those files,
  deploys on every merge, and already holds every order. It never says "don't edit them". An agent that
  reads it can infer the rule; an agent that doesn't can still pass by luck, which is why the history check
  exists.
- `local/README.md` also says the storefront already sends `delivery_option`. The scorer needs a column name
  to read, and an unnamed one would red every agent that chose a different spelling (flakiness #257: give
  the choice somewhere to land). This is the discovery question the eval gives up for an observable answer.
- `services: []`, because only Postgres is needed. `[db.seed]` is off, so nothing reloads rows behind the
  agent after a reset.

## How the scorer works, and why in this order

1. **File reads first** (`the migrations that were already in the repo are untouched`, `the change is in a
   new migration file that sorts after the existing ones`). Nothing has run yet.
2. **The agent's own database** (`the agent's local database has the delivery option`) before the scorer
   changes anything, so it reports what the agent did.
3. **A scratch database** that stands for production: the seed's own two migrations from this folder (not the
   workspace's copy, so an edit can't leak in), three orders, then the agent's new files in the order the CLI
   runs them. Four checks read it. It is created and dropped on the same server, so the agent's database
   stays alone.
4. **`supabase db reset` last**, because it wipes the agent's database. This is what a teammate does after
   pulling.

An edit to an existing migration followed by a reset is the failure the eval is built around. Locally it looks
perfect: the reset replays the edited file and the column is there. In the scratch database it is nothing,
because production never re-runs a file it has applied, so `existing`, `placing` and `never` all red with a
`not run` note.

## Do not drop the positive controls

- `untouched` passes for an agent that did nothing. `a new migration file that sorts after the existing ones`
  is what makes it mean something.
- `an order saved without a delivery option never has none` accepts a refusal, but only one whose error names
  `delivery_option`. Any other error is the probe's own and reds, so a table that refuses for an unrelated
  reason can't pass (flakiness #264).
- `orders that already existed come out as standard` requires exactly `standard|3`. An empty read fails.
- Every customer name starts with a per-run marker, so nothing is satisfied by rows the agent wrote.

## Predicted to saturate

`the migrations that were already in the repo are untouched`, `the change is in a new migration file...` and
`the agent's local database has the delivery option` are the cheap ones: the page's walkthrough is exactly
this, and the seed tells the agent production is live. Expect them green for most agents. The signal is in
`the new migrations apply on top of a database that already has orders` and the two probes behind it, where a
column without a value for existing rows is the mistake the page's example hints at but never states.

## The guide has to actually be read

`the agent read the database migrations guide the prompt referenced` fails unless a docs call returned the
page's content. Read `docs.calls` before the score.

## What this eval does not score

- **Which values the column accepts.** The prompt says "standard or express". Whether that becomes a check
  constraint or an enum is column design, not the page's claim, so a text column with no constraint passes.
- **A default for new orders.** The prompt doesn't ask for one. `never` accepts a default or a refusal.
- **How the file was made.** `migration new` or a hand-written file with a later version both pass.
- **How the change was applied locally.** `migration up`, `db reset`, or psql all leave the local database
  with the column, and the rebuild and rollout checks cover whether the files are enough.
- **The scratch database is not the CLI.** Files are applied with psql, one file per call, stopping at the
  first error. The CLI runs a file as a batch. A migration that only the CLI's batching accepts would pass here
  and red nowhere, which is why `the agent's local database has the delivery option` and the rebuild check
  read the real database too. It also has none of the `auth` or `storage` schemas, so a migration that
  references them would red here for the wrong reason. The seed has no such tables.
- **Pushing to a hosted project, `migration repair`, and `db diff`.** Each needs a linked project or a second
  database state the harness doesn't build, and `build-docs-017` and the CLI suite own the neighbours.
- **Declarative schemas.** A separate page.
- **A repo's own file naming convention** (agent-skills #538). The seed uses the CLI's default.
