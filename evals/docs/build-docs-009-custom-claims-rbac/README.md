# build-docs-009-custom-claims-rbac

## What this eval measures

The subject is
[Custom Claims & Role-based Access Control](https://supabase.com/docs/guides/api/custom-claims-and-role-based-access-control-rbac),
not the agent. The prompt is a product request plus the page's url, and the checks say whether an agent that read the
page produced working code. A gap in the page counts as a failure here.

One claim: a moderator can delete a post they did not write, and a member cannot.

Every piece of SQL on the page is inert until the access token hook is switched on. The page shows that step as a
dashboard click and links out for the local equivalent, so it never states the four lines a local project needs. The
checks are arranged so that the page's own worked example passes with the hook on and fails with it off, and the two
runs differ by nothing else.

## Do not reintroduce the vocabulary

The prompt names the feature and the two roles. It never names the mechanism, because whether the page transmits the
mechanism is the measurement. Keep all of these out of `PROMPT.md`:

claim, custom claim, JWT, token, access token, hook, auth hook, `custom_access_token_hook`, `auth.jwt()`,
`config.toml`, `supabase_auth_admin`, RLS, row level security, policy, grant, revoke, enum, permission, `authorize`,
security definer, `user_role`.

The seed may carry product vocabulary the user would already have in front of them. The line is the prompt.

## The seed carries the contract

`local/supabase/migrations/20240101000000_init.sql` is the forum's existing schema. Three things in it are
load-bearing.

- **`member_roles` already exists and the comment says the admin tooling fills it.** The scorer has to be able to
  make somebody a moderator, and it cannot do that without knowing where roles live. Seeding the table buys a
  probeable address at the cost of the design question, and that trade is deliberate: the page's gap is the hook, not
  the table shape.
- **The delete grant on `posts`.** New tables in `public` get no DML grants for `authenticated` on current CLI
  versions, so without `grant delete` no policy the agent writes can ever take effect and every behavioral check
  reds on a grant this page never mentions. Default grants are the subject of
  `evals/regression/resolve-dataapi-002-secure-default-grants`.
- **The read and insert policies on `posts`.** Owner-scoped table policies are the subject of
  `build-docs-002-rls-guide`, so a mistake there cannot fail this eval for the wrong reason. Delete is left open,
  because delete is the claim.

`member_roles` has row level security on and no grants to `authenticated`, which is the state a fresh project is in.

`projectRunning: false` is load-bearing. `supabase start` renders `config.toml` into the Auth container's
environment at creation time, so a hook enabled after the stack is up is invisible to it. Letting the agent own the
lifecycle is what makes the claim measurable without the scorer restarting anything.

## How the scorer is ordered

`the local stack is running` gates everything. Without it there is no Auth to sign into and no database to read, so
every probe reds with that note rather than throwing.

The moderator's role is written to `member_roles` **after** sign-up and the moderator then signs in again. Sign-up
issues a token before the role exists, so a scorer that reused it would read a stale token and red a correct
solution. Whatever puts the role in a token has to run on the second sign-in.

Each probe deletes its own post row, so no probe can change what another one reads.

## Do not drop the positive controls

`a member cannot delete another member's post` passes for an agent that wrote no delete policy at all, because with
row level security on and nothing granting delete, nobody can delete anything. What makes it mean something is
`a member can delete their own post` and `a moderator can delete another member's post`.

**The two member checks both pass when the hook is off.** That is the point. A member deleting their own post never
touches the role, so the forum looks like it works while moderators quietly have no powers. Only
`a moderator can delete another member's post` separates the two, and it is the check to read first.

`the moderator's role travels in their token and a member's does not` is the diagnostic that says why. It scans the
moderator's token for the role value at any claim name and any depth, minus the standard claims, and requires the
member's token not to carry it. Asserting on `user_role` by name would constrain the page to one spelling.

`the access token hook is switched on for the local project` is a source-level claim, and named as one. Its
behavioral counterparts are the two checks above. It accepts any `uri`, because the function's name and schema are
the agent's to choose.

The refusal checks read the outcome, not the error. `a member cannot make themselves a moderator` counts rows as the
superuser rather than trusting the API's message, so a request the probe itself malformed cannot be scored as a
refusal.

## The guide has to actually be read

The last check resolves the guide through the harness's own docs result, because a `search_docs` hit carries the url
in its result rather than its request. It requires retrieved content, not just a url that was reached.

Read `docs.calls` before reading the score. Docs evals run on one experiment and it is a no-skills one, so there is
no second arm to rule out prior knowledge. An empty `docs.calls` means the run measured nothing about the page,
whatever the checks say.

## What this eval does not score

- **The shape of the role storage.** The page models roles and permissions as two tables with two enums, and a
  single column on a profile row works as well. The seed fixes where roles live so the scorer can write one, and no
  check reads the agent's own tables.
- **Whether a permission layer exists.** The page's `authorize` function and its `role_permissions` table are one
  design. A policy that checks the role claim directly satisfies every check here.
- **Reading the claim in application code.** The page closes by decoding the token client-side. No client is seeded,
  so there is nothing to read it in.
- **Stale claims.** A role granted after a token is issued does not appear until the token is refreshed, and the
  page's closing line that the setup "automatically propagates" reads past that. The scorer signs in again precisely
  to avoid measuring it.
- **Admin roles and channel deletion.** The page's worked example carries a second role with a second permission.
  One claim, so the prompt asks for one.

## A risk worth knowing

**Missing grants break sign-up, not just the claim.** Without `grant execute` on the hook function to
`supabase_auth_admin` and access to the role table, Auth answers `Error running hook URI` and nobody can sign up at
all. That reds five checks with a setup failure rather than a policy verdict, so read the notes before reading the
score. The page does carry those grants.

**`a member cannot make themselves a moderator` is saturated.** The seed grants `authenticated` nothing on
`member_roles`, so only an agent that adds a grant can red it. It is here because a writable role table is a
privilege escalation, and the page's own revoke line is what prevents it.

**The delete grant in the seed is doing a lot of work.** Remove it and every behavioral check reds on every run, for
a reason this page says nothing about. Anyone narrowing the seed should check that first.
