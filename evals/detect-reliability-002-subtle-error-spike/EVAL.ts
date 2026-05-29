import {
  assertion,
  type ToolScorer,
} from "@supabase-evals/core";

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? "";
  const checks = [
    { name: "named stripe-webhook", ok: /stripe-webhook/i.test(report) },
    {
      name: "used recent or per-function framing",
      ok: /(last\s+15|recent|window|per[- ]function|by\s+function|group(ed)?\s+by\s+function)/i.test(report),
    },
    {
      name: "described elevated error rate",
      ok: /(spike|elevated|abnormal|high error rate|concerning|18%|0\.18|9\s*\/\s*50)/i.test(report),
    },
  ];
  const flagsWrongFunction = /(auth-callback|image-resize|daily-digest)/i.test(report) && !checks[0].ok;
  const assertions = checks.map((c) => assertion(c.name, c.ok));
  if (flagsWrongFunction) {
    assertions.push({
      type: "deterministic",
      name: "did not flag a non-planted function",
      passed: false,
    });
  }

  return {
    passed: !flagsWrongFunction && checks.every((c) => c.ok),
    assertions,
  };
};

export default scorer;
