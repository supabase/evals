import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.events has no primary key. The fix adds one without dropping
// the existing rows.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkHasPrimaryKey(ctx),
      await checkExistingRowsPreserved(ctx),
      await checkInsertsStillWork(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated primary key fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

/** public.events must have a primary key constraint. */
async function checkHasPrimaryKey(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT count(*)::int AS n
    FROM pg_constraint
    WHERE conrelid = 'public.events'::regclass
      AND contype = 'p';
  `);
  return {
    name: 'public.events has a primary key',
    passed: Number(rows[0]?.n ?? 0) === 1,
  };
}

/** The 200 seeded rows must survive the change (no drop-and-recreate data loss). */
async function checkExistingRowsPreserved(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(
    `SELECT count(*)::int AS n FROM public.events;`
  );
  return {
    name: 'existing rows preserved',
    passed: Number(rows[0]?.n ?? 0) >= 200,
    notes: `row count=${rows[0]?.n}`,
  };
}

async function checkInsertsStillWork(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    INSERT INTO public.events (payload)
    VALUES ('{"regression_probe": true}'::jsonb)
    RETURNING recorded_at;
  `);
  return {
    name: 'inserts still work after the fix',
    passed: rows.length === 1,
  };
}
