import {
  assertion,
  type AssertionResult,
  type ToolScorer,
} from "@supabase-evals/core";

function reportedErrorRateAboveFivePercent(report: string): boolean {
  const percentMatches = report.matchAll(/\b(\d+(?:\.\d+)?)\s*%/g);
  const hasPercentAboveFive = Array.from(percentMatches).some((match) => Number(match[1]) > 5);
  if (hasPercentAboveFive) return true;

  const decimalMatches = report.matchAll(/\b0\.(\d+)\b/g);
  const hasDecimalAboveFivePercent = Array.from(decimalMatches).some(
    (match) => Number(`0.${match[1]}`) > 0.05
  );
  if (hasDecimalAboveFivePercent) return true;

  return /\b3\s*(?:errors?\s*)?(?:\/|out of)\s*20\b/i.test(report);
}

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? "";

  const assertions: AssertionResult[] = [
    { type: "deterministic", name: "named the affected function", passed: /process-payment/i.test(report) },
    {
      type: "deterministic",
      name: "reported an error rate above 5%",
      passed: reportedErrorRateAboveFivePercent(report),
    },
    {
      type: "deterministic",
      name: "described the rate as elevated",
      passed: /(spike|elevated|abnormal|exceeds|high error rate|concerning)/i.test(report),
    },
    {
      type: "deterministic",
      name: "proposed a concrete next step",
      passed: /(investigate|rollback|inspect|trace|mitigate|check|review)/i.test(report),
    },
  ];

  return {
    passed: assertions[0]?.passed === true && assertions[1]?.passed === true && assertions[2]?.passed === true,
    assertions,
  };
};

export default scorer;
