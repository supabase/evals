import { type CheckResult, type ToolScorer } from '@supabase-evals/core';

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';

  const checks: CheckResult[] = [
    {
      name: 'named the affected customer data table',
      passed: /payment/i.test(report),
    },
    {
      name: 'identified anonymous or public access',
      passed: /\b(anon|anonymous|public)\b/i.test(report),
    },
    {
      name: 'proposed a concrete SQL mitigation',
      passed:
        /enable\s+row\s+level\s+security/i.test(report) ||
        /create\s+policy/i.test(report) ||
        /revoke\s+.*\s+from\s+anon/i.test(report),
    },
  ];

  const namedTable = checks[0].passed;
  const proposedFix = checks[2].passed;

  return {
    passed: namedTable && proposedFix,
    checks,
  };
};

export default scorer;
