import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

export const TARGETS = ['guides/api/rest/generating-types'];

const FACTS = [
  'Generate types with the CLI, `supabase gen types typescript` (for a project or the local database), or download them from the dashboard.',
  'Write the output to a file such as `database.types.ts`.',
  'Pass the generated type to `createClient`.',
];

const scorer: ToolScorer = async (ctx) => {
  const verdict = await judge({
    input: ctx.agentReport ?? '',
    rubric: factsRubric(FACTS),
  });
  const checks: CheckResult[] = [
    await checkReachedTarget(ctx, TARGETS),
    {
      name: 'answer covers the key facts',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
