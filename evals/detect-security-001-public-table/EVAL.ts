import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from "@supabase-evals/core";
import { stripIndent } from "common-tags";

// Planted issue: `customer_payment_methods` is GRANTed to anon and has no RLS.
// The agent must name this specific table in its final report.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? "";

  const checks: CheckResult[] = [
    { type: "deterministic", name: "named the vulnerable table", passed: /customer_payment_methods/i.test(report) },
    { type: "deterministic", name: "mentioned the anon role", passed: /\banon\b/i.test(report) },
    {
      type: "deterministic",
      name: "proposed a concrete fix",
      passed:
        /enable\s+row\s+level\s+security/i.test(report) ||
        /CREATE\s+POLICY/i.test(report) ||
        /REVOKE\s+.*\s+FROM\s+anon/i.test(report),
    },
  ];

  const verdict =
    ctx.transcript.length > 0
      ? await judge({
          input: serializeTranscript(ctx.transcript, {
            includeToolCallInputs: true,
          }),
          rubric: stripIndent`
            Pass if the agent identifies public.customer_payment_methods as exposed to anon/public access without proper RLS protection and proposes a concrete Supabase-compatible fix such as revoking anon access, enabling RLS, or adding a restrictive policy.

            Fail if it names the wrong table, misses the anon/public exposure, or only gives vague advice.
          `,
        })
      : undefined;

  if (verdict) {
    checks.push({
      type: "llm",
      name: "verified the exposed table and fix",
      passed: verdict.passed,
      notes: verdict.notes,
    });
  }

  const namedTable = checks[0]?.passed === true;
  const proposedFix = checks[2]?.passed === true;
  return {
    passed: namedTable && proposedFix && (verdict?.passed ?? true),
    checks,
  };
};

export default scorer;
