import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: checkpoints_req=350, checkpoints_timed=100 → ~78% of checkpoints are forced.
// WAL is filling max_wal_size before scheduled checkpoints can run.
// Fix: increase max_wal_size, increase checkpoint_completion_target, or reduce
// write throughput via application-level batching.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedForced =
    /forced.{0,20}checkpoint|checkpoints_req|checkpoint.{0,20}required/i.test(report);
  const identifiedRatio =
    /7[5-9]%|8[0-9]%|checkpoints_req.{0,20}(350|checkpoints_timed.{0,20}100)/i.test(report);
  const proposedFix =
    /max_wal_size|checkpoint_completion_target|checkpoint_timeout|wal/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified excessive forced checkpoints', passed: identifiedForced },
    { name: 'cited the checkpoints_req/timed ratio', passed: identifiedRatio },
    { name: 'proposed WAL or checkpoint tuning', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified that checkpoints_req (350) far exceeds checkpoints_timed (100),
         meaning ~78% of checkpoints are forced by WAL overflow rather than
         scheduled by checkpoint_timeout.
      2. Proposed increasing max_wal_size or checkpoint_timeout, or adjusting
         checkpoint_completion_target to spread I/O more evenly.

      Fail if the agent did not distinguish forced from scheduled checkpoints,
      misread the direction of the ratio, or gave no WAL/checkpoint tuning advice.
    `,
  });
  checks.push({
    name: 'correctly diagnosed forced checkpoints and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
