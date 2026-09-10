import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: standby-1 has replay_lag = 00:04:32 (4 minutes 32 seconds).
// The replica is falling behind and returning stale data to analytics queries.
// Fix: investigate I/O capacity on replica, check for long-running queries on
// standby blocking replay, or route time-sensitive reads to primary.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedLag =
    /replay.{0,20}lag|replication.{0,20}lag|standby.{0,20}(behind|lag)/i.test(report);
  const citedDuration =
    /4.{0,5}(minute|min)|00:04|272\s*(second|sec)/i.test(report);
  const proposedFix =
    /primary|route.{0,20}(read|query)|io.{0,20}(capacity|throughput)|conflict|hot.{0,10}standby|max_standby/i.test(
      report
    );

  const checks: CheckResult[] = [
    { name: 'identified replica replication lag', passed: identifiedLag },
    { name: 'cited the approximate lag duration (~4 min 32s)', passed: citedDuration },
    { name: 'proposed investigation or mitigation', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified that standby-1 has a replay_lag of approximately 4 minutes 32
         seconds, meaning the replica is significantly behind the primary and
         returning stale data.
      2. Proposed at least one mitigation: routing time-sensitive reads to the
         primary, investigating I/O capacity or query conflicts on the replica,
         or checking for hot standby conflict settings (max_standby_streaming_delay).

      Fail if the agent did not cite the specific lag duration, confused write_lag
      with replay_lag, or gave no actionable direction.
    `,
  });
  checks.push({
    name: 'correctly diagnosed replica lag and proposed mitigation',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
