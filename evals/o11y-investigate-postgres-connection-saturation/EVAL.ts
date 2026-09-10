import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: 90 pg_cron jobs hold idle connections via pg_sleep(120), saturating
// the connection pool. This scenario cannot be faithfully reproduced in the
// harness (no concurrent sessions) — eval uses faked pg_stat_activity.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedSaturation =
    /connection.{0,20}(saturat|limit|pool|exhaust|too many)/i.test(report);
  const identifiedCause =
    /pg_sleep|saturation|idle.{0,20}connection|pg_cron|cron.{0,20}job/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified connection saturation', passed: identifiedSaturation },
    { name: 'identified idle connections / pg_cron as cause', passed: identifiedCause },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent identified that the connection pool is saturated by a
      large number of idle connections held by pg_cron jobs running pg_sleep,
      and proposed fixing this by: unscheduling the saturation cron jobs,
      terminating idle sessions, or enabling PgBouncer/Supavisor connection
      pooling.

      Fail if the agent misidentified the cause or gave only generic advice.

      Note: this scenario is seeded as a faked pg_stat_activity snapshot.
      The agent cannot fully remediate it in this harness environment.
    `,
  });
  checks.push({
    name: 'correctly diagnosed connection saturation',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
