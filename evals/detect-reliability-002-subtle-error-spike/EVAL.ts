import type { Scorer } from "../../apps/framework/harness/types.js";

const scorer: Scorer = async (ctx) => {
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
  const score = flagsWrongFunction ? 0 : checks.filter((c) => c.ok).length / checks.length;

  return {
    passed: !flagsWrongFunction && checks.every((c) => c.ok),
    score,
    notes: [
      ...checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`),
      flagsWrongFunction ? "FAIL flagged a non-planted function" : undefined,
    ].filter(Boolean).join("\n"),
  };
};

export default scorer;
