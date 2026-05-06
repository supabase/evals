import type { ToolScorer } from "../../apps/framework/harness/types.js";

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? "";
  const checks = [
    { name: "named stripe-webhook", ok: /stripe-webhook/i.test(report) },
    {
      name: "reported 9 errors",
      ok: /\b9\b/.test(report),
    },
    {
      name: "reported 50 total events",
      ok: /\b50\b/.test(report) || /\b9\s*\/\s*50\b/.test(report),
    },
  ];

  const score = checks.filter((c) => c.ok).length / checks.length;
  return {
    passed: checks.every((c) => c.ok),
    score,
    notes: checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`).join("\n"),
  };
};

export default scorer;
