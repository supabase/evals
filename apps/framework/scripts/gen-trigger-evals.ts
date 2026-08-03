#!/usr/bin/env tsx
/**
 * One-shot codegen for the skill-trigger suite. Reads the 97 prompts
 * (`evals/trigger/prompts.ts`) and their hand-authored ground truth
 * (`evals/trigger/golden.ts`), and emits one self-contained eval dir per
 * prompt:
 *
 *   evals/investigate-trigger-<category>-<nn>/{PROMPT.md, EVAL.ts}
 *
 *   - <category>  the prompt's category (schema, security, …)
 *   - <nn>        the GLOBAL prompt index, zero-padded to 2 digits (00–96),
 *                 so a dir name maps 1:1 to a `golden` entry's promptIndex.
 *
 * PROMPT.md frontmatter: stage=investigate, suite=trigger, interface=mcp,
 * product=[database], topic mapped from category. EVAL.ts is a one-liner over
 * `createSkillTriggerScorer` (deterministic; no LLM, no sandbox, no DB) — the
 * expected-skill set and the closed skill set are inlined as literals so each
 * eval dir is standalone and does not import the trigger data files at runtime.
 *
 * Run once and commit the output (reviewers see real eval dirs, not runtime
 * codegen). Re-running overwrites the same files idempotently.
 *
 *   cd apps/framework && node --import tsx/esm scripts/gen-trigger-evals.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prompts, type Category } from '../../../evals/trigger/prompts.js';
import {
  golden,
  assertGoldenCoversAll,
} from '../../../evals/trigger/golden.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const EVALS_DIR = join(ROOT, 'evals');

// Closed skill set — inlined into every generated EVAL.ts. Canonical home:
// evals/trigger/golden.ts (TRIGGER_SKILLS). Kept in sync by the invariant test
// in trigger-report (assertGoldenCoversAll + a literal equality check).
// Multi-line form matches biome's formatter so re-runs are clean.
const TRIGGER_SKILLS_LITERAL = `[
  'supabase',
  'supabase-postgres-best-practices',
] as const`;

/** Map a prompt category to the frontmatter `topic` benchmark dimension. */
function topicFor(category: Category): string {
  switch (category) {
    case 'security':
      return 'rls';
    case 'schema':
    case 'performance':
    case 'data-ops':
      return 'sql';
    case 'monitoring':
    case 'general':
      return 'observability';
  }
}

/** Quote a skill name as a TypeScript string literal. */
const q = (s: string): string => `'${s}'`;

function promptMarkdown(text: string, category: Category): string {
  return `---
stage: investigate
suite: trigger
interface: mcp
product:
  - database
topic:
  - ${topicFor(category)}
---

${text}
`;
}

function evalTs(expectedSkills: readonly string[]): string {
  const expected = `[${expectedSkills.map(q).join(', ')}]`;
  return `import { createSkillTriggerScorer } from '@supabase-evals/core';

// ponytail: closed skill set inlined so this eval dir is self-contained and
// does not import the trigger data files at runtime. Canonical list lives in
// evals/trigger/golden.ts (TRIGGER_SKILLS).
const TRIGGER_SKILLS = ${TRIGGER_SKILLS_LITERAL};

export default createSkillTriggerScorer(${expected}, TRIGGER_SKILLS);
`;
}

async function main() {
  assertGoldenCoversAll(prompts);

  // Clear any prior generated dirs so re-runs don't leave orphans. Only
  // touches dirs matching the `investigate-trigger-` prefix.
  const generatedPrefix = 'investigate-trigger-';
  let cleared = 0;
  for (const g of golden) {
    const dir = join(
      EVALS_DIR,
      `${generatedPrefix}${g.category}-${String(g.promptIndex).padStart(2, '0')}`
    );
    await rm(dir, { recursive: true, force: true });
    cleared += 1;
  }

  let written = 0;
  for (const g of golden) {
    const prompt = prompts[g.promptIndex];
    const dirName = `${generatedPrefix}${g.category}-${String(g.promptIndex).padStart(2, '0')}`;
    const dir = join(EVALS_DIR, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'PROMPT.md'),
      promptMarkdown(prompt.text, g.category),
      'utf8'
    );
    await writeFile(join(dir, 'EVAL.ts'), evalTs(g.expectedSkills), 'utf8');
    written += 1;
  }

  console.log(
    `cleared ${cleared} prior dirs, wrote ${written} eval dirs under evals/`
  );
  // ponytail: no runtime check here — assertGoldenCoversAll above + the
  // trigger suite's invariant test cover correctness.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
