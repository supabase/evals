import {
  assertion,
  type ToolScorer,
} from "@supabase-evals/core";

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

  const assertions = checks.map((c) => assertion(c.name, c.ok));
  return {
    passed: checks.every((c) => c.ok),
    assertions,
  };
};

export default scorer;
