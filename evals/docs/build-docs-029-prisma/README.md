# build-docs-029-prisma

## What this eval measures

The [Prisma](https://supabase.com/docs/guides/database/prisma) guide, not the agent. The prompt is a product request
plus the page's url, and the checks say whether an agent that read the page ended up with Prisma running as an account
of its own, with no admin powers, and not as the admin login. A gap in the page counts as a failure.

One claim: **Prisma connects with its own limited role.** The page's first step creates a `prisma` role with
`bypassrls createdb`, `grant "prisma" to "postgres"`, and grants on the `public` schema. Three things on the page are
what this eval leans on:

- Step 3 puts `[DB-USER].[PROJECT-REF]` in the connection string, with the user changed to `prisma`. That is the
  pooler's form. Against a local database, which has no project ref, `prisma.<something>` is a role that does not
  exist, so the string does not sign in.
- Step 1's grants are on `public` only, and default privileges are for objects `postgres` creates. What Prisma
  creates itself is owned by Prisma, so the migration has to run as that role for the account to own its tables.
- `bypassrls` and `createdb` are the page's own advice. They are not held against the account here.

Checked against the page at supabase/supabase `main` as of 2026-11-24.

## Where the checks came from

- **Reached:** supabase/agent-skills#558, the page, and the local stack with a real Prisma install (7.10.1): the
  page's SQL, `prisma migrate dev` as the `prisma` role, and who owns what it made were each run before any check was
  written.
- **Out of reach:** Linear, Slack, Hex, the internal report.

#558 is a Prisma migration failure, a rolled-back migration retried by `migrate deploy`. It is evidence that Prisma on
Supabase goes wrong in ways the docs say nothing about, and the page has nothing about migrations that fail. It does
not say anything about which account Prisma connects as, so the check list comes from reading the page against how a
local stack behaves. That failure is not measured here.

Existing evals checked first: `build-docs-004-postgres-connection` measures which connection string a serverless
deploy uses, and `build-docs-025-postgres-roles` measures a read-only account for a dashboard tool from the Postgres
roles guide. This one is the Prisma page's own path: an account that has to create tables, and whether Prisma actually
ran as it.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

role, user (as in database user), privilege, grant, permission, superuser, `bypassrls`, `createdb`, schema,
`public`, `postgres`, pooler, session mode, transaction mode, `DIRECT_URL`, `prisma` as an account name.

"Login", "connection string", "migration" and "Prisma" stay, because they are the user's words.

## The seed carries the contract

- `local/app/.env` is where the connection string goes, empty. It is where the choice becomes observable, so the
  scorer reads it rather than the transcript.
- `local/app/package.json` pins Prisma to 7.10.1 and its companions. **This is a deliberate gap against the page.**
  The page's `npm install prisma` installs whatever npm's `latest` is. On 2026-11-24 that is `8.0.0-rc.35`, a different
  CLI whose commands are not the page's (`prisma --help` lists no `migrate`). With 7.10.1, `prisma init` also writes
  `prisma7.config.ts` where the page says `prisma.config.ts`. Both are the page's drift against the Prisma release, and
  a finding for the docs ticket. Neither is scored, because a runtime default is not the subject under test and a
  Prisma release would otherwise read as a docs change.
- `local/app/prisma.config.ts` and `prisma/schema.prisma` are the page's steps 2, 4 and 5, already done, with one
  model, `Article`. Another scenario's claim is pre-solved so a mistake there cannot fail this eval for the wrong
  reason.
- `local/supabase/migrations/20240101000000_create_staff.sql` creates `hr.salaries`, owned by the admin account. It is
  the object a limited account must not reach.
- `services: []`, because only Postgres is needed.

## Do not drop the positive controls

- `Prisma's connection string signs in` gates the other three. When it fails they fail with a `not run` note instead
  of passing.
- `Prisma's account can use the tables in public and cannot read the staff schema` reads a table Prisma made before it
  tries the staff schema, so a closed account fails on the control rather than passing on the refusal. Only
  SQLSTATE `42501` counts as a refusal. Anything else is reported as could-not-measure.
- `Prisma's first migration ran as that account` reads ownership from the catalog and requires a finished row in
  `_prisma_migrations`, so a role that was created and never used fails it.

## Predicted to saturate, and what failed

The probes ran against a real local stack with a real Prisma install, with example solutions kept local and never
committed. Predictions were written before running and all held.

| Solution | Red checks |
| --- | --- |
| the page's role, `.env` as that role, migration run as it | none |
| `.env` as `postgres`, migration run as it | `account`, `confined` |
| the role is a member of `service_role` | `account` |
| role made, migration run as `postgres` | `migrated` |
| role made, no migration run | `migrated`, `confined` (not run) |
| `.env` as `prisma.<ref>`, the page's form | all four (signs in fails) |
| `.env` left empty | all four |
| the role also granted `select` on `hr` | `confined` |

The signal is in `signIn` and `migrated`. An agent that signs in with the right user and runs the migration as it
passes everything, which is a correct answer and not a defect.

## First baseline

`codex-gpt-6-luna-no-skills`, one run: **6 of 6 checks**. The agent read the guide, installed the pinned packages, made
its own `prisma` login with `CREATEDB` (it left out the page's `bypassrls` and the grants on `public`'s existing
objects, and gave Prisma access to `public` only), put the connection string in `app/.env`, and ran
`prisma migrate dev`. The tables belong to `prisma` and the staff schema is closed to it. The checks passed for the
right reason, which the example solutions above show: each of the failure shapes reds the check it was aimed at.

So this claim holds for the model on this page, with Prisma pinned. A pass here does not say the page's SQL was
used as written. Refresh before describing how agents fail, and read the gaps listed under the seed (the unpinned
Prisma version and the init file name) as the page's findings, which this eval does not score.

## The guide has to actually be read

`the agent read the Prisma guide the prompt referenced` fails unless a docs call returned the page's content. Read
`docs.calls` before the score. Reading the page and knowing Postgres produce the same result on a mainstream task, so
a pass doesn't attribute the work to the page.

## What this eval does not score

- **The serverless variant.** The transaction pooler, `pgbouncer=true` and `DIRECT_URL` are a second claim, and the
  local stack's pooler is off.
- **Whether `bypassrls` or `createdb` is wise.** The page prescribes both, so the account is allowed them.
- **`grant "prisma" to "postgres"`.** The page says it is needed to see changes in the Dashboard. Locally `postgres`
  can read the tables either way, so there is nothing to observe.
- **Whether the Data API can reach the tables.** The page tells users to turn it off when they use only Prisma.
- **Prisma versions, init file names and deps.** See the seed.
- **How the account was made.** The scorer applies pending Supabase migrations first and gives that its own check, so
  a role created straight in the database passes. Whether it survives a reset is the migrations guide's claim.
- **Prisma's own migration history after the first one**, drift, and `migrate deploy`. That is what #558 is about.
- **Querying through the generated client.** The scorer reads the catalog and signs in with the string, so a client
  that was generated but never queried passes.
