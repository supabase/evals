# Shared helpers for CLI evals

Helpers used by more than one eval under `evals/cli/`. This directory has no
`PROMPT.md`, so eval discovery skips it — never add one, or a `local/` dir.

What belongs here: pure and probe helpers (`shell.ts`, `stack.ts`,
`projects.ts`, `markers.ts`, `metrics.ts`), shared judge policy text and
input formatters (`detours.ts`, `report.ts`).

What stays in each eval's `EVAL.ts`: check composition, every `judge()`
call, its scenario-specific rubric text, and `export default`. Scenario-only
helpers with a single consumer stay colocated with that eval.

Invocation attribution (`cli-invocations.ts`) starts from a tool call's `cwd`
only when the agent parser records one (Codex, OpenCode); a `cd` persisting
across separate tool calls in a persistent shell (e.g. Claude Code) is not
tracked.

Tests live beside each module; run them with:

```bash
pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
```
