import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

export const TARGETS = [
  'guides/deployment/branching',
  'guides/deployment/branching/github-integration',
];

const FACTS = [
  'Use Supabase Branching, which creates a preview branch for pull requests.',
  'Connect the GitHub integration from the project’s integration settings in the dashboard.',
  'The repository holds the `supabase` directory with migrations, which run on each branch.',
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
