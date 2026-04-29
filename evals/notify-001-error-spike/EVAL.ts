import type { Scorer } from "../../harness/types.js";

const scorer: Scorer = async (ctx) => {
  const calls = ctx.mgmt.backends.notifications.calls();

  if (calls.length === 0) {
    return { passed: false, score: 0, notes: "no notification dispatched" };
  }
  if (calls.length > 1) {
    return {
      passed: false,
      score: 0.3,
      notes: `expected 1 notification, got ${calls.length} (penalize spam)`,
    };
  }

  const c = calls[0];
  const payload = c.payload ?? {};

  const checks = [
    { name: "function_id is process-payment", ok: payload.function_id === "process-payment" },
    {
      name: "error_rate is a number > 0.05",
      ok: typeof payload.error_rate === "number" && (payload.error_rate as number) > 0.05,
    },
    {
      name: "severity is high or critical",
      ok: ["high", "critical"].includes(c.severity.toLowerCase()),
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
