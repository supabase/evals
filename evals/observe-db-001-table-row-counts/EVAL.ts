import type { ToolScorer } from "eval-types";

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? "";
  const checks = [
    { name: "reported users count", ok: /users[\s\S]{0,80}\b12\b/i.test(report) },
    { name: "reported orders count", ok: /orders[\s\S]{0,80}\b87\b/i.test(report) },
    { name: "reported events count", ok: /events[\s\S]{0,80}\b453\b/i.test(report) },
  ];

  const score = checks.filter((c) => c.ok).length / checks.length;
  return {
    passed: checks.every((c) => c.ok),
    score,
    notes: checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`).join("\n"),
  };
};

export default scorer;
