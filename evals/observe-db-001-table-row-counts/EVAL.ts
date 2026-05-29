import {
  assertion,
  type AssertionResult,
  type ToolScorer,
} from "@supabase-evals/core";

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? "";
  const assertions: AssertionResult[] = [
    { type: "deterministic", name: "reported users count", passed: /users[\s\S]{0,80}\b12\b/i.test(report) },
    { type: "deterministic", name: "reported orders count", passed: /orders[\s\S]{0,80}\b87\b/i.test(report) },
    { type: "deterministic", name: "reported events count", passed: /events[\s\S]{0,80}\b453\b/i.test(report) },
  ];

    return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
  };
};

export default scorer;
