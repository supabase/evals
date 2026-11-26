# build-docs-020-securing-your-api

## What this eval measures

The subject is [Securing your API](https://supabase.com/docs/guides/api/securing-your-api), not the agent. The prompt
is a product request plus the page's url, and the checks say whether an agent that read the page left the project's
API reaching what the user meant to publish and nothing the user meant to keep internal. A gap in the page counts as a
failure here.

The page carries four controls (grants, row level security, dedicated schemas, request checks), so it supports four
claims. This eval takes one: **after a user asks for a feature that needs staff-only data and a back-office job, the
Data API reaches the intended parts and does not reach the internal ones, and the server can still do its work.** Both
halves, because both have failed (supabase/agent-skills #413, #485, #376, #473 on leaving things open; #645, #196, #237
on closing them too far).

What it adds over its neighbours is reachability that does not depend on row level security:

- `build-docs-002-rls-guide` owns policy design on tables.
- `build-docs-006-database-tables` owns whether an agent protects new tables it was never told to protect.
- `build-docs-011-database-functions` owns whose privileges a function runs with.
- `evals/regression/resolve-dataapi-002-secure-default-grants` owns missing grants on a project that grants nothing.

The two traps here are ones none of them exercise. `alter default privileges` changes **future** objects only, so a
function created before the page's revoke block runs stays callable by everyone. And the page's revoke block also
revokes from `service_role`, so an agent that runs it and stops has closed its own back end out.

## Do not reintroduce the vocabulary

The prompt asks for a notes place, a replies place, and a nightly job. It never names the mechanism. Keep all of these
out of `PROMPT.md`:

grant, revoke, execute, privilege, permission, role, `anon`, `authenticated`, `service_role`, RLS, row level security,
policy, policies, expose, exposed, secure, security, schema, private, public (as a schema), default privileges,
security definer, security invoker, `rpc`, pre-request, API surface.

"Must never see" and "server side" are the user's own words and stay. The names `close_stale_tickets`,
`ticket_replies` and `ticket_notes` are given because the scorer has no address for the agent's objects otherwise; the
prompt names the function and points at `console/queries.ts` for the two tables.

## The seed carries the contract

`local/supabase/migrations/20240101000000_init.sql` is the desk as it stands. Four things in it are load-bearing.

- **`tickets` is already protected.** RLS is on, there are owner-scoped read and insert policies, and only
  `authenticated` holds grants. That is `build-docs-002-rls-guide`'s subject, so a mistake there cannot fail this eval
  for the wrong reason. `service_role` holds `select, update` so a function running as the server can close tickets.
- **The default privileges are seeded as SQL, not as `auto_expose_new_tables`.** The project is in the state the page's
  "default privileges" section describes: new tables, sequences and functions in `public` are granted to the client
  roles. The block follows the seeded tables on purpose, so the seeded objects keep their explicit minimal grants and
  only what the agent creates is affected. It is SQL rather than the config key because the key is temporary (the
  platform-defaults discussion schedules it for removal on 2026-10-30) and what unset resolves to has changed between
  CLI versions, so the seed holds the state on any CLI. **Do not replace it with the key.**
  `resolve-dataapi-002` does rely on the key; that is a latent break on a CLI bump and outside this eval.
- **`search_help_articles` is the one function meant for clients.** It keeps its default execute. Its job is to red an
  agent that closes functions with a blanket revoke.
- **The contract lives in `local/console/queries.ts`.** The table names, the columns (`ticket_id`, `body`) and the
  `close_stale_tickets` call are fixed there, and it says in product words that the console and the nightly job run on
  our server and the customer app never calls them. That rule is deliberately not in the prompt. Putting it in the
  seed gains a positive control the scorer can prove and makes `neither a customer nor a signed-out visitor can run
  close_stale_tickets` a fair check, at the cost of a discovery question for the agent. A design where customers can
  call the function is scored red. That is a recorded design choice, the same trade `build-docs-011` makes for its
  ledger.

The notes live in `public`, because the console's data layer reaches them through the API. A dedicated schema is not a
valid answer here; see the list at the end.

## Do not drop the positive controls

Four checks pass for an agent that built nothing: the two read-and-write refusals, the function refusal, and the
visitor function whitelist. Do not read them alone.

- `the database has ticket_replies, ticket_notes and close_stale_tickets` gates the other object checks. A missing
  object fails them with `not run`, never green.
- `replies are readable by the ticket's customer and by nobody else` is the control for the tables. The customer's own
  row has to come back before anyone else's absence means anything, so a table closed to everyone fails it. It needs
  the grant and a policy, which is the #645 shape.
- `the server key can write replies, and write and read notes` and `the server key can run close_stale_tickets` are the
  controls for the functions and tables being closed too far. The second needs a ticket idle for 60 days to close, a
  ticket touched today to stay open, and a count back, so a function that closes everything or nothing cannot pass.
- `a signed-out visitor can search the help articles` passes for an agent that built nothing, because the function is
  the seed's. It only bites after a blanket revoke.

Markers are written after the agent's work, as the superuser, with a value scoped to the run, so a hardcoded array or a
literal in a migration cannot satisfy a control and nothing leaks between runs. The write probe sends the whole contract
row and confirms the row's absence as the superuser. Any error other than `42501` is reported as not measured and fails,
so a request that bounced on a not-null column cannot score a wide-open table as closed (#264).

`no client can read the internal notes, including a customer on their own ticket` probes the ticket owner beside a
stranger and a visitor. That is the point of it: a policy copied from the replies onto the notes reads correctly and
hands staff-only text to the customer it is about.

The server-key checks run as the service role **inside the database** (`set local role service_role`) rather than over
HTTP with the secret key. The Data API switches to that role to serve a server-key request, so the privilege question is
the same, and the probe does not depend on how the stack's gateway maps a secret key. That is a deviation from probing
through the API and a known gap: it would not see a gateway-level problem.

## The guide has to actually be read

`the agent read the Securing your API guide the prompt referenced` resolves the url from the harness's own docs result,
because a `search_docs` hit carries the url in its result and not in its request. It requires retrieved content.

**Read `docs.calls` before reading the score.** An empty array means the run measured nothing about the page. Docs evals
run on one experiment and it is a no-skills one, so there is no second arm to rule out prior knowledge. A pass on
the table checks is regression cover, not proof the page carried the result.

## Where the signal is expected

Written before any run.

- **Expected to saturate:** the migrations check, the existence check, the write refusals, and the stranger and visitor
  halves of the read checks. An agent that enables RLS on a new table passes them from memory.
- **Where it should bite:** the function checks (`close_stale_tickets` left callable, and the visitor whitelist); the
  owner half of the notes check; and over-revocation (`search`, `the server key ...`) after an agent follows the page's
  revoke block. Whether agents reach the over-revocation branch is a number to read off each refresh. If it never
  fires, harden the seed comment. Never loosen the prompt's vocabulary.

## What this eval does not score

- **Dedicated API schemas.** The page's third control. The console's data layer fixes `public`, so a solution that moves
  the notes to an unexposed schema cannot be probed through the API. A second claim.
- **Exposed-schema configuration** (`[api].schemas`, #498, #373). A configuration claim where the CLI config page and
  observed behaviour disagree; it would score the CLI, not the page. The visitor function whitelist does read
  `config.toml` to find any schema the agent added, which is a source-level read and cannot see a schema exposed any
  other way.
- **Pre-request checks and rate limits, and turning the Data API off.** Separate claims with no seed affordance.
- **Table grants on RLS-protected tables.** `build-docs-006` recorded that asserting the `anon` write grant is gone fails
  the canonical answer, where RLS gates the rows. This eval scores the outcome per table and asserts a privilege only
  for functions, where RLS cannot be the control.
- **Policy quality.** One policy per operation, wrapped `auth.uid()`, indexes: `build-docs-002`'s.
- **Whether a customer may post a reply.** The prompt does not rule it out, so the write check does not ask.
- **Extra helper functions the agent adds.** The visitor function whitelist reds one a visitor can run, which is right by
  the page ("grant `execute` only to the roles that need to call them") and a narrow false-red edge for a helper an
  agent could reasonably leave open.
- **An agent that adds a required column the console does not send.** It breaks the console, which the seed's
  superuser marker insert and the server-key check both report. That is correct to red.

## A risk worth knowing

**What a new object gets depends on the CLI.** Run the page's own `pg_default_acl` query against a fresh stack before
trusting a baseline. The repo's READMEs disagreed about the pinned CLI: `resolve-dataapi-002` says unset resolves to
full grants on 2.116 and later, while `build-docs-009`, `-010` and `-011` say new tables get no client grants. The
seeded default privileges make this eval independent of the answer, but the interpretation of a result is not.

**This eval has not been run end to end.** It was written and typechecked without a Docker daemon, so no probe has met
a real stack. Score the example solutions listed in the plan and read each failure's notes before reading a baseline.
