import type { Scorer } from "../../harness/types.js";

// Planted issue: `customer_payment_methods` is GRANTed to anon and has no RLS.
// The agent must name this specific table in its final report.

const scorer: Scorer = async (ctx) => {
  const report = ctx.agentReport ?? "";

  const checks = [
    { name: "named the vulnerable table", ok: /customer_payment_methods/i.test(report) },
    { name: "mentioned the anon role",    ok: /\banon\b/i.test(report) },
    {
      name: "proposed a concrete fix",
      ok:
        /enable\s+row\s+level\s+security/i.test(report) ||
        /CREATE\s+POLICY/i.test(report) ||
        /REVOKE\s+.*\s+FROM\s+anon/i.test(report),
    },
  ];

  const namedTable = checks[0].ok;
  const proposedFix = checks[2].ok;
  const score = checks.filter((c) => c.ok).length / checks.length;
  return {
    passed: namedTable && proposedFix,
    score,
    notes: checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`).join("\n"),
  };
};

export default scorer;
