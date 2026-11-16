# build-docs-016-auth-anonymous

## What this eval measures

The subject is [Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous), not the agent. The prompt is
a product request plus the page's url, and the checks say whether an agent that read the page produced a database where
a guest and a customer are treated differently. A gap in the page counts as a failure here.

One claim: a guest can browse, read reviews and fill a cart, and only a customer with an account can post a review.

A guest reaches the database as a signed-in user. Every rule that says "signed in" lets a guest through until something
tells the two apart, and the rule that tells them apart has to survive being combined with the rules already there.

## Do not reintroduce the vocabulary

The prompt names the product behavior, "try it without signing up" and "people who made an account". It never names the
mechanism. Keep all of these out of `PROMPT.md`:

anonymous, is_anonymous, signInAnonymously, JWT, claim, token, auth.jwt(), restrictive, permissive, policy, RLS, row
level security, authenticated, anon, permanent user, `config.toml`.

The seed is the world the user already has, so it uses `authenticated` and policies as any schema would.

## The seed carries the contract

`local/supabase/migrations/20240101000000_init.sql` is a plant shop. Three things in it are load-bearing.

- **Reviews already have a permissive insert policy for every signed-in user.** A guest can post today. This is the
  page's own note about permissive rules combining with OR, in product clothing. A second permissive rule that checks
  for a customer changes nothing, because the first one still lets the guest in. Only a rule that is required in
  addition, or a rewrite of the existing one, passes.
- **Carts and reading are settled and open to guests.** `a guest can read the reviews` and
  `a guest can add a plant to their cart` are the controls that keep a blunt answer, such as revoking everything from
  every signed-in user, from passing. They also fail an agent that grants to `anon`, thinking a guest is the `anon`
  role.
- **`enable_anonymous_sign_ins = true` in `local/supabase/config.toml`.** The seed turns the setting on so the eval
  measures the rules and not the switch. The page shows that switch as a dashboard link and does not say how to set it
  locally. That is a separate claim and is out of scope here.

Any rule that ends in the right rows is accepted. The checks read rows as the superuser, not the catalog, so a
restrictive policy, a rewritten policy, a trigger, or a revoked grant plus a function all score the same.

## Do not drop the positive controls

`a guest cannot post a review` passes for a schema where nobody can post. Three checks stop that:

- `a customer with an account can post a review` requires the row to exist under the customer.
- `a guest can read the reviews` and `a guest can add a plant to their cart` require the guest to keep working.

The refusal check also reads the outcome. It counts the guest's row as the superuser, and it requires the error code to
be `42501`. A guest request that fails for another reason, such as a malformed row, reads as could-not-measure and not
as a pass. The customer check sends the same row shape, so a malformed request fails there too.

The world is built by the scorer after the agent's work, with names scoped to the run, so a hardcoded user id cannot
satisfy anything.

## Order of the scorer

`the agent applied the migrations it wrote` runs first. The scorer applies anything pending so an unapplied migration
costs that check and not every probe. `a visitor can start a session without an account` gates the four probes. When
it fails they report `not run` with its note.

## The guide has to actually be read

`the agent read the anonymous sign-ins guide the prompt referenced` requires a docs call that reached the page with
content. Read `docs.calls` before reading a score. Docs evals run on one no-skills experiment, so there is no unread arm
to rule out prior knowledge. This is a mainstream task and may saturate.

## What this eval does not score

- **Turning a guest into a customer.** The page covers linking an email or an identity and resolving conflicts. The
  prompt asks for none of it.
- **Switching anonymous sign-ins on.** The seed does it. See above.
- **Abuse prevention and cleanup.** Captcha, rate limits and deleting old guests are separate claims on the same page.
- **Review ownership and carts of other users.** The seed settles them.
- **How the agent applied the migration.** Any route that leaves it applied passes. Writing the change as a migration is
  its own check, `the agent wrote its change as a migration`.
