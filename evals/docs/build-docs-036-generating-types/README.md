# build-docs-036-generating-types

## What this eval measures

The subject is [Generating TypeScript Types](https://supabase.com/docs/guides/api/rest/generating-types), not the agent.
The prompt is a product request plus the page's url, and the checks say whether an agent that read the page gives an app
types that match the local database.

One claim: the types the app is created with match the live local schema, including a second exposed schema and a
database function, and the team's refresh command regenerates them after the schema changes.

## How it differs from build-database-006-regenerate-types

`evals/cli/build-database-006-regenerate-types` measures the agent across CLI versions and Docker setups. It hands over a
migration, and scores regenerating stale types and fixing app code that no longer compiles. This eval measures a docs
page on one CLI. The app code is already correct, the types do not exist yet, part of the schema sits outside `public`,
and the refresh command is run again by the scorer after it changes the database.

## Do not reintroduce the vocabulary

Keep all of these out of `PROMPT.md`:

generate, gen types, CLI, `supabase gen`, `--local`, `--schema`, schema, catalog, introspection, `database.types.ts`,
`Database`, `createClient<Database>`, type definitions, rpc, function, migration.

## The seed carries the contract

- `src/lib/supabase.ts` already calls `createClient<Database>` with `Database` from `./database.types`, which does not
  exist. The answer has a place to land. The checks find every `createClient<...>` call under `src/` and use its type
  argument and that file's imports, so a moved client, a namespace import or types kept under `supabase/` all pass.
- `CONTRIBUTING.md` names `npm run db:types` and says it refreshes the app's types from the local database.
  `package.json` has no such script. The refresh check needs a fixed command to run, so the name is given rather than
  discovered. The command behind it is the agent's choice.
- The migration puts `books`, the `book_format` enum and the `search_books` function in a `catalog` schema that
  `config.toml` exposes, and `orders` in `public`. A types file limited to `public` cannot compile the app.
- `config.toml` is minimal and has no `[inbucket]` section, so a newer CLI can read it too.
- `services: []` starts only the database. On CLI 2.117.0, `gen types --local` runs a one-off `postgres-meta` container
  of its own, so it works without that service started.

## Do not drop the positive controls

The probe holds two controls: `Equals<1, 2>` and a wrong row shape for `catalog.books`. Both must raise an error. The
second one catches a types module that did not resolve, because TypeScript stays silent about assertions on an
unresolved import. Without it an empty workspace scores green.

## How the checks read the end state

- The type checks run host-side on a copy of every `.ts` file outside `node_modules`, `.git` and `supabase/functions`,
  with the repo's TypeScript and `@supabase/supabase-js`. The workspace's `node_modules` is linked in for any other
  import, such as `type-fest`. The scorer and the read-back of the sandbox share one file filter.
- The whole strict family is removed from the agent's `tsconfig.json` and `strict` is forced on. Any `@ts-ignore`,
  `@ts-expect-error` or `@ts-nocheck` in a compiled file outside `node_modules` fails the first check. The seed has none.
- The probe compares, by type identity after flattening intersections, the `Row` of `catalog.books`, the `Args` and
  `Returns` of `catalog.search_books`, and the `Row` and `Insert` of `public.orders`. An `any` or `string` column fails.
  Output from CLI 2.117.0 and 3.4.0 both pass.
- `the refresh command picks up a new column in the local database` adds a column with a run-scoped name to
  `catalog.books`, links the sandbox's pinned CLI to `node_modules/.bin/supabase` when nothing is there, runs
  `npm run db:types`, reads the workspace back, and asserts the column is in the `catalog.books` row. The link means
  `supabase` and `npx supabase` in the script both run the pinned CLI with no download. It runs last because it changes
  the database. Score once per stack.

## The guide has to actually be read

`the agent read the generating types guide the prompt referenced` requires a docs call that reached the page with
content. Read `docs.calls` before reading a score.

## Checks expected to saturate

`the app type-checks in strict mode with no suppression comments`, because the agent can run `npm run typecheck` and see
the failure. The signal is expected in the probe check, for a types file limited to `public`, and in the refresh check,
for hand-written types, a script that writes somewhere the app does not import, or a script that targets a hosted
project.

## What this eval does not score

- **Whether the app code changed.** The seed's code is correct against the schema. The probe does not read it.
- **Generating types from a hosted project.** None is reachable locally.
- **Generating types for other languages.**
- **Overriding generated types.** An override that keeps the shapes above passes.
- **Keeping types current on a schedule.** Only the refresh command is run.
- **A stopped stack.** If the agent stops the database, the refresh check cannot add its column and fails.
