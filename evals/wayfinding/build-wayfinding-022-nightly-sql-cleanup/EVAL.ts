import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

export const TARGETS = ['guides/cron/quickstart', 'guides/cron'];

export const ALTERNATES = ['guides/database/extensions/pg_cron'];

const FACTS = [
  'Use Supabase Cron, built on the `pg_cron` extension.',
  'Schedule the SQL delete with `cron.schedule` (or the dashboard) and a cron expression for nightly.',
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
