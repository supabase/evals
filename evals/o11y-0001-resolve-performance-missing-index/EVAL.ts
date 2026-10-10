import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.orders.customer_id is unindexed. The fix creates an index on
// customer_id so the per-customer lookup uses it instead of a sequential scan.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkIndexExists(ctx),
      await checkQueryPlanUsesIndex(ctx),
      await checkInsertsStillWork(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated index fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

/** An index leading with customer_id must exist on public.orders. */
async function checkIndexExists(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'orders';
  `);
  const hasIndex = rows.some((r) =>
    /ON\s+(?:public\.)?orders\s+.*\(\s*customer_id/i.test(String(r.indexdef))
  );
  return {
    name: 'index on orders(customer_id) exists',
    passed: hasIndex,
    notes: rows.map((r) => r.indexname).join(', '),
  };
}

/** The per-customer lookup should plan with an index and no sequential scan. */
async function checkQueryPlanUsesIndex(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    EXPLAIN SELECT id, total_cents, created_at
    FROM public.orders
    WHERE customer_id = 42;
  `);
  const plan = rows.map((r) => Object.values(r).join(' ')).join('\n');
  return {
    name: 'query plan uses an index and avoids a sequential scan',
    passed:
      /(Index Scan|Index Only Scan|Bitmap Index Scan)/i.test(plan) &&
      !/Seq Scan on orders/i.test(plan),
    notes: plan,
  };
}

async function checkInsertsStillWork(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    INSERT INTO public.orders (customer_id, total_cents)
    VALUES (1, 999)
    RETURNING id;
  `);
  return {
    name: 'inserts still work after the fix',
    passed: rows.length === 1,
  };
}
