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
records them per invocation) and marks the result with `relocatedHome`;
`listCliOverrides` reports `npx`/`bunx`/`pnpm dlx` runs of another CLI version.

Invocation attribution (`cli-invocations.ts`) starts from a tool call's `cwd`
only when the agent parser records one (Codex, OpenCode); a `cd` persisting
across separate tool calls in a persistent shell (e.g. Claude Code) is not
tracked.

Tests live beside each module; run them with:

```bash
pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
```
