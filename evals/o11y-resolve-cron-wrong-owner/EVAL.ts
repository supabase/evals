import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: cron job 'chaos-wrong-owner' is owned by supabase_read_only_user.
// Fix: UPDATE cron.job SET username = 'postgres' WHERE jobname = 'chaos-wrong-owner'
// or unschedule the job.

const JOB = 'chaos-wrong-owner';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkJobFixedOrRemoved(ctx),
    ];
    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated cron wrong-owner fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkJobFixedOrRemoved(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT jobname, username FROM cron.job WHERE jobname = '${JOB}';
  `);

  if (rows.length === 0) {
    return {
      name: `job '${JOB}' removed or owner fixed`,
      passed: true,
      notes: 'job unscheduled',
    };
  }

  const username = rows[0]?.username;
  return {
    name: `job '${JOB}' owner changed from supabase_read_only_user`,
    passed: username !== 'supabase_read_only_user',
    notes: `current username=${username}`,
  };
}
