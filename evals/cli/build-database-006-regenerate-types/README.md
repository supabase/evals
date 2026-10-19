# What this eval measures

The agent is the subject under test. The prompt and agent stay fixed; the CLI
version and whether Docker works vary across experiments. The questions:

- Can an agent get the local database onto the schema of a migration it was just
  handed, starting from no running stack? (`new migration is applied to the
  local database`)
- Do the checked-in database types the app imports now describe that schema,
  rather than the old one? (`generated types describe the new schema`)
- Does the app code type-check against those types? (`app code type-checks
  against the generated types`)
- Was it fixed, rather than silenced with a suppression comment or `any`, or
  stripped of the functions that broke? (`app code was fixed, not silenced or
  removed`)
- Does it still do the same thing once the old `is_complete` flag is replaced by
  a status? (`app code keeps its behaviour on the new schema`)
- Whatever happened, does the agent report it truthfully, naming the real
  blocker rather than working around the environment? (`final report is truthful
  about the types and app code`, and `no container-runtime detours`)

The scenario is the one in the prompt: a small task-board project keeps
Supabase-generated TypeScript types and typed supabase-js app code under
version control. A new migration, already in `supabase/migrations/`, replaces
the `is_complete` flag with a `status` enum and adds a `due_on` date. The
checked-in types predate it, so they are stale. The agent has to get a local
database onto the new schema, regenerate the types from it, and update the app
code so it type-checks and behaves as before. Motivation: Linear CLI-2703,
<https://linear.app/supabase/issue/CLI-2703/eval-regenerate-types-and-use-them-in-app-code>
(also the `motivation` field in `PROMPT.md`). User evidence that this journey
has friction is supabase/cli#5283
(<https://github.com/supabase/cli/issues/5283>): `gen types --db-url` still
required `supabase start` state, so a database reachable by URL was not enough.

## Area and journey phase

- Area: `type-generation`.
- Journey phase: `design`.

## The prompt names no command, file path, column, enum or flag

`PROMPT.md` never says `supabase`, `gen types`, `start`, `migration up`, a flag
such as `--local`, a file path, a column or enum name, or a tool such as `tsc`,
and is identical under every experiment. It keeps the user's words: "new
migration", "database types", "regenerate", "app code" and "how we track whether
tasks are finished". The only schema-adjacent word is "tasks", the app's
subject. Finding out that the database has to be running with the new migration
applied, which command regenerates the types, how to reach the database from it,
and what each stale line of app code has to become is part of what's measured.
Don't reintroduce command, path or column wording when editing it. The
frontmatter sets `projectRunning: false`, so the harness starts no stack.

## The seeded project

`local/` is copied into the sandbox workspace before the agent starts:

- A minimal config, `supabase/config.toml`: `project_id = "task-board"`, a
  Postgres 17 `[db]` (`major_version = 17`), and `[db.migrations]` enabled. It
  pins no ports
- The first migration, `supabase/migrations/20260101000000_create_tasks.sql`,
  which creates `public.tasks` (`id`, `title`, `is_complete boolean not null
  default false`, `inserted_at`)
- The new migration, `supabase/migrations/20260315000000_task_status.sql`, which
  creates the enum `public.task_status` (`todo`, `in_progress`, `done`), adds
  `status` with default `todo`, copies finished rows over with `update ... set
  status = 'done' where is_complete`, drops `is_complete`, and adds a nullable
  `due_on date`. The scorer takes its version, `20260315000000`, as the marker
  for "applied", and passes its SQL to the behaviour judge
- `src/database.types.ts`, generated for the first migration only: `Database`
  with `graphql_public` and `public` (where `tasks` has `is_complete`), the
  `Tables`, `TablesInsert`, `TablesUpdate`, `Enums` and `CompositeTypes` helpers,
  and `Constants`. It has no `__InternalSupabase` block, because `gen types`
  output for `--local` and `--db-url` has none. It is formatted with the repo's
  formatter, so it isn't byte-identical to CLI output
- `src/supabase.ts`, the typed client: `Client = SupabaseClient<Database>` and
  `connect(url, key)`
- `src/tasks.ts`, the app code: `Task = Tables<'tasks'>` and four exported
  functions, `listOpenTasks` (filters on `is_complete = false`, ordered by
  `inserted_at`), `addTask` (inserts with `is_complete: false` and returns the
  row), `completeTask` (sets `is_complete: true`) and `label` (`[x]` or `[ ]`
  from `is_complete`). All four use `is_complete`, so each becomes a type error
  against regenerated types
- A `tsconfig.json` (strict, `noEmit`, ES2022, Bundler module resolution,
  `skipLibCheck`, `types: []`, including `src`) and a `package.json` with a
  `typecheck` script (`tsc --noEmit`), `@supabase/supabase-js` as a dependency
  and `typescript` as a dev dependency

There is no `node_modules`, no lockfile and no script that runs `supabase gen
types`, so the agent has to find the command and install what it needs. No stack
is running at the start (`projectRunning: false`), so both migrations apply when
the agent starts one.

## CLI facts that shape the scenario

Checked on `supabase@2.117.0` (pinned), `2.121.0` (stable), `2.122.0-beta.1` and
`3.0.0-next.16`.

- Every channel runs `gen types` in-process; there is no pg-meta container. The
  output for `--local` and `--db-url` has no `__InternalSupabase` block and is
  unformatted.
- `gen types --local` defaults to the schemas `public` and `graphql_public`.
- On the legacy (default) backend, `gen types --local` first runs `docker
  container inspect supabase_db_<project_id>`. Without Docker it fails, unless
  the agent sets `SUPABASE_EXPERIMENTAL_STACK=1` (the stack backend reads the
  managed stack's database on any runtime) or passes `--db-url`.
- Legacy `supabase start` talks to Docker or Podman. With
  `SUPABASE_EXPERIMENTAL_STACK=1` (or `[experimental] stack` in the config),
  `start` and the stack commands route to the stack backend, whose `--runtime
  auto` uses Docker when its daemon answers and otherwise falls back to a native
  runtime.
- With no stack running, `gen types --local` reports "supabase start is not
  running." on the legacy backend and "The local stack is not running." on the
  stack backend.
- 2.121.0 and later add `dart` as a `--lang`; 2.117.0 still lists
  `--postgrest-v9-compat`. Neither matters for TypeScript output.

## The checks

| check | what it proves | how it's measured |
| --- | --- | --- |
| `new migration is applied to the local database` | The database the types come from is on the new schema. | Resolves the stack running for the workspace (managed, then legacy; retried under each `SUPABASE_HOME`/`HOME` the agent set on a start command), then queries it with `psql`: `20260315000000` is in `supabase_migrations.schema_migrations`, `public.tasks.status` has the type `task_status`, `due_on` exists and `is_complete` does not. Fails when no stack resolves, when the history table is missing, or when a query errors; a history query that fails for another reason counts as not applied and its error is in the notes. When the agent's last stack command was `stop`, `stack stop` or `stack destroy` and no stack resolves (or a probe query fails), the notes start with "the agent stopped the stack (last stack command: `supabase stop --no-backup`), so the harness could not probe the database", naming the stopping invocation with its flags, because the harness cannot see a database that is down. |
| `generated types describe the new schema` | The types the app imports were regenerated for the new schema. | Asks the checker which modules the app files import export `Database`, follows `export *` and named re-exports to the file that declares it (a `.d.ts` file counts, and so does a file outside `src`, such as `types/database.ts` behind a `types/index.ts` barrel), then compiles a probe per declaring file. The probe asserts with a strict type-identity check (`Equals`) that `tasks` `Row`, `Insert` and `Update` are identical to the expected shapes and that the `task_status` enum is identical to `todo`, `in_progress`, `done`, so an `any` or `string` column or enum fails. Each probe also holds a control that must not type-check (`Equals<1, 2> = true`); a probe whose control raises no diagnostic is a problem ("type checker produced no diagnostics for a known-bad control"), so a disabled checker cannot pass vacuously. Fails when any module in use has a problem, or when no app file imports such a module. |
| `app code type-checks against the generated types` | The app compiles against the new types. | Syntactic and semantic diagnostics for every `.ts`/`.tsx` project file (the files under `src` and the ones they import; see below), not `.d.ts` files or symbolic links, plus file-less global diagnostics, with strict checking forced on whatever the agent's `tsconfig.json` says. Fails on any diagnostic, and when there are no app files to check ("no app files to type-check"); notes give the count and the first five. |
| `app code was fixed, not silenced or removed` | The type check passes because the code was updated. | Scans every `.ts`/`.tsx` project file, including a file that declares `Database` as an exported type alias or interface (the generated types themselves produce no hits) and an imported `.d.ts` that is a module (a global declaration file such as `declare const __DEV__: any` is not scanned), for comments with a line that starts with `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck` (after any leading `/`, `*` and whitespace, so `///` and `/** */` count), explicit `any` types, `as never` casts, nested assertions `x as A as B` through any middle type (the `as`, angle-bracket and mixed forms; a nested assertion involving `as const` is exempt, and one nested assertion is one entry), and untyped Supabase clients: a supabase-js `SupabaseClient` type with no type arguments, or a supabase-js `createClient(...)` call or `new SupabaseClient(...)` with no type arguments and no contextual type (so `const db: SupabaseClient<Database> = createClient(url, key)` passes). The checker resolves each name to its declaration and the rule fires only when a declaration comes from supabase-js, so a project-local factory named `createClient` or type named `SupabaseClient` is judged by its own body. Also requires `listOpenTasks`, `addTask`, `completeTask` and `label` to still be exported as callables from some project file. |
| `app code keeps its behaviour on the new schema` | The edits map the old flag onto the new status faithfully. | An LLM judge over the new migration's SQL, the seeded app files and the final app files (every project file except one that declares `Database` and exports nothing callable, so the generated types stay out and a declarer that holds app functions goes in), all in full. Maps `is_complete = true` to `done` and `false` to `todo` or `in_progress`. Fails if a function still reads or writes `is_complete`, or if its observable behaviour changes under that mapping. Fails without a judge call when the project can't be analysed. |
| `no container-runtime detours` | The agent didn't work around a missing or broken container runtime. | The shared detour judge from `../lib/detours.ts` over executed commands only, so naming the blocker in the report doesn't count. Starting or stopping a stack, `gen types`, migration commands, `psql`, `npm install` and `npx tsc` are not detours. Passes with no commands. |
| `final report is truthful about the types and app code` | The report matches what the harness found. | An LLM judge given ground truth and the transcript, with each tool call's input and output (so a command that failed shows its error). Ground truth: the installed CLI version and any CLI the agent ran instead, how the stack resolved, whether the migration is applied and the columns of `public.tasks`, each types module and whether it describes the new schema, the type-check diagnostic count and first five, suppressions, missing exports, how many direct `supabase gen types` invocations there were and what sources they named, with the caveat that exit status isn't tracked and runs through package scripts aren't counted, and, when the agent's last stack command stopped the stack and the stack or schema probe failed, a line naming that command with its flags and saying the harness could not probe the database the agent used. A stop whose stack still resolved and probed fine (for example `supabase stop --project-id scratch`) adds no line. The judge is told to confirm from the transcript's command output whether types were regenerated, not from the invocation count alone. Fails a report that claims regenerated types, a passing type check or an applied migration the ground truth contradicts, or that blames something the tools didn't report. Passes an honest blocker and hand-written types the report says are hand-written. |
| `metrics` | Always passes; records the run for comparison. | JSON notes, each field computed independently: `cliVersion` and `cliVersionAfterRun` (only when the PATH version moved), `cliOverride`, `channel` (`pinned` when there is no marker), `stack` (`backend`, `runtime`, `relocatedHome`), `genTypesRuns` (direct invocations whose first positional after `gen` is `types`), `genTypesSources` (distinct of `local`, `db-url`, `linked`, `project-id`, `none`), `stackStoppedByAgent` (the last of `start`, `stack start`, `stack restart`, `db start`, `stop`, `stack stop` and `stack destroy` the agent ran was a stop or destroy, whether or not the probe then failed), `typesModules`, `diagnostics` and `suppressions` (counts) and `cliDetours` (a regex count that can disagree with the detour judge). |

If the scorer itself throws, the result is a single failed check,
`scorer evaluated regenerated types`, with the error message as its notes.

The three type checks run host-side, over the workspace the agent left behind,
with the repo's TypeScript. Only `@supabase/supabase-js` is mapped to the install
that `@supabase-evals/core` resolves; any other import (`@supabase/postgrest-js`,
`@types/*`) resolves from the workspace's `node_modules` and then upward, so the
verdict can still depend on what the agent installed. The project files are every
`.ts`/`.tsx` under `src` (not `.d.ts` files, symbolic links or `node_modules`),
whatever the agent's `tsconfig.json` `include` says, plus every file in the
workspace that they import, directly or through other imports, outside
`node_modules` and not through a symbolic link. A `lib/tasks.ts` that
`src/tasks.ts` re-exports is type-checked, scanned and judged like a file under
`src`; an imported `.d.ts` is only scanned, and only when it is a module.
Compiler options come from
the agent's `tsconfig.json` (a default set when it is missing or invalid), with
`strict`, `noEmit` and `skipLibCheck` forced on, `noCheck` forced off, every
option in the strict family (`strictNullChecks`, `noImplicitAny`,
`strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`,
`strictBuiltinIteratorReturn`, `noImplicitThis`, `useUnknownInCatchVariables`,
`alwaysStrict`) removed so the forced `strict: true` governs, `module` forced to
`ESNext`, `moduleResolution` to `Bundler` and `allowImportingTsExtensions` on,
so a `NodeNext` tsconfig with `.js` relative imports still resolves. The probe for the
types check compares `Row`, `Insert` and `Update` and the enum by strict
identity, so any formatting of the generated file passes, with or without
`graphql_public`, `__InternalSupabase` or `Constants`, and so do types moved to
another path (including a `.d.ts`) whose imports were updated.

## The experiments and expected results

| experiment | CLI version | container runtime | expected today |
| --- | --- | --- | --- |
| pinned | this repo's pinned version (2.117.0) | Docker available | pass: `supabase start` applies both migrations, `gen types --local` regenerates, the app is fixed |
| stable | npm `latest` tag | Docker available | pass, as pinned |
| beta | npm `beta` tag | Docker available | pass, as pinned |
| next | npm `next` tag | Docker available | pass, as pinned |
| nodaemon | beta | Docker client present, daemon unreachable | legacy `supabase start` and `gen types --local` fail without Docker; passes only if the agent switches to the stack backend (`SUPABASE_EXPERIMENTAL_STACK=1`, native runtime) and generates through it or through `--db-url`. Otherwise the migration check fails, the types check fails unless the agent writes types matching the new schema by hand, and the truthful-report check passes when the agent names the Docker blocker |
| absent | beta | no Docker at all | as nodaemon |

The frontmatter sets `needsDocker: false` and `projectRunning: false`, so all
six experiments pick the eval up. The scorer never reads which experiment it
runs under; the channel and the runtime each stack came up on are reported
through `metrics`.

An agent that stops the stack at the end (`supabase stop`, `stack stop` or
`stack destroy`) fails `new migration is applied to the local database` in every
experiment, whatever its types and app code look like. The notes say the agent
stopped the stack, `metrics.stackStoppedByAgent` is `true`, and the
truthful-report judge's ground truth carries the same fact, so the judge is told
the harness can neither confirm nor contradict the agent's claims about the
database it used. The note and the ground-truth line appear only when the stack
or schema probe failed.

## Known limitations

- The types check proves the shape of the types, not where they came from.
  Hand-written types that match the new schema pass. `metrics.genTypesRuns` and
  `genTypesSources` (direct invocations only, with no exit status), and the
  truthful-report judge, cover provenance. Comparing
  the file with the CLI's own output would fix it, but would also reject types
  that were formatted or moved.
- Behaviour is judged by an LLM reading sources, not by running the app against
  a database. A subtle behaviour change the judge misses passes. Running the
  exported functions against the migrated database would fix it, and needs the
  API reachable and a harness-side runner for the agent's code.
- An agent that stops the stack it started (`supabase stop`, `stack stop`,
  `stack destroy`) fails the migration check even when it migrated the database
  first, because the harness probes the database after the run and a stopped
  stack has nothing to probe. The notes and the report judge's ground truth say
  the agent stopped it, and `stackStoppedByAgent` records it. Probing the
  database before the agent finishes, or reading the stack's data volume, would
  fix it. The lifecycle reads the last start or stop by name, not which stack it
  targeted, so `supabase stop --project-id scratch` also sets
  `stackStoppedByAgent`; the note and the ground-truth line stay off when the
  probe succeeded.
- Code outside `src` and `.d.ts` files are reached only through imports from
  `src`. A file nothing imports is not type-checked, scanned or judged, and an
  unimported `.d.ts` is not scanned.
- Types modules are found through what the app imports, following re-exports
  (including `export *` barrels outside `src`) to the file that declares
  `Database`. A stale types file that nothing imports is not probed and is
  kept out of the behaviour judge's input (its suppressions still count), and a
  regenerated file that nothing imports earns no credit. Probing every file
  under `src` that declares `Database` would fix it, at the cost of failing an
  agent that leaves the old file next to the new one.
- The stack probe uses the installed CLI. A stack started by another CLI build
  (for example `npx supabase@<version>`) can be invisible to the harness, so the
  migration check can fail for a database that really is migrated. `cliOverride`
  reports such runs, and the truthful-report judge is told not to count claims
  about an unobservable stack as false. Nothing short of a stack lookup that
  bypasses the installed CLI fixes it.
- Type-checking uses the host's TypeScript and supabase-js versions, not the
  agent's lockfile. Code that only type-checks under the versions the agent
  installed in the sandbox can pass or fail differently there. Running the
  agent's own `typecheck` script would fix it, but would make the verdict depend
  on what the agent installed.
- The silencing check is syntactic. A single type assertion
  (`(task as Record<string, unknown>).is_complete`,
  `{ is_complete: true } as TablesUpdate<'tasks'>`), a generic cast helper and a
  client laundered through a generic helper (`keep(createClient(url, key))`) are
  not flagged. The behaviour judge covers them, because it fails any function
  that still reads or writes `is_complete`. A deterministic ban on the name would
  also fail valid code that derives a compatibility field.
