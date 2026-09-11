# build-docs-007-edge-function-secrets

## What this eval measures

The subject is [Managing secrets](https://supabase.com/docs/guides/functions/secrets), not the agent. The prompt is a
product request plus the page's url, and the checks say whether an agent that read the page produced working code. A
gap in the page counts as a failure here.

One claim: a key that ships in browser code has to move somewhere only the function runtime can read, and it has to
land where the local runtime actually loads it.

## Do not reintroduce the vocabulary

The prompt names the runtime and the task. It never names the mechanism, because whether the page transmits the
mechanism is the measurement. Keep all of these out of `PROMPT.md`:

secret, secrets, environment variable, env var, `.env`, `supabase/functions/.env`, `--env-file`, `Deno.env`,
`supabase secrets set`, Edge Function, server-side, backend, gitignore, proxy, `VITE_`, publishable, service role,
key management.

The seed may carry product vocabulary the user would already have in front of them. The line is the prompt.

## The seed carries the contract

`local/src/App.tsx` holds the provider key as a literal and calls the provider straight from the browser. Its TODO
comment fixes three things the checks depend on:

- **The endpoint.** `POST /functions/v1/suggest`, taking `{ prompt }` and answering `{ suggestion }`. Without it the
  scorer has no address to probe, and the prompt would have to name the runtime instead.
- **The failure contract.** A 503 carrying `missing_api_key` when the credential is not reachable at request time.
  This is what lets the probe tell "the runtime handed the function the key" from "the function ran and read nothing".
  It buys a positive control the scorer can prove, at the cost of a discovery question, and that trade is deliberate.
- **The framing.** Written as the on-call rotation's requirement, so it reads as a team convention rather than a hint.

The key literal is not `sk-` or `sk-proj-` shaped. Push protection on this repo has already caught a fixture holding a
provider-shaped credential. The scorer reads the literal out of the seed at module load, so rotating it cannot leave
the checks hunting a value the app never carried.

`projectRunning: false` is load-bearing. `supabase start` bakes `supabase/functions/.env` into the edge runtime
container's environment at creation time, so a file written after the stack is up is invisible to it. Letting the agent
own the lifecycle is what makes the runtime claim measurable without the scorer restarting anything.

## Do not drop the positive controls

`the provider key is absent from the built client bundle`, `the provider key is absent from every client source file`
and `no client-exposed variable carries the provider key` all pass for an agent that deleted the key and built nothing
else. What makes them mean something is `the suggest endpoint has the provider key at request time`, which only passes
when a function is served and holds the credential.

The bundle scan reads the artifact Vite emitted rather than the source that produced it. An alias, a computed
`envPrefix`, or a wrapper around the call each defeat a source-level scan and none of them defeat this one.

`the provider key sits where the local function runtime loads it` is a source-level claim, and named as one. It
whitelists the default path plus any path a `--env-file` argument points at, rather than blocklisting the places that
do not work. Its behavioral counterpart is the request-time check.

**It tracks the name the function reads, not the value the seed shipped.** The first baseline is why. Agents replace
the placeholder with a credential of their own, so a check hunting the seeded literal reports "not in any file" on a
solution that placed a working credential correctly. What has to be true is that whatever env name the function reads
is set in a file the runtime loads. Platform names are excluded, because `SUPABASE_*`, `SB_*` and `DENO_*` are what
`supabase start` injects on its own and none of them is the credential this eval is about.

`the file holding the provider key is covered by the project's ignore rules` carves out `.env.example` and its
siblings. Shipping a template with a placeholder is the documented habit, and failing a solution for it would be a
false red.

## The guide has to actually be read

The last check resolves the guide through the harness's own docs result, because a `search_docs` hit carries the url in
its result rather than its request. It requires retrieved content, not just a url that was reached.

Read `docs.calls` before reading the score. Docs evals run on one experiment and it is a no-skills one, so there is no
second arm to rule out prior knowledge. An empty `docs.calls` means the run measured nothing about the page, whatever
the checks say.

## What this eval does not score

- **The production push.** `supabase secrets set --env-file`, `supabase secrets list`, and the dashboard flow.
  `evals/benchmark/deploy-functions-001-edge-function-secrets` owns the hosted side, including the secret landing on
  the project and the value staying out of the repo.
- **The default secrets list.** The page documents `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS` as JSON
  dictionaries, which is hosted behavior. The local CLI injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_URL` instead. A check here would report a CLI upgrade as a docs change.
- **Whether the upstream provider call succeeds.** The sandbox has no route to the provider, so a 5xx from the upstream
  call is the expected shape of a correct solution. Only the `missing_api_key` contract is scored.
- **Whether `verify_jwt` is on.** The prompt does not say, so the probe tries the publishable key and then no
  credentials, and either shape passes.

## A risk worth knowing

An agent that starts the stack before writing its key file, and never checks the endpoint, ships something broken and
fails `the suggest endpoint has the provider key at request time`. That is the finding rather than a scorer defect, and
the page documents both recoveries. It is still the check to watch across a baseline. If every run fails on ordering
alone, the check is harsher than intended and this section is where to say so.

An agent that answers `missing_api_key` for any error, including the upstream call failing, also fails that check. The
seed's contract is specific about which condition it covers.

**A working provider credential is reachable from inside the sandbox.** `packages/core/src/agents/codex/runner.ts`
logs the agent in with a live `OPENAI_API_KEY`, so an agent can place a credential that really works without ever
handling the seeded one, and the request-time check passes on a genuine upstream completion. That does not break the
claim, because placement is what is scored and the checks no longer care which value was placed. It does mean a
passing run can be making real provider calls, and it is why the placement checks are written against the name.
