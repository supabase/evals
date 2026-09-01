import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: an inactive logical replication slot (chaos_slot) holds WAL,
// preventing VACUUM from reclaiming dead tuples.
// BLOCKED: pg_replication_slots not available in PGlite — eval uses faked table.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedSlot =
    /replication.{0,20}slot|chaos_slot|wal.{0,20}(hold|accum|grow)/i.test(report);
  const proposedFix =
    /drop.{0,20}slot|pg_drop_replication_slot|reconnect.{0,20}consumer/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified inactive replication slot', passed: identifiedSlot },
    { name: 'proposed dropping or reconnecting the slot', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent identified an inactive logical replication slot (chaos_slot)
      that is holding WAL and preventing VACUUM from reclaiming space, and proposed
      either dropping the slot with pg_drop_replication_slot or reconnecting the
      consumer that owns it.

      Fail if the agent misidentified the cause or gave only generic disk-space advice.
    `,
  });
  checks.push({
    name: 'correctly diagnosed inactive WAL slot',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
