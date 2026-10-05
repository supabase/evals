import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

const TARGETS = ['guides/platform/network-restrictions'];

const FACTS = [
  'Uses Network Restrictions, from the dashboard database settings or the Supabase CLI.',
  'Allows the office as a CIDR such as `203.0.113.7/32`.',
  'Notes Owner or Admin permissions, IPv6 CIDRs, or that the restrictions apply to direct and pooled connections.',
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
