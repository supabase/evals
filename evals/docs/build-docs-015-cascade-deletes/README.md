# build-docs-015-cascade-deletes

## What this eval measures

The subject is [Cascade Deletes](https://supabase.com/docs/guides/database/postgres/cascade-deletes), not the agent.
The prompt is a product request plus the page's url, and the checks say whether an agent that read the page left a
schema where deleting a row removes the right rows. A gap in the page counts as a failure here.

One claim: when something is deleted, everything that belongs to it goes, and nothing that has to outlive it goes
with it. The page explains each of the five actions and works one example where a grandchild row is reachable
through two links, one cascading and one blocking, and the blocking one fails the whole delete. It does not say how
to choose an action per relationship, or how to keep a child whose parent is deleted. Both are what this eval asks
for.

## Do not reintroduce the vocabulary

The prompt says what has to go and what has to stay, in product terms. It never names the mechanism. Keep all of
these out of `PROMPT.md`:

cascade, on delete, foreign key, constraint, references, restrict, set null, no action, deferred, deferrable,
orphan, 23503, trigger.

The seed migration is the world the user already has, so it uses `references` as any schema would.

## The seed carries the contract

`local/supabase/migrations/20240101000000_init.sql` is a team workspace app in which every link uses the default
action, so deleting a team fails today. That is the user's symptom. Three things in it are load-bearing.

- **A comment is reachable from a team by two paths**, through its task and through its author. This is the page's
  own grandparent example in product clothing. Cascading every link except the author's leaves the team delete
  blocked, exactly as the page's `RESTRICT` example shows.
- **The author link is nullable, and its comment says the discussion stays when someone leaves.** That is the
  contract for keeping a child whose parent goes. Clearing the author passes; deleting the comment fails; deferring
  the check (`no action initially deferred`, the page's own fix) unblocks the team delete but still blocks deleting a
  member, so it fails the leaver check. That last case is the signal: the page's fix for its example does not serve
  this request.
- **Invoices are nullable on the team and carry the team's name**, and the comment says finance keeps them. Cascading
  everything deletes them.

The conflict is deliberate. Cascading everything fails two checks, changing nothing fails all of them, and only a
choice made per link passes. Any action that ends in the right rows is accepted; the checks read rows, not the
catalog, so `set null`, a trigger, or dropping the link all score the same.

`services: []`, because only Postgres is needed. The agent writes and applies the migration; the scorer applies
anything still pending first and gives that its own check (flakiness #292).

## Do not drop the positive controls

`the closed team's invoices are kept`, `the other team's rows are all still there` and
`deleting a member who left keeps the comments they wrote` all pass for a schema where nothing is ever deleted,
if they ran. Two things stop that:

- `deleting a team succeeds` is the positive control for the three checks after it. When the delete fails, those
  three fail with a `not run` note rather than passing.
- The leaver check requires the member row to be gone before it counts the comment, so a blocked delete fails it.

The world is built by the scorer after the agent's work, with names scoped to the run, so nothing can be satisfied by
rows the agent wrote.

## The guide has to actually be read

`the agent read the cascade deletes guide the prompt referenced` requires a docs call that reached the page with
content. Read `docs.calls` before reading a score; an empty one means the run measured the model, not the page.

## What this eval does not score

- **Indexes on the linking columns.** A cascade without one is slow on a big table, but that is a performance claim
  about a different page.
- **Links to `auth.users`.** The seed has none, so the eval stays on Postgres and off Auth.
- **Soft deletes.** "Leaving" is read as the member row being deleted. A design that marks members inactive instead
  still fails the leaver check, because the scorer deletes the row. That is a recorded design choice.
- **How the agent applied the migration.** Any route that leaves it applied passes.
