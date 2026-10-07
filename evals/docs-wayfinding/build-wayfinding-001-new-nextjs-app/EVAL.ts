import type { CheckResult, ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

export const TARGETS = ['guides/getting-started/quickstarts/nextjs'];

export const ALTERNATES = ['guides/auth/quickstarts/nextjs'];

const FACTS = [
  'Scaffolds the app, for example `npx create-next-app -e with-supabase`.',
  'Sets `NEXT_PUBLIC_SUPABASE_URL` and the publishable or anon key in the environment.',
  'Creates Supabase clients with the Supabase client libraries (for example `@supabase/ssr`).',
];

const scorer: ToolScorer = async (ctx) => {
  const verdict = await ctx.judge({
    input: ctx.agentReport ?? '',
    rubric: factsRubric(FACTS),
  });
  const checks: CheckResult[] = [
    checkReachedTarget(ctx, TARGETS, ALTERNATES),
    {
      name: 'answer covers the key facts',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
