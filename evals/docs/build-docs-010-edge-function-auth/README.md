# build-docs-010-edge-function-auth

## What this eval measures

The subject is [Securing Edge Functions](https://supabase.com/docs/guides/functions/auth), not the agent. The prompt
is a product request plus the page's url, and the checks say whether an agent that read the page produced working
code. A gap in the page counts as a failure here.

One claim: the endpoint hands the caller their own orders, nobody else's, and gives a caller with no session
nothing.

The page offers four auth modes and puts two clients on the same context object, one of which bypasses row level
security. Which of those an agent reaches for is the whole outcome, and the prompt never names any of them.

## Why this is not the existing Edge Function auth evals

Three evals already drive this scenario and none of them measures the page.

- `evals/benchmark/build-functions-005-dual-auth-user-secret` is a specification, with no url, and asks whether
  agents reach the right design unprompted.
- `evals/regression/build-functions-006-dual-auth-with-server` names `@supabase/server` in the prompt and shows the
  import, so it measures the package rather than the page that documents it.
- `evals/other/build-functions-002-edge-auth-db` is a specification against the older forward-the-header pattern.

This eval is the third arm: the user asks for a feature, the page is the only thing pointed at, and nothing names a
package or a credential.

## Do not reintroduce the vocabulary

The prompt names the endpoint and what it should answer. It never names the mechanism, because whether the page
transmits the mechanism is the measurement. Keep all of these out of `PROMPT.md`:

JWT, token, `Authorization`, header, `verify_jwt`, RLS, row level security, policy, service role, secret key,
publishable key, anon, `withSupabase`, `@supabase/server`, `ctx.supabase`, `supabaseAdmin`, auth mode, claims,
credential, `createSupabaseContext`.

The route is named, because the scorer has no address otherwise and because the runtime is the user's own framing
rather than the answer. The answer is which credential the handler trusts.

## The seed carries the contract

`local/supabase/migrations/20240101000000_init.sql` is the shop's existing schema. Two things in it are
load-bearing.

- **The policy on `orders` is already correct.** Owner-scoped table policies are the subject of
  `build-docs-002-rls-guide`. Seeding a working one is also what turns the agent's choice of client into something
  observable: the page's promise is a client already scoped to the caller, and that promise only means something
  when there is a policy for it to honor.
- **The grants to both `authenticated` and `service_role`.** Current CLI versions add neither, and granting only one
  of them would decide the eval on a privilege rather than on the design. Either client can read the table, so the
  scorer measures what the handler does rather than what it is allowed to do.

`projectRunning: false`, so the agent writes its function and serves it. `cliVersion` is pinned because
`@supabase/server` validates against the new API keys, and the edge runtime only injects those on a new enough CLI.

## Do not drop the positive controls

`a signed-in customer does not get another customer's orders`, `a customer asking for another customer's orders
still gets only their own` and `a caller with no session gets no orders` all pass for an agent that built nothing,
because a route that does not exist leaks nothing. What makes them mean something is
`the order-history endpoint answers` and `a signed-in customer gets their own orders back`.

The two leak checks look for a run-scoped item name belonging to the other customer, not for an error or a status
code. A handler that answers 200 with an empty array passes them and fails the positive control, which is the right
way round.

`a caller with no session gets no orders` sends two requests, one carrying only the publishable key and one carrying
no headers at all. The first is the one worth reading: it gets past the gateway and has no user, which is the shape
a real unauthenticated caller has.

## The guide has to actually be read

The last check resolves the guide through the harness's own docs result, because a `search_docs` hit carries the url
in its result rather than its request. It requires retrieved content, not just a url that was reached.

Read `docs.calls` before reading the score. Docs evals run on one experiment and it is a no-skills one, so there is
no second arm to rule out prior knowledge. An empty `docs.calls` means the run measured nothing about the page,
whatever the checks say.

## What this eval does not score

- **Which package the handler uses.** Forwarding the caller's credentials to a plain client is still correct and
  still passes. A check that required `withSupabase` would fail a working endpoint and would have to be rewritten
  the next time the page changes its recommendation.
- **Whether row level security did the work.** Reading through the privileged client and filtering by the caller's
  own id produces the same answers and passes every check. It is a more fragile design and it is not wrong, so the
  outcome is what is scored.
- **The other three auth modes.** Service-to-service, public and webhook callers are a second claim, and the
  dual-auth case already has two evals of its own.
- **The status code on a rejected call.** The page shows a custom 401 as an option rather than a requirement, so the
  checks ask only that no order comes back.

## A risk worth knowing

**The leak checks read the response body, so a handler that fails for an unrelated reason passes them.** A 500 from
a bad query carries no order and reds nothing on its own. `a signed-in customer gets their own orders back` is what
catches it, and its note carries the status and the body.

**The probes send POST and retry as GET on a 405.** The prompt does not say which method the endpoint should take,
and an order history reads naturally as a GET. Sending only POST reds a correct handler, which is what the first
baseline did. The body's fields move to the query string on the retry.

**A worker that cannot reach the network reds two checks for a reason that is not the page.** `npm:@supabase/server`
is fetched at boot, and a sandbox that cannot resolve the registry answers `503` with a name resolution error on
every call. `the order-history endpoint answers` says so in its note. Treat such a run as lost rather than folding
it into the score.

**The edge runtime caches a booted worker.** With `policy = "per_worker"` the function is compiled on the first
request and reused, so swapping the handler's source and calling again answers with the previous one. A run is not
affected, because the agent writes the function before the stack starts. Anyone rescoring a workspace by hand has to
restart the runtime between attempts, or they score whatever ran last. A missing function answers `503 BOOT_ERROR`
rather than `404`, which is why `the order-history endpoint answers` rejects both.

**`a caller with no session gets no orders` is partly the platform's verdict, not the page's.** With the default
platform check left on, the request never reaches the handler, so an agent that wrote a wide-open handler still
passes as long as it left that default alone. The check is here because switching the default off is the reported
failure, and it only reds a solution that did both.
