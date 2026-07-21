import type { CheckResult, ToolScorer } from "@supabase-evals/core";

const scorer: ToolScorer = async (ctx) => {
  const usedQueryLogs = ctx.toolCalls.some((tc) => tc.endpoint === "query_logs");
  const usedGetLogs = ctx.toolCalls.some((tc) => tc.endpoint === "get_logs");

  const checks: CheckResult[] = [
    { name: "used query_logs on a hosted project", passed: usedQueryLogs },
    { name: "did not fall back to get_logs", passed: !usedGetLogs },
  ];

  return { passed: checks.every((check) => check.passed), checks };
};

export default scorer;
