# build-docs-011-database-functions

## What this eval measures

The subject is [Database Functions](https://supabase.com/docs/guides/database/functions), not the agent. The prompt
is a product request plus the page's url, and the checks say whether an agent that read the page produced working
code. A gap in the page counts as a failure here.

One claim: a customer can work out the figure for their own record and cannot work out anybody else's. It is asked
twice, for two functions, because the two serve different branches of the page's choice:

- `order_total` reads tables the customer can already read. Running as the caller is the easy answer, and every
  baseline run took it, so that function alone never reached the branch the page's danger note covers.
- `credit_balance` reads a ledger no customer can read directly. Running as the caller cannot reach it, so the
  agent has to run as the creator (or reopen the table, which a check reds). It is the one that exercises the branch.

The page presents the choice that decides this in one subsection, as a best practice with a rule attached: prefer
the caller's privileges, and if you use the creator's, pin the search path. A function that follows both halves of
that rule still answers a stranger, and still answers somebody with no session at all.

## Do not reintroduce the vocabulary

The prompt names the features, the functions' names and the requirements. It never names the mechanism, because whether
the page transmits the mechanism is the measurement. Keep all of these out of `PROMPT.md`:

security definer, security invoker, `search_path`, RLS, row level security, policy, grant, revoke, execute,
privilege, permission, role, `anon`, `authenticated`, schema-qualify, `rpc`, `plpgsql`, `language sql`,
`auth.uid()`.

The functions' names are given, because the scorer has no address otherwise and because both apps calling the same
name is the user's own framing. The argument names are not. The scorer reads each from `pg_proc` and calls the function
by whatever the agent chose, so `p_order_id` scores the same as `order_id`, and `credit_balance` takes the customer's id under whatever name the
agent picked. PostgREST matches a named argument
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

The expected order totals are exact rather than rounded: 4000 cents at 825 basis points is 330, so 4330. The checks
still allow a cent either way, so a solution that rounds differently is not red for it.

The ledger rows are not in the seed. The scorer inserts them after the agent's work, with per-run random amounts
(a refund, a goodwill credit and a purchase for each of two customers, the stranger's range always above the
customer's), so a function that returns a number it was written with cannot pass the positive control. The
`order_total` figures stay fixed so the recorded history is not disturbed, which leaves that function open to a literal
that returns 4330. The leak checks keep that from mattering in practice, since the stranger's own figure is 8660.

- **The ledger is closed to customers, and the contract lives in the seed.** `store_credit_ledger` has RLS enabled, no
  policy, and an explicit `revoke all` from `anon` and `authenticated`, so the closure does not depend on what a CLI
  version grants by default. The comment says in product words that nobody but staff reads the table and that the
  apps must not start to. That rule is deliberately not in the prompt. Putting it in the seed gains a positive control
  the scorer can prove and makes `a customer or signed-out visitor cannot read the store credit ledger directly` a
  fair check, at the cost of a discovery question for the agent. It also means a design that opens the ledger
  (`grant select` plus an owner policy, then an ordinary caller's-privileges function) is scored red. That is a
  recorded design choice and the only place this eval constrains the design.

`projectRunning: false`, so the agent writes its migration and starts the stack, which applies it.

## Do not drop the positive controls

`a customer cannot get another customer's total` and `a signed-out visitor cannot get an order total` both pass for
an agent that built nothing, because a function that does not exist answers nobody. What makes them mean something
is `a customer gets the right total for their own order`, and that check asserts the number rather than the absence
of an error.

The two leak checks compare against the other order's exact total. A function that returns null, or errors, or
returns the caller's own total, passes them. Only the stranger's actual number reds them, so a broken function
cannot be mistaken for a secure one. The same holds for the `credit_balance` pair, and
`a customer gets the right store credit balance for their own account` is its positive control. It asserts a random
per-run figure drawn from a ledger the customer cannot read, so it passes only for a function that reaches the ledger
on the customer's behalf.

`a customer or signed-out visitor cannot read the store credit ledger directly` passes for an agent that built nothing
as well. It exists beside that positive control, not instead of it, and it runs after the other probes, read-only.

`a signed-out visitor cannot get an order total` is the check that catches the compound case. A function running as
its creator is executable by everyone by default, so it is reachable with no session at all, and the page's two
statements about that sit in different subsections and are never connected.

`a function that runs as its creator pins its search path` is conditional. It ranges over both functions and reports
itself not applicable when none runs as its creator. For `order_total` that is the default and what the page
recommends, but `credit_balance` has to take the other branch, so the check now carries signal on every run that
reaches it.

## The guide has to actually be read

The last check resolves the guide through the harness's own docs result, because a `search_docs` hit carries the url
in its result rather than its request. It requires retrieved content, not just a url that was reached.

Read `docs.calls` before reading the score. Docs evals run on one experiment and it is a no-skills one, so there is
no second arm to rule out prior knowledge. An empty `docs.calls` means the run measured nothing about the page,
whatever the checks say.

## What this eval does not score

- **How the total is computed.** Any language, any body, any rounding within a cent. The page's own examples use
  both `sql` and `plpgsql` and neither is required.
- **Which design keeps the stranger out.** For `order_total`, running as the caller and letting the table policies do
  it passes. For either function, running as the creator with an explicit ownership check in the body passes, and so
  does revoking execute and regranting it to signed-in callers. A check that accepted one of them would constrain the
  page to a single recommendation. The one exception is opening the ledger, described under the seed.
- **Doing both safeguards.** The page recommends the ownership check and the narrowed execute grant together. A
  creator's-privileges `credit_balance` with only one of them passes, because the probes score the outcome. There is no
  static check that anon's execute is revoked, since an ownership check with the default grant is a correct design.
- **Logging, error handling and assertions.** Half the page is about debugging. It is a second claim and the prompt
  does not ask for it.
- **Returning data sets, or the client libraries.** Neither decides who can read what.

## A risk worth knowing

**The branch is only reached if the second function forces it.** The first version of this eval measured one function
that an agent can always serve as its caller, and scored 6 of 6 on every baseline run while the page's danger note went
unexercised (DOCS-1319). Whether `credit_balance` reaches the creator's-privileges branch on a meaningful share of runs
is a number to read off each refresh, not an assumption. If nearly every run still passes trivially, harden the seed
comment, never the prompt's vocabulary.

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
