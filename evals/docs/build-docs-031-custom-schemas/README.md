# build-docs-031-custom-schemas

## What this eval measures

The [Using Custom Schemas](https://supabase.com/docs/guides/api/using-custom-schemas) guide, not the agent. The prompt
is a product request plus the page's url, and the checks say whether an agent that read the page ended up with a
project whose custom schema is reachable through the Data API, for the visitor's key and the server's, and nothing
else is. A gap in the page counts as a failure.

One claim: **a custom schema is exposed with grants and queried through the Data API.** Three things on the page are
what this eval leans on, each tried on a real local stack (CLI 2.117.0) before any check was written:

- Step 1 is a Dashboard setting ("Exposed schemas"). A local project has no Dashboard to the agent, and the page names
  no local counterpart (`[api] schemas` in `supabase/config.toml`, or `pgrst.db_schemas` on the `authenticator` role).
  Until something is done, every call answers `PGRST106 Invalid schema`.
- Step 2's grants. An exposed schema with no grants answers `42501 permission denied for schema`, and a table added
  later answers `42501 permission denied for table` unless the `alter default privileges` lines were run too. The
  grants cover the tables that exist today.
- The page says to add the schema and to grant it, and says nothing about keeping other schemas out. An agent that
  exposes everything, or that grants broadly to make an error go away, opens what it was never asked to.

Checked against the page at supabase/supabase `main` as of 2026-11-24.

## Where the checks came from

No user evidence for this page turned up, which the ticket said to expect.

- **Reached:** the page, and the local stack itself: the three answers above, the page's grants and
  `Accept-Profile`/`Content-Profile` calls, and what each way of exposing a schema does across a stop and start.
- **Out of reach:** Linear, Slack, Hex, the internal report.

`build-docs-020-securing-your-api` covers the opposite direction (what the API leaves reachable); this one covers
getting a custom schema reachable and keeping the rest closed.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

schema, expose, exposed, grant, privilege, usage, anon, authenticated, service_role, role, Data API, PostgREST,
`Accept-Profile`, `Content-Profile`, `config.toml`, `search_path`, `default privileges`, RLS.

"Area of the database", "visitors", "browser", "the staff records" and "extra setup" stay, because they are the
user's words.

## The seed carries the contract

- `local/app/articles.mjs` and `publish.mjs` are the page's and the job's side. They fix the schema name
  (`help_center`), the table (`articles` with `title`, `body`, `published`), that visitors use the public key and the job
  uses the secret key, and that the schema is addressed with `.schema('help_center')`. This is the discovery question
  the eval gives up for an observable answer.
- `local/supabase/migrations/20240101000000_create_help_center.sql` opens with a comment saying it has already run and
  changes go in a new file. That pre-solves the migrations guide's claim on purpose: the harness applies this file
  before the agent starts, so grants appended to it never reach the database, and two of the first three baseline runs
  reddened every API check for exactly that, with correct SQL. It creates the schema, with a policy so visitors only
  see published articles. That is pre-solved on purpose: row level security is another guide's claim, and a mistake in
  it must not fail this eval for the wrong reason. It also creates `staff.salaries`, the schema nobody asked to expose.
- `services: gotrue, kong, postgrest`, because the checks go over the API. `kong` does not come up without `postgrest`.

## Do not drop the positive controls

- `a visitor reads the published articles and not the drafts` is the control for the staff check. The scorer adds a
  published and a draft article after the agent is done, with a marker, so nothing the agent wrote can satisfy it. When
  it fails the staff check fails with a `not run` note, because a refusal only means something once the visitor's own
  read works.
- `the server key adds a published article` confirms the row as the superuser instead of reading it back with the server
  key, because a server that only adds articles has no need to read them and a least-privilege grant is correct work.
- `a table added to help_center later is readable through the API without more setup` creates a table as the admin
  account once the agent is done, the way the project's own migrations do, and reads it as a visitor. Only a standing
  arrangement for tables made later passes.
- Calls are what the page's cURL tab sends: the table as the route, with a profile header. Only the API's own
  refusals count as refusals.

## The scorer restarts the stack

The API reads which schemas to expose when it starts, so the scorer runs `supabase stop` then `supabase start` after
applying the agent's migrations, whether or not the agent restarted it. An agent that edited the config and stopped has
still said what the project exposes. An exposure set in the database (`alter role authenticator set pgrst.db_schemas`)
survives the restart. An invalid value in the config fails here, which costs `the local stack starts with the project
settings` and reports the rest as `not run`. Right after a restart or a new table, a call can hit the API's `PGRST002`
or `PGRST205`; the scorer asks again for up to eighteen seconds, and never on a refusal.

## Predicted to saturate, and what failed

The probes ran against a real local stack with example solutions, kept local and never committed. Predictions were
written before running and all held. (The two solutions that depend on the schema not being exposed were run against a
stack whose config already exposed it, so they show the closed answer, not `PGRST106`.)

| Solution | Red checks |
| --- | --- |
| exposed, the page's grants and default privileges | none |
| exposed, no grants | `visitor`, `server`, `later`, `staff` (not run) |
| grants on the tables that exist, no default privileges | `later` |
| `staff` exposed and granted as well | `staff` |
| row level security turned off | `visitor` |
| a visitor-only grant, nothing for the server | `server` |
| nothing built | all four |

The signal is in the exposure and in the default privileges. An agent that exposes the schema, grants it and runs the
default privileges passes everything, which is a correct answer and not a defect.

## First baseline

`codex-gpt-6-luna-no-skills`, two refreshes of three runs. The first refresh, before the seed migration carried its
"already run" comment, scored 7/7, 3/7 and 3/7: the two reds had appended correct grants to the migration the harness had
already applied, so they never reached the database and every API check answered `42501`. That is the migrations
guide's claim, not this page's, which is why the seed now says it. The second refresh scored **7/7, 6/7 and 7/7**. All
three exposed `help_center` in `supabase/config.toml` (not `staff`), granted it in a new migration, and added default
privileges. The 6/7 run wrote the new migration and never applied it, so the scorer did, and only
`the agent applied the migrations it wrote` reds. The API checks all passed for the right reason, which the example
solutions above show: each failure shape reds the check it was aimed at.

So this claim holds for the model on this page, and the eval is mostly saturated for it. A pass says the page works for
a model that reads it, which is a correct answer and not a defect. Scoring took about 28 seconds after the agent
stopped, including the restart. Refresh before describing how agents fail, and say which refresh a failure mode came
from.

## The guide has to actually be read

`the agent read the custom schemas guide the prompt referenced` fails unless a docs call returned the page's content.
Read `docs.calls` before the score. Reading the page and knowing Postgres produce the same result on a mainstream
task, so a pass doesn't attribute the work to the page.

## What this eval does not score

- **Signed-in users.** The `authenticated` role gets the same grants as the visitor's, and sign-up adds a token timing
  problem unrelated to the claim. The prompt says visitors are not signed in.
- **Generated types.** The page's note about `createClient<Database, 'myschema'>` is a TypeScript claim.
- **Other SDKs.** Dart, C# and cURL tabs. The scorer sends the cURL tab's calls, which is what every SDK does.
- **Least privilege.** The page grants `all` to three roles. Any grants that make the reads and the server's insert
  work pass.
- **How the change was persisted.** The scorer applies pending migrations first and gives that its own check, so
  grants run straight in the database pass. Whether they survive a reset is the migrations guide's claim.
