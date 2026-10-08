# Shared helpers for CLI evals

Helpers used by more than one eval under `evals/cli/`. This directory has no
`PROMPT.md`, so eval discovery skips it — never add one, or a `local/` dir.

What belongs here: pure and probe helpers (`shell.ts`, `stack.ts`,
`projects.ts`, `markers.ts`, `metrics.ts`), shared judge policy text and
input formatters (`detours.ts`, `report.ts`).

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
invocation's prefix or an earlier `export` in the same command.
`commandToolCalls` returns the tool calls behind `extractCommands`' entries, so
an invocation's `commandIndex` maps back to its result.

Invocation attribution (`cli-invocations.ts`) starts from a tool call's `cwd`
only when the agent parser records one (Codex, OpenCode); a `cd` persisting
across separate tool calls in a persistent shell (e.g. Claude Code) is not
tracked.

Tests live beside each module; run them with:

```bash
pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
```
