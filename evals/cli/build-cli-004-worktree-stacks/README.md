# build-cli-004-worktree-stacks

One human plus N coding agents, each in its own git worktree, each needing its
own isolated local Supabase stack. The agent starts from an empty sandbox,
creates a repo with three worktrees (`feature-a`, `feature-b`, `feature-c`),
starts a stack in each, and applies a different migration plus one seed row
per worktree. The scorer then proves the three stacks are really three:
distinct database endpoints, and each table present in exactly one of them.

Tracks [CLI-2400](https://linear.app/supabase/issue/CLI-2400) under the
[Slim CLI evals RFC](https://linear.app/supabase/issue/CLI-2393). Lives in the
`cli` suite, so it runs on the pinned-CLI baseline plus the
`codex-gpt-5.6-luna-cli-{stable,beta,nodaemon,absent}` arms; `needsDocker:
false` lets the Docker-less arms pick it up.

## What the scorer checks

All checks inspect end state through `ctx.exec`. The harness's built-in
`ctx.query` / `ctx.stackStatus` resolve a single stack from the workspace root,
so this eval addresses each stack itself by `cd`-ing into its worktree.

1. Three real git worktrees named `feature-a/b/c`, each on its own branch.
   The scorer finds a repo in the workspace and asks `git worktree list
   --porcelain`, so worktrees the agent placed outside the workspace still
   count; three plain directories do not.
2. One live stack per worktree, with three distinct `host:port` database
   endpoints. Two worktrees reporting the same endpoint means the CLI aliased
   or reused a stack.
3. Schema isolation, one check per table: `to_regclass('public.<table>')` is
   non-null only against the home worktree's stack.
4. Data isolation: at least one row in each table in its home stack.
5. Each table is created by a migration file in its worktree, not ad hoc SQL.
6. A `metrics` check that always passes and reports fleet wall-clock (latest
   `pg_postmaster_start_time()` across the three stacks minus session start),
   the CLI version and channel, the backend and runtime each stack resolved to,
   and how many `supabase start` invocations the agent needed.

## How stacks are resolved

The scorer asks the managed stack first
(`SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json`)
and falls back to the legacy backend
(`SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json`). Both are forced via
the env var so the result does not depend on how the agent enabled the flag.
The managed backend rejects the legacy `-o json` flag, and the legacy backend
knows nothing about managed stacks, so neither alone is enough.

## Deliberate choices

- **No `services:` frontmatter.** With it set, the sandbox shim appends
  `-x gotrue,kong,...` to every `supabase start`; the managed backend only
  accepts capability names (`rest`, `auth`, ...) and rejects the command
  outright. Omitting `services` keeps the managed path reachable. The agent
  gets the full stack per `config.toml` and may trim it itself.
- **Nothing tells the agent about the managed stack, the feature flag, or
  port collisions.** Worktree isolation with no config edits only exists on
  the managed stack, which is gated behind `experimental.stack` /
  `SUPABASE_EXPERIMENTAL_STACK` and ships in the beta channel. Whether agents
  can discover that is part of what's being measured.
- **Known footgun, left in.** `supabase init` writes explicit ports into
  `config.toml`. The managed stack treats those as exact intents, so three
  worktrees sharing the committed config collide on the second start
  ("Persisted database port is unavailable") until the ports are removed and
  become automatic. On the legacy backend the same collision is solved only by
  editing `project_id` and every port per worktree.
- **Environment-agnostic**, like `build-database-002-stack-lifecycle`: the
  same eval runs under the pinned experiment and every `-cli-*` arm, and the
  scorer never branches on which one it is in.

## What the first CI run taught us

The first 18 runs (6 experiments × 3) shaped two details above:

- **The prompt says the project is brand-new.** An earlier wording said "set
  this repo up"; with an empty workspace, 12 of 18 agents looked for a
  repository, found none, and stopped to ask for it in about ten seconds.
- **Worktrees are found through git.** Two agents built everything correctly
  with worktrees at `/tmp/feature-*`, outside the workspace, and a name-based
  search under the workspace missed them.
- **Passing is possible today, via port surgery.** The two runs that passed
  were on the legacy backend, each with a hand-edited `project_id` and a full
  set of shifted ports per worktree. The `metrics` check records the backend
  so that path stays distinguishable from a managed-stack pass.
