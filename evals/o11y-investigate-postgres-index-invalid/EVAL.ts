import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: orders_customer_id_created_at_idx has indisvalid=false, left behind by a
// failed CREATE INDEX CONCURRENTLY. It wastes space and may cause query errors.
// Fix: DROP INDEX CONCURRENTLY orders_customer_id_created_at_idx; then recreate.
// BLOCKED: pg_index system catalog in PGlite cannot have indisvalid set to false —
// eval uses public.pg_index_snapshot to represent the invalid index state.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedInvalid =
    /invalid.{0,30}index|indisvalid|index.{0,30}invalid/i.test(report);
  const identifiedIndex =
    /orders_customer_id_created_at_idx/i.test(report);
  const proposedFix =
    /drop\s+index|reindex/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified invalid index condition', passed: identifiedInvalid },
    { name: 'named the specific invalid index', passed: identifiedIndex },
    { name: 'proposed DROP INDEX or REINDEX', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified orders_customer_id_created_at_idx as an invalid index
         (indisvalid = false) on the orders table, explaining that it was likely
         left behind by a failed CREATE INDEX CONCURRENTLY.
      2. Proposed dropping it with DROP INDEX CONCURRENTLY and recreating it, or
         using REINDEX INDEX CONCURRENTLY to rebuild it in place.

      Fail if the agent did not name the specific index, confused it with a valid
      index, or gave no actionable remediation.
    `,
  });
  checks.push({
    name: 'correctly diagnosed invalid index and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
