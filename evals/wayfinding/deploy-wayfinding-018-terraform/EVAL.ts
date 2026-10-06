import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

export const TARGETS = [
  'guides/deployment/terraform',
  'guides/deployment/terraform/tutorial',
];

const FACTS = [
  'Use the Supabase Terraform provider (`supabase/supabase`).',
  'It authenticates with a Supabase access token (for example `SUPABASE_ACCESS_TOKEN`).',
  'An existing project can be imported and its settings managed.',
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
