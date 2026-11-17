# build-docs-017-seeding-your-database

## What this eval measures

The [Seeding your database](https://supabase.com/docs/guides/local-development/seeding-your-database)
guide, not the agent. The agent gets a half-finished sample data folder and a product request: a reset
should bring back the team's sample data, and the app should still work on top of it. If an agent that
read the page leaves a reset that fails, or a database that can't take new rows, the page didn't carry
it.

## Do not reintroduce the vocabulary

The prompt leaves these out on purpose: seed, seeding, `seed.sql`, `config.toml`, `[db.seed]`,
`sql_paths`, glob, order, `db reset`, migration, sequence, identity, `setval`, id.

"Reset" stays, because it's how the user would say it.

## The seed carries the contract

- `supabase/sample/README.md` lists every row a fresh database needs, by name. The scorer joins on
  those names, so any ids pass.
- `supabase/sample/studios.sql` is a teammate's start, and it uses **explicit ids**. That leaves the
  studios identity counter at 1, so the app's first new studio collides unless the agent deals with
  it. The page never mentions this, so check 3 is where the signal is expected.
- The README says one file per table. Bookings, classes, instructors and studios sort in exactly
  reverse dependency order, so loading the folder with `./sample/*.sql` fails the reset on a foreign
  key. The page says glob matches sort lexicographically, but its own `countries`/`cities` example
  sorts the wrong way.
- `config.toml` is the `supabase init` default, seeding on, pointing at a `seed.sql` that doesn't exist.

## Do not drop the positive controls

- "a reset without the sample data step leaves none of it behind" passes for an agent that did
  nothing. "every row on the sample data list is there" is what makes it mean something.
- The insert probe ends by counting the booking it made, so it can't pass on a chain that inserted
  nothing.

## The scorer runs the reset itself

It runs `supabase db reset` inside the sandbox rather than trusting whatever state the agent left,
then `supabase db reset --no-seed` last, because that one wipes what the other probes read. This was
the first docs scorer to run a reset. The pinned CLI skips restarting containers that aren't running,
so it works with `services: []`.

## The guide has to actually be read

"the agent read the seeding guide the prompt referenced" fails unless a docs call returned the page's
content. Read `docs.calls` before the score.

## What this eval does not score

- **Seeding `auth.users` and `auth.identities`.** A separate claim with plenty of customer asks behind
  it, and a good candidate for its own eval.
- **One file per table.** The teammate's preference, carried by the seed. What it costs (ordering) is
  measured by the reset and row checks.
- **Generated data (Snaplet) and seeding on the first `supabase start`.** The prompt asks for neither.
- **Getting the same data on every reset.** The prompt doesn't ask for it.
