import {
  assertion,
  type AssertionResult,
  type ToolScorer,
} from "@supabase-evals/core";

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? "";
  const assertions: AssertionResult[] = [
    { type: "deterministic", name: "named stripe-webhook", passed: /stripe-webhook/i.test(report) },
    {
      type: "deterministic",
      name: "reported 9 errors",
      passed: /\b9\b/.test(report),
    },
    {
      type: "deterministic",
      name: "reported 50 total events",
      passed: /\b50\b/.test(report) || /\b9\s*\/\s*50\b/.test(report),
    },
  ];

  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
  };
};

export default scorer;
