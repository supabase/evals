import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

const TARGETS = [
  'guides/deployment/database-migrations',
  'guides/local-development/database-migrations',
  'guides/deployment/managing-environments',
];

const FACTS = [
  'Track schema changes as migration files with the Supabase CLI (`supabase migration new` or `supabase db diff`).',
  'Apply them to a remote project with `supabase link` and `supabase db push`.',
  'Run the same migrations against staging and production, for example from CI or with branching.',
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
