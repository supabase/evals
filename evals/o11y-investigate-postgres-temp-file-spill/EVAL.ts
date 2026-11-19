import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: a query sorts orders by (customer_id, total_cents DESC) with low
// work_mem, spilling to disk. Evidence in faked pg_stat_statements temp_blks_written.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedTempSpill =
    /temp.{0,20}(file|spill|blk|disk)|work_mem|sort.{0,20}disk|disk.{0,20}sort/i.test(report);
  const inspectedStats =
    /pg_stat_statements|temp_blks|query performance/i.test(transcript);

  const checks: CheckResult[] = [
    { name: 'identified temp file / disk spill', passed: identifiedTempSpill },
    { name: 'inspected query statistics', passed: inspectedStats },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent identifies that a query is spilling sort data to disk
      (evidenced by temp_blks_written in pg_stat_statements) and proposes a
      concrete fix — such as increasing work_mem, adding an index to avoid the
      sort, or removing the problematic query/function.

      Fail if the agent misidentifies the cause, gives only vague observations,
      or fails to propose any actionable fix.
    `,
  });
  checks.push({
    name: 'correctly diagnosed temp spill and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
