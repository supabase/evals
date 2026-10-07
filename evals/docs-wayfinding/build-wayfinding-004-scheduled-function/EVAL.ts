import type { CheckResult, ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

export const TARGETS = ['guides/functions/schedule-functions'];

const FACTS = [
  'Uses `pg_cron` to schedule the job, with `cron.schedule` and a cron expression for 2am.',
  'Calls the function over HTTP with `pg_net` (`net.http_post`) at its URL.',
  'Stores the project URL and key the job sends in Supabase Vault, rather than in plain SQL.',
];

const scorer: ToolScorer = async (ctx) => {
  const verdict = await ctx.judge({
    input: ctx.agentReport ?? '',
    rubric: factsRubric(FACTS),
  });
  const checks: CheckResult[] = [
    checkReachedTarget(ctx, TARGETS),
    {
      name: 'answer covers the key facts',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
