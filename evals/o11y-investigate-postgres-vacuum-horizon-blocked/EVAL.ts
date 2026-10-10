import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: (1) pid 77001 has been running a read query for 2h15m, holding an old
// xmin snapshot; (2) stale_slot is an inactive logical replication slot also
// holding the vacuum horizon. Either blocker prevents VACUUM from removing dead
// tuples across the cluster.
// Fix: terminate pid 77001; drop stale_slot.
// BLOCKED: system views cannot be seeded in PGlite — eval uses snapshot tables.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedHorizonBlock =
    /vacuum.{0,40}(horizon|block|hold|prevent)|old.{0,20}(transaction|xmin|snapshot).{0,20}(block|hold|prevent)/i.test(
      report
    );
  const identifiedLongTxn =
    /\b77001\b|long.{0,20}(running|transaction|query).{0,30}(block|hold|vacuum)/i.test(report);
  const identifiedStaleSlot =
    /stale_slot|inactive.{0,20}(slot|replication)|replication.{0,20}slot.{0,20}(hold|block|inactive)/i.test(
      report
    );
  const proposedFix =
    /pg_terminate_backend|pg_drop_replication_slot|drop.{0,20}slot/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified vacuum horizon is blocked', passed: identifiedHorizonBlock },
    { name: 'identified long-running transaction (pid 77001)', passed: identifiedLongTxn },
    { name: 'identified inactive replication slot (stale_slot)', passed: identifiedStaleSlot },
    { name: 'proposed terminating backend or dropping the slot', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent identified at least one of the two vacuum horizon blockers:
      (1) pid 77001 has been running a read transaction for over 2 hours, holding
          an old xmin and preventing VACUUM from removing dead tuples, OR
      (2) stale_slot is an inactive logical replication slot also holding the horizon.

      The agent should have proposed terminating pid 77001 (pg_terminate_backend)
      and/or dropping stale_slot (pg_drop_replication_slot) as the fix.

      Fail if the agent did not explain the vacuum horizon mechanism, gave only
      generic advice about running VACUUM manually, or identified neither specific blocker.
    `,
  });
  checks.push({
    name: 'correctly diagnosed vacuum horizon blocker and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
