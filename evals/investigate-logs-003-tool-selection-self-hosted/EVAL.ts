import type { CheckResult, ToolScorer } from "@supabase-evals/core";

const scorer: ToolScorer = async (ctx) => {
  const usedGetLogs = ctx.toolCalls.some((tc) => tc.endpoint === "get_logs");
  const usedQueryLogs = ctx.toolCalls.some((tc) => tc.endpoint === "query_logs");

  const checks: CheckResult[] = [
    { name: "used get_logs on a self-hosted project", passed: usedGetLogs },
    {
      name: "did not attempt query_logs (unavailable on self-hosted)",
      passed: !usedQueryLogs,
    },
  ];

  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
