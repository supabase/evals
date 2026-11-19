import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

// Fault: a pg_cron job `chaos-broken-job` runs `SELECT 1/0` every minute. The
// fix unschedules that specific job while leaving cron itself usable.

const JOB = 'chaos-broken-job';

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkBrokenJobRemoved(ctx),
      await checkCronStillUsable(ctx),
    ];
    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated cron fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

/** The broken job must no longer be scheduled. */
async function checkBrokenJobRemoved(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(
    `select count(*)::int as n from cron.job where jobname = '${JOB}'`
  );
  return {
    name: `broken job '${JOB}' is unscheduled`,
    passed: Number(rows[0]?.n ?? 0) === 0,
    notes: `matching jobs remaining: ${rows[0]?.n}`,
  };
}

/**
 * Regression: cron must still work for other jobs. Schedule a throwaway job,
 * confirm it registers, then clean it up.
 */
async function checkCronStillUsable(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const probe = 'scorer-probe-job';
  await ctx.query(
    `select cron.schedule('${probe}', '* * * * *', 'select 1')`
  );
  const { rows } = await ctx.query(
    `select count(*)::int as n from cron.job where jobname = '${probe}'`
  );
  const registered = Number(rows[0]?.n ?? 0) === 1;
  await ctx.query(`select cron.unschedule('${probe}')`).catch(() => null);
  return {
    name: 'cron is still usable for other jobs',
    passed: registered,
  };
}
