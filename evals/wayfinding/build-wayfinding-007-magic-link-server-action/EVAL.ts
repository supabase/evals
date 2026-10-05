import { judge, type CheckResult, type ToolScorer } from '@supabase-evals/core';
import { checkReachedTarget, factsRubric } from '../lib/wayfinding.js';

const TARGETS = [
  'guides/auth/auth-email-passwordless',
  'guides/auth/server-side/creating-a-client',
];

const FACTS = [
  'Creates a server-side client with `@supabase/ssr` that reads and writes cookies.',
  'Calls `supabase.auth.signInWithOtp` with the email address.',
  'Handles the link the user clicks, with a route that verifies it (`verifyOtp` with a token hash, or exchanging the code for a session).',
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
