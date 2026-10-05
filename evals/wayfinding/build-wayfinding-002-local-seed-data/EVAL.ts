import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

const TARGETS = ['guides/local-development/seeding-your-database'];

const FACTS = [
  'Puts the sample data in a seed file, `supabase/seed.sql` by default.',
  'Seed files run on `supabase start` and on `supabase db reset`, after migrations.',
  'Optionally mentions configuring seed paths under `[db.seed]` in `config.toml`.',
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
