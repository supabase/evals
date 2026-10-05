import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

const TARGETS = ['guides/platform/sso', 'guides/platform/sso/gsuite'];

const FACTS = [
  'This is organization SSO for the Supabase dashboard, not Auth SSO for the app users.',
  'Configured with SAML 2.0 under Organization Settings, SSO, using Google Workspace as the identity provider.',
  'Requires the Team or Enterprise plan.',
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
