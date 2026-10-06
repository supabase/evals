import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

export const TARGETS = [
  'guides/platform/hipaa-projects',
  'guides/security/hipaa-compliance',
];

const FACTS = [
  'Sign a Business Associate Agreement (BAA) with Supabase and enable the HIPAA add-on.',
  'Configure the projects as High Compliance in the project settings.',
  'Required settings include things like Point in Time Recovery, SSL enforcement, or connection logging.',
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
