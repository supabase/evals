import type { CheckResult, ToolScorer } from '@supabase-evals/core';

// The function returns 200 on every call while `console.error`-ing the real
// failure. The request envelope (source 'function_edge_logs') therefore shows
// nothing wrong; the answer lives only in the console stream (source
// 'function_logs'), and only in its `event_message` column — `log_attributes`
// carries execution metadata, not the log line. See README.md.
//
// All checks are deterministic: the user asked for the exact error, so the
// report must quote the identifiers that only the seeded console line carries.

const FAILED_ORDERS = ['ORD-48213', 'ORD-48217', 'ORD-48220'];

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const namedOrders = FAILED_ORDERS.filter((id) => report.includes(id));

  const checks: CheckResult[] = [
    {
      name: 'quoted the SKU from the console error (WH-1002)',
      passed: /\bWH-1002\b/.test(report),
    },
    {
      name: 'attributed the failure to the SKU missing from the warehouse feed',
      passed: /warehouse feed/i.test(report),
    },
    {
      name: 'named at least one of the affected orders',
      passed: namedOrders.length > 0,
    },
  ];

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
};

export default scorer;
