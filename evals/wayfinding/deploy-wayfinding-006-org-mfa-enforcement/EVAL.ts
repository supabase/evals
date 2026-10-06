import type { CheckResult, ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

export const TARGETS = ['guides/platform/mfa/org-mfa-enforcement'];

const FACTS = [
  'Turn on the organization setting that requires MFA to access the organization, in the organization’s security settings.',
  'Only an organization owner can change it, and that owner needs MFA on their own account.',
  'Members without MFA lose access until they enable it (and it needs the Pro, Team, or Enterprise plan).',
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
