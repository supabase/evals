import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// This fault has no schema-level fix — it's an application query pattern (N+1).
// So scoring is report-based: the agent must identify the repeated single-row
// query against orders as the driver and propose a set-based replacement.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';

  const namedOrders = /\borders\b/i.test(report);
  const identifiedPattern =
    /n\s*\+\s*1/i.test(report) ||
    /(repeated|per[- ]?customer|one (row|query) (at a time|per)|thousands of|millions of|high call count)/i.test(
      report
    );
  const proposedBatching =
    /\bjoin\b/i.test(report) ||
    /\bin\s*\(/i.test(report) ||
    /\bany\s*\(/i.test(report) ||
    /(batch|single query|set[- ]based|distinct on|group by|window)/i.test(
      report
    );

  const checks: CheckResult[] = [
    { name: 'named the orders table as the driver', passed: namedOrders },
    {
      name: 'identified the repeated single-row (N+1) pattern',
      passed: identifiedPattern,
    },
    {
      name: 'inspected query statistics',
      passed: /pg_stat_statements|query performance|query insights/i.test(
        serializeTranscript(ctx.transcript, { includeToolCallInputs: true })
      ),
    },
    { name: 'proposed a set-based / batched fix', passed: proposedBatching },
  ];

  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    rubric: stripIndent`
      Pass if the agent identifies that the database load is driven by a
      repeated single-row query against the orders table (an N+1 pattern —
      the same "WHERE customer_id = $1 ... LIMIT 1" query executed an enormous
      number of times) AND proposes a concrete set-based replacement, such as a
      single JOIN, a WHERE customer_id = ANY(...) / IN (...) batch, or a
      DISTINCT ON / window query that fetches all customers' latest orders in
      one round trip.

      Fail if it blames the wrong query, recommends only an index without
      addressing the per-row call pattern, or gives vague advice.
    `,
  });

  checks.push({
    name: 'verified N+1 diagnosis and batched fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return {
    passed: namedOrders && identifiedPattern && proposedBatching && verdict.passed,
    checks,
  };
};

export default scorer;
