import type { CheckResult, ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

export const TARGETS = ['guides/platform/sso', 'guides/platform/sso/gsuite'];

const FACTS = [
  'Sets up SSO at the organization level for signing in to the Supabase dashboard (not Supabase Auth SSO for an app’s own users).',
  'Configured with SAML in the organization’s SSO settings, with Google Workspace as the identity provider.',
  'Requires the Team or Enterprise plan.',
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
