import type { CheckResult, ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

export const TARGETS = ['guides/deployment/going-into-prod'];

const FACTS = [
  'Enable Row Level Security on all tables.',
  'At least two security settings from: SSL enforcement, network restrictions, MFA on the Supabase account, or multiple org owners.',
  'Use a custom SMTP server for auth emails.',
  'Backups or Point in Time Recovery, or load testing and indexes for performance.',
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
