import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

const TARGETS = ['guides/getting-started/quickstarts/reactjs'];

const FACTS = [
  'Installs `@supabase/supabase-js`.',
  'Sets `VITE_SUPABASE_URL` and the publishable or anon key as environment variables.',
  'Creates a client with `createClient` and queries the table, for example `supabase.from(...).select()`.',
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
