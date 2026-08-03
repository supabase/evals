# Trigger suite

Measures **skill triggering** — whether an agent loads the right skills from their
descriptions alone — **not** end-state correctness. A passing run here says the agent
recognized which skills a prompt needs; it says nothing about whether it solved the task.

Each of the 38 evals reuses a prompt body from a canonical Supabase eval (see
[`MAPPING.md`](./MAPPING.md)) as a realistic user message, then checks only which skills
loaded. No sandbox, no database, no LLM judge — the scorer is pure analytics over the
run's tool calls.

## What it measures

The closed set of skills under test is two:

- `supabase` (S)
- `supabase-postgres-best-practices` (P)

Ground truth lives in [`golden.ts`](./golden.ts), one entry per prompt:

- **S** is expected on every prompt — all 38 name Supabase or an unmistakable
  Supabase-only concern (Edge Functions, Realtime, storage buckets, self-hosting).
- **P** is expected only on Postgres-mechanics prompts — schema, RLS, migration,
  query/index, performance. Edge-function/Realtime/storage/auth/self-hosting/
  observability-integration prompts are Supabase-meta, not Postgres mechanics, so a
  correct agent skips P.

Per [`MAPPING.md`](./MAPPING.md): 20 prompts expect `S+P`, 18 expect `S` only. Categories
span security (12), general (10), monitoring (7), schema (5), data-ops (3), performance (1).

## Scorer

Each eval's `EVAL.ts` is a one-liner over [`createSkillTriggerScorer`](../../packages/core/src/skill-trigger-scorer.ts)
from `@supabase-evals/core`. It compares loaded skills against the expected set and emits
one `CheckResult` per skill in the closed set:

| expected | loaded | result |
|----------|--------|--------|
| yes | yes | `loaded <skill>` — pass |
| yes | no | `loaded <skill>` — **fail** (missed) |
| no | yes | `<skill> not expected` — **fail** (false positive) |
| no | no | `correctly skipped <skill>` — pass |

`passed = no missed && no false positive`. Deterministic — no LLM, no sandbox, no DB.
The evals are `stage: investigate`, `suite: trigger`, `interface: mcp`, tools-mode with
no `localStack`, so the scoring context's DB surface is unused.

## Files

- [`prompts.ts`](./prompts.ts) — the 38-prompt corpus (prompt text + category), indexed to
  match `golden.ts`. Provenance stays with the canonical evals; no `motivation` is
  duplicated here.
- [`golden.ts`](./golden.ts) — hand-authored ground truth (expected skills per prompt).
- [`contexts.ts`](./contexts.ts) — per-prompt context fixtures.
- [`MAPPING.md`](./MAPPING.md) — idx → canonical eval, category, expected signal, prompt preview.
- `../investigate-trigger-<category>-<idx>/` — the 38 eval dirs (`PROMPT.md` + `EVAL.ts`),
  one per golden entry.

## Running

The suite is wired to the `trigger` experiment suite (custom, not `benchmark`):

- [`experiments/trigger-claude-sonnet-5.ts`](../../experiments/trigger-claude-sonnet-5.ts) —
  Claude with both skills available.
- [`experiments/trigger-no-skills-claude-sonnet-5.ts`](../../experiments/trigger-no-skills-claude-sonnet-5.ts) —
  no skills available; with nothing to load, every expected-skill check is a "missed". This
  baseline contrasts P(pass | loaded) vs P(pass | not loaded) per skill.
- [`experiments/trigger-openai-gpt-5.6.ts`](../../experiments/trigger-openai-gpt-5.6.ts) —
  the OpenAI model with both skills.

Run via the standard eval flow against the `trigger` suite, or use the standalone dev tool
while iterating on a `SKILL.md` description (no eval dirs or golden data required):

```bash
pnpm eval -- --experiment=trigger-claude-sonnet-5              # full suite
pnpm test-skill-triggers -- --skill=supabase-postgres-best-practices --category=schema
```

## Relationship to the canonical evals

This suite is a parallel measurement layer over the canonical eval prompts. The canonical
`evals/<id>/PROMPT.md` carries the scenario provenance (`motivation:`) and end-state
scorers; the trigger evals reuse only the prompt text to probe skill selection. See
[`MAPPING.md`](./MAPPING.md) for the per-eval derivation.