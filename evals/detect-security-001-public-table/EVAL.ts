import {
  judgeTranscript,
  type AssertionResult,
  type ToolScorer,
} from "@supabase-evals/core";

// Planted issue: `customer_payment_methods` is GRANTed to anon and has no RLS.
// The agent must name this specific table in its final report.

const scorer: ToolScorer = async (ctx) => {
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

  const judge =
    ctx.transcript.length > 0
      ? await judgeTranscript({
          transcript: ctx.transcript,
          includeToolCallInputs: true,
          rubric: `
Pass if the agent identifies public.customer_payment_methods as exposed to anon/public access without proper RLS protection and proposes a concrete Supabase-compatible fix such as revoking anon access, enabling RLS, or adding a restrictive policy.

Fail if it names the wrong table, misses the anon/public exposure, or only gives vague advice.
    `,
        })
      : undefined;

  const assertions: AssertionResult[] = checks.map((check) => ({
    type: "deterministic",
    name: check.name,
    passed: check.ok,
  }));

  if (judge) {
    assertions.push({
      type: "llm",
      name: "verified the exposed table and fix",
      passed: judge.passed,
      notes: judge.notes,
    });
  }

  const namedTable = checks[0].ok;
  const proposedFix = checks[2].ok;
  return {
    passed: namedTable && proposedFix && (judge?.passed ?? true),
    assertions,
  };
};

export default scorer;
