import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.orders has REPLICA IDENTITY NOTHING. The fix restores it to
// DEFAULT (PK-based old_record delivery).

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkReplicaIdentity(ctx),
    ];
    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated replica identity fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkReplicaIdentity(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT relreplident FROM pg_class
    WHERE oid = 'public.orders'::regclass;
  `);
  // 'n' = NOTHING, 'd' = DEFAULT, 'f' = FULL, 'i' = INDEX
  const ident = rows[0]?.relreplident;
  return {
    name: 'orders REPLICA IDENTITY is not NOTHING (d=DEFAULT or f=FULL)',
    passed: ident === 'd' || ident === 'f',
    notes: `relreplident=${ident} (n=NOTHING, d=DEFAULT, f=FULL)`,
  };
}
