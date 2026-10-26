# Shared helpers for CLI evals

Helpers used by more than one eval under `evals/cli/`. This directory has no
`PROMPT.md`, so eval discovery skips it — never add one, or a `local/` dir.

What belongs here: pure and probe helpers (`shell.ts`, `stack.ts`,
`stack-keys.ts`, `projects.ts`, `markers.ts`, `metrics.ts`, `migrations.ts`),
shared judge policy text and input formatters (`detours.ts`, `report.ts`).

What stays in each eval's `EVAL.ts`: check composition, every `ctx.judge()`
call, its scenario-specific rubric text, and `export default`. Scenario-only
helpers with a single consumer stay colocated with that eval.

Project stack targets (`{ kind: 'project', dir }` without a stack name) also
discover named managed stacks started from that directory via
`supabase stack list`, before falling back to the legacy backend.

`resolveStackWithAgentHomes` retries a failed resolution under each
`SUPABASE_HOME`/`HOME` the agent started the target with (`cli-invocations.ts`
records them per invocation, including an earlier `export` in the same
command) and marks the result with `relocatedHome`; `listCliOverrides` reports
`npx`/`bunx`/`npm exec`/`pnpm dlx`/`yarn dlx` runs and global installs of
another explicit CLI version, and `listUnverifiedRunners` the dist-tag ones.

`invocationTargets` attributes an invocation by `stop --project-id` (the only
verb whose `--project-id` is a local stack name; other verbs ignore it), then
the directory it ran in, then its `--stack` name; pass `knownTargets` (the
eval's sibling project or stack names) so a `--stack` name given inside another
known target's directory isn't credited to the named one.

`listCliOverrides(invocations, installedVersion, afterRunVersion)` takes the
PATH version read after the run: when it equals the staged version, the last
global install, if never uninstalled, did not take effect and its runner is
ignored. A later global install closes the previous install's span like an
uninstall does, so invocations it covered stay flagged (known cost: an install
that fails, starts on the staged CLI, then is retried and fails again is flagged).
Global installs and uninstalls are recorded in order whatever their tool call's
status, since a call's error reflects its last command.

`findSupabaseInvocations` also recognises `pnpm supabase`, `bun x supabase` and
`yarn supabase`, drops the fd number of a redirect (`2>&1`), and sets
`experimentalStack` when `SUPABASE_EXPERIMENTAL_STACK` is enabled in the
invocation's prefix, an earlier `export` in the same command, or the
`sandboxEnv` option. Scorers should pass
`(await ctx.environmentMarker())?.env` as `sandboxEnv` so the experiment's env
counts.
`invocationPositionals` returns an invocation's positional arguments, verb first, so a scorer can read a subcommand such as the `list` in `projects list`.
`commandToolCalls` returns the tool calls behind `extractCommands`' entries, so
an invocation's `commandIndex` maps back to its result.

Invocation attribution (`cli-invocations.ts`) starts from a tool call's `cwd`
only when the agent parser records one (Codex, OpenCode); a `cd` persisting
across separate tool calls in a persistent shell (e.g. Claude Code) is not
tracked.

`stack-keys.ts` reads a resolved stack's API keys (`supabase status -o json`, or
`supabase stack status --env` under the `SUPABASE_HOME`/`HOME`/`TMPDIR` the
agent started the stack with, matched by `relocatedHome`) and parses them even
when the command exits non-zero.

`stack-lifecycle.ts` reads the last stack start or stop command in the agent's invocations (flags included) and whether it left the stack stopped, so a scorer can name a stop as the reason its stack probe failed.

`migrations.ts` finds the migration file that creates a table (comments,
string literals and dollar-quoted bodies masked, `create [unlogged] table`
accepted) in a project directory, and checks its version is in the stack's
`supabase_migrations.schema_migrations`.

`redact.ts` replaces known secret values and secret-shaped text (URL passwords,
keys, flags, JSON and YAML fields, and the cells of table columns under an
upper-case `PASSWORD`, `SECRET`, `TOKEN` or `KEY` header) with `[redacted]`
before it reaches a judge or report; `tableSecretValues` returns those cell
values so a scorer can pass them back as known secrets, and `readProjectKeys`
lists the hosted project's key values to pass as the known ones.

Tests live beside each module; run them with:

```bash
pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
```
