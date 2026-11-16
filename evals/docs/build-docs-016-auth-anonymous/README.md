# build-docs-016-auth-anonymous

## What this eval measures

The subject is [Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous), not the agent. The prompt is
a product request plus the page's url, and the checks say whether an agent that read the page produced a database where
a guest and a customer are treated differently. A gap in the page counts as a failure here.

One claim: only people with an account can write a review, including a guest who made one a moment ago. Guests can
still browse and fill a cart.

A guest reaches the database as a signed-in user, so every rule that says "signed in" lets a guest through until
something tells the two apart. When a guest adds an email, the user row stops being anonymous at once. The access token
the client already holds keeps `is_anonymous: true` until it refreshes, up to `jwt_expiry`. A rule that reads the token
refuses the new customer for that window. `a guest who just made an account can post a review` measures whether the
agent's rule survives it.

## Most of the page is not scored

The eval scores the access rules only. The page also teaches converting a guest to a customer, resolving conflicts when a
guest signs in to an existing account, abuse prevention and rate limits, cleaning up old guests, and signing in from the
client. Each is a separate claim, and none is scored here. A pass says the access rules work, not that the page works.

## Do not reintroduce the vocabulary

The prompt names the product behavior, "try it without signing up", "people who made an account" and "makes an
account". It never names the mechanism. Keep all of these out of `PROMPT.md`:

anonymous, is_anonymous, signInAnonymously, JWT, claim, token, auth.jwt(), restrictive, permissive, policy, RLS, row
level security, authenticated, anon, permanent user, `config.toml`, refresh, session, link, identity, upgrade.

The seed is the world the user already has, so it uses `authenticated` and policies as any schema would.

## The seed carries the contract

`local/supabase/migrations/20240101000000_init.sql` is a plant shop. Four things in it are load-bearing.

- **Reviews already have a permissive insert policy for every signed-in user.** A guest can post until the agent acts.
  A second permissive rule that checks for a customer changes nothing, because rules of that kind combine with OR. Only
  a rule that is required in addition, or a rewrite of the existing one, passes.
- **Carts and reading are open to guests.** The two guest controls keep a blunt answer, such as revoking everything from
  every signed-in user, from passing. They also fail an agent that grants to `anon`, treating a guest as the `anon`
  role.
- **`enable_anonymous_sign_ins = true` in `local/supabase/config.toml`.** The seed turns the setting on so the eval
  measures the rules and not the switch.
- **`enable_confirmations = false`.** Adding an email to a guest takes effect at once, so the upgrade check needs no
  mailbox. Turn it on and the upgrade check fails for every solution.

Any rule that ends in the right rows is accepted. The checks read rows as the superuser, not the catalog, so a
restrictive policy, a rewritten policy, a trigger, or a function that reads the user row all score the same.

## Do not drop the positive controls

`a guest cannot post a review` and `a visitor with no session cannot post a review` pass for a schema where nobody can
post. Three checks stop that:

- `a customer with an account can post a review` requires the row to exist under the customer.
- `a guest can read the reviews` and `a guest can add a plant to their cart` require the guest to keep working.

The refusal checks read the outcome. They count the row as the superuser and require the error code to be `42501`. A
request that fails for another reason reads as could-not-measure, not as a pass. The no-session request sends a complete
row, so a not-null violation cannot pass for a refusal.

`a guest who just made an account can post a review` first confirms that the user row is no longer anonymous. If adding
the email failed, the note says so rather than blaming the rules.

The world is built by the scorer after the agent's work, with names scoped to the run, so a hardcoded user id cannot
satisfy anything.

## Order of the scorer

`the agent applied the migrations it wrote` runs first. The scorer applies anything pending, so an unapplied migration
costs that check and not every probe. `a visitor can start a session without an account` gates the probes. When it
fails they report `not run` with its note. Each probe writes its own marked row, so no probe changes what another reads.

## The guide has to actually be read

`the agent read the anonymous sign-ins guide the prompt referenced` requires a docs call that reached the page with
content. Read `docs.calls` before reading a score. Docs evals run on one no-skills experiment, so there is no unread arm
to rule out prior knowledge.

## Checks expected to saturate

The session gate, both guest controls, the customer control, the no-session check and the guest refusal. The upgrade
check is where the signal is expected.

## What this eval does not score

- **The agent's own conversion code.** No client is seeded, so the scorer converts the guest itself.
- **Switching anonymous sign-ins on.** The seed does it.
- **Review ownership and other people's carts.** The seed settles them.
- **How the agent applied the migration.** Any route that leaves it applied passes. Writing the change as a migration is
  its own check, `the agent wrote its change as a migration`.
