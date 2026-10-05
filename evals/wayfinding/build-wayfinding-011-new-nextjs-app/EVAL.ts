import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

const TARGETS = ['guides/getting-started/quickstarts/nextjs'];

const FACTS = [
  'Scaffolds the app, for example `npx create-next-app -e with-supabase`.',
  'Sets `NEXT_PUBLIC_SUPABASE_URL` and the publishable or anon key in the environment.',
  'Uses `@supabase/ssr` and `@supabase/supabase-js` for the clients.',
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
