import type { CheckResult, ToolScorer } from "@supabase-evals/core";

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? "";
  const checks: CheckResult[] = [
    { name: "named stripe-webhook", passed: /stripe-webhook/i.test(report) },
    {
      name: "used recent or per-function framing",
      passed: /(last\s+15|recent|window|per[- ]function|by\s+function|group(ed)?\s+by\s+function)/i.test(report),
    },
    {
      name: "described elevated error rate",
      passed: /(spike|elevated|abnormal|high error rate|concerning|18%|0\.18|9\s*\/\s*50)/i.test(report),
    },
  ];
  const flagsWrongFunction =
    /(auth-callback|image-resize|daily-digest)/i.test(report) &&
    checks[0]?.passed !== true;
  if (flagsWrongFunction) {
    checks.push({
      name: "did not flag a non-planted function",
      passed: false,
    });
  }

  return {
    passed: !flagsWrongFunction && checks.every((check) => check.passed),
    checks,
  };
};

export default scorer;
