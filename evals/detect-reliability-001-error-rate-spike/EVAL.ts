import type { ToolScorer } from "../../apps/framework/harness/types.js";

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? "";

  const checks = [
    { name: "named the affected function", ok: /process-payment/i.test(report) },
    {
      name: "reported an error rate above 5%",
      ok:
        /\b(1[5-9]|[2-9]\d)%\b/.test(report) ||
        /\b0\.(1[5-9]|[2-9]\d)\b/.test(report) ||
        /\b3\s*(?:\/|out of)\s*20\b/i.test(report),
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
