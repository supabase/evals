import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

export const TARGETS = [
  'guides/functions/schedule-functions',
  'guides/cron/quickstart',
  'guides/cron',
];

export const ALTERNATES = ['guides/database/extensions/pg_cron'];

const FACTS = [
  'Uses `pg_cron` to schedule the job, with `cron.schedule` and a cron expression for 2am.',
  'Calls the function over HTTP with `pg_net` (`net.http_post`) at its URL.',
  'Passes an authorization key, ideally stored in Vault rather than in plain SQL.',
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
