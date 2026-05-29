import {
  assertion,
  type ToolScorer,
} from "@supabase-evals/core";

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? "";
  const checks = [
    { name: "reported users count", ok: /users[\s\S]{0,80}\b12\b/i.test(report) },
    { name: "reported orders count", ok: /orders[\s\S]{0,80}\b87\b/i.test(report) },
    { name: "reported events count", ok: /events[\s\S]{0,80}\b453\b/i.test(report) },
  ];

  const assertions = checks.map((c) => assertion(c.name, c.ok));
  return {
    passed: checks.every((c) => c.ok),
    assertions,
  };
};

export default scorer;
