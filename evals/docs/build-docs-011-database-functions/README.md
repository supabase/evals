# build-docs-011-database-functions

## What this eval measures

The subject is [Database Functions](https://supabase.com/docs/guides/database/functions), not the agent. The prompt
is a product request plus the page's url, and the checks say whether an agent that read the page produced working
code. A gap in the page counts as a failure here.

One claim: a customer can work out the total for one of their own orders and cannot work out anybody else's.

The page presents the choice that decides this in one subsection, as a best practice with a rule attached: prefer
the caller's privileges, and if you use the creator's, pin the search path. A function that follows both halves of
that rule still answers a stranger, and still answers somebody with no session at all.

## Do not reintroduce the vocabulary

The prompt names the feature, the function's name and the requirement. It never names the mechanism, because whether
the page transmits the mechanism is the measurement. Keep all of these out of `PROMPT.md`:

security definer, security invoker, `search_path`, RLS, row level security, policy, grant, revoke, execute,
privilege, permission, role, `anon`, `authenticated`, schema-qualify, `rpc`, `plpgsql`, `language sql`,
`auth.uid()`.

The function's name is given, because the scorer has no address otherwise and because both apps calling the same
name is the user's own framing. The argument name is not. The scorer reads it from `pg_proc` and calls the function
by whatever the agent chose, so `p_order_id` scores the same as `order_id`. PostgREST matches a named argument
exactly, and `order_items.order_id` is a real column, so a hardcoded argument name would answer PGRST202 on a
correct function, red the positive control, and let both leak checks pass on the same error. The answer the eval
wants is whose privileges the function runs with.

## The seed carries the contract

`local/supabase/migrations/20240101000000_init.sql` is the shop's existing schema. Three things in it are
load-bearing.

- **The tax rate lives on the order.** `orders.tax_rate_bps` defaults to 825, and the comment says what basis points
  are. Without a fixed rate the expected total is whatever the agent invented and no check can assert a number.
- **The policies on `orders` and `order_items` are already correct.** Owner-scoped table policies are the subject of
  `build-docs-002-rls-guide`. Seeding working ones is also what turns the agent's choice into something observable:
  a function running as its caller inherits them, and one running as its creator does not.
- **The select grants.** Current CLI versions add neither, and without them nothing can read the tables at all.

The expected totals are exact rather than rounded: 4000 cents at 825 basis points is 330, so 4330. The checks still
allow a cent either way, so a solution that rounds differently is not red for it.

`projectRunning: false`, so the agent writes its migration and starts the stack, which applies it.

## Do not drop the positive controls

`a customer cannot get another customer's total` and `a signed-out visitor cannot get an order total` both pass for
an agent that built nothing, because a function that does not exist answers nobody. What makes them mean something
is `a customer gets the right total for their own order`, and that check asserts the number rather than the absence
of an error.

The two leak checks compare against the other order's exact total. A function that returns null, or errors, or
returns the caller's own total, passes them. Only the stranger's actual number reds them, so a broken function
cannot be mistaken for a secure one.

`a signed-out visitor cannot get an order total` is the check that catches the compound case. A function running as
its creator is executable by everyone by default, so it is reachable with no session at all, and the page's two
statements about that sit in different subsections and are never connected.

`a function that runs as its creator pins its search path` is conditional. It reports itself not applicable when the
function runs as its caller, which is both the default and what the page recommends, so it carries signal only on
the solutions that took the other branch.

## The design check takes three answers, not two

`the function's design accounts for who is calling` is the static counterpart to the two leak probes. It reds one
shape: a function that runs as its creator, never reads the caller's identity, and is still executable by `anon`.
That is the compound case the page's two statements never connect, and the one a solution can reach while doing
everything the `search_path` rule asks.

It accepts three mechanisms, not two. Running as the caller is the first, and it has to be, because the seeded
policies are the safeguard on that branch: a solution that inherits them has no ownership predicate in its body and
no revoke, and requiring either would red the design the page recommends. The other two are an ownership check in
the body, read as any reference to the caller's identity, and execute taken away from `anon`.

The check is deliberately permissive about what it accepts, because its job is to name the mechanism, not to grade
it. A function that runs as its creator, revokes execute from `anon`, and still skips the ownership check passes
this check and reds `a customer cannot get another customer's total`. That split is the point: this check reports
whether the design considered the caller at all, and the probes report who actually got an answer.

It evaluates on both branches rather than reporting itself not applicable, so its notes say which mechanism each
solution used. What it cannot do is move the score on the branch the sampled agent actually takes. Running as the
caller satisfies it by construction, so a run that never reaches the creator's privileges scores it the same way it
scores everything else. Measuring the creator's-privileges guidance on a meaningful share of runs needs a scenario
where the caller's privileges are not the easy answer, which is a second eval rather than a check here.

## The guide has to actually be read

The last check resolves the guide through the harness's own docs result, because a `search_docs` hit carries the url
in its result rather than its request. It requires retrieved content, not just a url that was reached.

Read `docs.calls` before reading the score. Docs evals run on one experiment and it is a no-skills one, so there is
no second arm to rule out prior knowledge. An empty `docs.calls` means the run measured nothing about the page,
whatever the checks say.

## What this eval does not score

- **How the total is computed.** Any language, any body, any rounding within a cent. The page's own examples use
  both `sql` and `plpgsql` and neither is required.
- **Which design keeps the stranger out.** Running as the caller and letting the table policies do it passes.
  Running as the creator with an explicit ownership check in the body passes. Revoking execute and regranting it to
  signed-in callers passes. A check that accepted one of them would constrain the page to a single recommendation.
- **Logging, error handling and assertions.** Half the page is about debugging. It is a second claim and the prompt
  does not ask for it.
- **Returning data sets, or the client libraries.** Neither decides who can read what.

## A risk worth knowing

**The page's `search_path` rule is satisfied by a solution that leaks.** A function running as its creator with
`search_path` pinned to the empty string does everything the page tells you to do for that branch, and hands any
signed-in customer, and any anonymous caller, any order's total. Both leak checks red it and the search path check
passes. That combination in the results is the finding rather than a scorer defect.

**Revoking without regranting breaks the feature.** The page shows the revokes and the regrant in separate blocks,
and a solution that takes the first without the second leaves the app unable to call its own function. That reds
`a customer gets the right total for their own order`, which is correct: nobody can get a total at all.

**New functions in `public` are executable by everyone.** That is Postgres's default and it still holds here, which
is what makes the anonymous probe meaningful. If that default ever changes, this eval's anonymous check starts
passing for a reason that has nothing to do with the page, and the note on the check is where to look.
