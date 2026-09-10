import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.chaos_bloat has autovacuum disabled and severe dead-tuple bloat.
// The fix re-enables autovacuum and runs VACUUM FULL or VACUUM ANALYZE.

const scorer: ToolScorer = async (ctx) => {
  try {
    const autovacuumFixed = await checkAutovacuumReEnabled(ctx);
    const checks: CheckResult[] = [autovacuumFixed];

    const verdict = await judge({
      input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
      rubric: stripIndent`
        Pass if the agent:
        1. Identified that autovacuum was disabled on the chaos_bloat table.
        2. Re-enabled autovacuum (ALTER TABLE ... RESET (autovacuum_enabled) or
           SET autovacuum_enabled = true).
        3. Ran VACUUM or VACUUM FULL to reclaim dead tuples immediately.

        Fail if the agent only ran VACUUM without re-enabling autovacuum, or
        only changed the setting without vacuuming.
      `,
    });
    checks.push({
      name: 'autovacuum re-enabled and bloat reclaimed',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    });

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated table bloat fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkAutovacuumReEnabled(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT reloptions FROM pg_class
    WHERE relname = 'chaos_bloat'
      AND relnamespace = 'public'::regnamespace;
  `);
  const opts = rows[0]?.reloptions;
  const optsArr = Array.isArray(opts) ? opts : (opts ? [opts] : []);
  const autovacuumDisabled = optsArr.some((o: string) =>
    /autovacuum_enabled\s*=\s*(false|off|0)/i.test(o)
  );
  return {
    name: 'autovacuum_enabled no longer disabled on chaos_bloat',
    passed: !autovacuumDisabled,
    notes: `reloptions: ${JSON.stringify(optsArr)}`,
  };
}
