import type { ToolScorer } from "@supabase-evals/core";

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

  const checks = [
    { name: "named the affected function", ok: /process-payment/i.test(report) },
    {
      name: "reported an error rate above 5%",
      ok: reportedErrorRateAboveFivePercent(report),
    },
    {
      name: "described the rate as elevated",
      ok: /(spike|elevated|abnormal|exceeds|high error rate|concerning)/i.test(report),
    },
    {
      name: "proposed a concrete next step",
      ok: /(investigate|rollback|inspect|trace|mitigate|check|review)/i.test(report),
    },
  ];

  const score = checks.filter((c) => c.ok).length / checks.length;
  return {
    passed: checks[0].ok && checks[1].ok && checks[2].ok,
    score,
    notes: checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`).join("\n"),
  };
};

export default scorer;
