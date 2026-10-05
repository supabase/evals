import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

const TARGETS = [
  'guides/deployment/shared-responsibility-model',
  'guides/platform/backups',
];

const FACTS = [
  'Supabase handles infrastructure, operating system maintenance, and Postgres backups.',
  'The customer is responsible for their data, schema, access control such as RLS, and keeping API keys and secrets safe.',
  'Some responsibilities are shared, such as upgrades, performance tuning, or resource allocation.',
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
