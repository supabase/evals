import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: chaos_slow_scan() runs a full seq scan + random sort on public.orders
// periodically, appearing in pg_stat_statements as a consistently slow query.
// This is an investigate eval — the agent diagnoses from faked stats and proposes a fix.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const namedSlowQuery =
    /chaos_slow_scan|slow.?scan|sequential scan|seq.?scan/i.test(report);
  const identifiedOrders = /\borders\b/i.test(report);
  const inspectedStats =
    /pg_stat_statements|query performance|query insights/i.test(transcript);

  const checks: CheckResult[] = [
    { name: 'identified the slow-scanning query', passed: namedSlowQuery },
    { name: 'identified orders as the affected table', passed: identifiedOrders },
    { name: 'inspected query statistics', passed: inspectedStats },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent identifies that there is a slow query doing a full
      sequential scan on the orders table (chaos_slow_scan or similar pattern
      with high total execution time and random sort), and proposes a concrete
      remediation — such as removing the function/cron job, adding an index,
      or rewriting the query.

      Fail if the agent misidentifies the cause, gives only vague observations,
      or does not propose any actionable fix.
    `,
  });
  checks.push({
    name: 'correctly diagnosed slow query and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
