import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: chaos_long_sleep() calls pg_sleep(120) periodically via pg_cron.
// Evidence: seeded logs.jsonl with postgres log lines showing the long-running query.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedSleepQuery =
    /pg_sleep|chaos_long_sleep|long.{0,20}(running|query|transaction)|sleep.*120/i.test(report);
  const proposedFix =
    /unschedule|cron\.unschedule|drop.{0,20}function|pg_terminate_backend|terminate.*session/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified long-running sleep query', passed: identifiedSleepQuery },
    { name: 'proposed concrete fix', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent identifies a recurring long-running query (chaos_long_sleep
      or pg_sleep) appearing in the Postgres logs / pg_stat_activity and proposes:
      - Unscheduling the pg_cron job, AND/OR
      - Terminating active sessions running the query, AND/OR
      - Dropping the function causing the load.

      Fail if the agent misidentifies the root cause or gives only vague advice.
    `,
  });
  checks.push({
    name: 'correctly diagnosed long-running query and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
