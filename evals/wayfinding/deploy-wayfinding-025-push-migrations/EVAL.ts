import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

export const TARGETS = ['guides/deployment/database-migrations'];

export const ALTERNATES = [
  'guides/local-development/database-migrations',
  'guides/local-development/cli-workflows',
];

const FACTS = [
  'Link the local project to the remote one with `supabase link`.',
  'Push the migrations with `supabase db push`.',
];

const scorer: ToolScorer = async (ctx) => {
  const verdict = await judge({
    input: ctx.agentReport ?? '',
    rubric: factsRubric(FACTS),
  });
  const checks: CheckResult[] = [
    await checkReachedTarget(ctx, TARGETS, ALTERNATES),
    {
      name: 'answer covers the key facts',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
