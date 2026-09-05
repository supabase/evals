import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: autovacuum_enabled=false on public.orders, causing unbounded dead-tuple
// accumulation. The fix re-enables autovacuum and runs VACUUM ANALYZE.

const scorer: ToolScorer = async (ctx) => {
  try {
    const autovacuumFixed = await checkAutovacuumReEnabled(ctx);
    const checks: CheckResult[] = [autovacuumFixed];

    const verdict = await judge({
      input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
      rubric: stripIndent`
        Pass if the agent identified that autovacuum is disabled at the table level
        on public.orders (via pg_class reloptions or pg_stat_user_tables), and
        proposed re-enabling it with ALTER TABLE public.orders RESET (autovacuum_enabled)
        followed by VACUUM ANALYZE to reclaim existing dead tuples.

        Fail if the agent only reported the issue without proposing a specific fix.
      `,
    });
    checks.push({
      name: 'correctly diagnosed autovacuum disabled and proposed fix',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    });

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated autovacuum fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkAutovacuumReEnabled(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(`
    SELECT reloptions FROM pg_class WHERE relname = 'orders'
      AND relnamespace = 'public'::regnamespace;
  `);
  const opts = rows[0]?.reloptions;
  const optsArr = Array.isArray(opts) ? opts : (opts ? [opts] : []);
  const disabled = optsArr.some((o: string) =>
    /autovacuum_enabled\s*=\s*(false|off|0)/i.test(o)
  );
  return {
    name: 'autovacuum re-enabled on public.orders',
    passed: !disabled,
    notes: `reloptions: ${JSON.stringify(optsArr)}`,
  };
}
