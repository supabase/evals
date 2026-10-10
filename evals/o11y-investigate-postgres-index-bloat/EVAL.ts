import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: repeated UPDATE operations on orders caused btree index dead pages.
// This is an investigate eval — agent diagnoses the bloat and proposes REINDEX.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedIndexBloat =
    /index.{0,30}(bloat|dead|page|bloated)|reindex|btree.{0,20}(dead|bloat)/i.test(report);
  const proposedReindex =
    /reindex|rebuild.{0,20}index|vacuum.{0,20}analyze/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified index bloat', passed: identifiedIndexBloat },
    { name: 'proposed REINDEX or equivalent', passed: proposedReindex },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent identifies index bloat on the orders table
      (specifically the customer_id index accumulating dead pages from repeated
      UPDATE churn) and proposes REINDEX INDEX CONCURRENTLY or equivalent to
      compact it, along with VACUUM ANALYZE to prevent recurrence.

      Fail if the agent misidentifies the cause, proposes only a new index
      without addressing bloat, or gives vague observations without a fix.
    `,
  });
  checks.push({
    name: 'correctly diagnosed index bloat and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
