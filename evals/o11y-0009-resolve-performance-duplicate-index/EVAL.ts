import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: idx_orders_customer_dup duplicates idx_orders_customer_id — both
// index orders(customer_id). The fix drops the duplicate, leaving the original.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkDuplicateDropped(ctx),
      await checkOriginalIndexRetained(ctx),
      await checkInsertsStillWork(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated duplicate index fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function customerIdIndexes(ctx: ToolEvalContext) {
  const { rows } = await ctx.query(stripIndent`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'orders'
      AND indexdef ~* 'ON.*orders.*\(customer_id\)';
  `);
  return rows;
}

async function checkDuplicateDropped(ctx: ToolEvalContext): Promise<CheckResult> {
  const indexes = await customerIdIndexes(ctx);
  return {
    name: 'duplicate customer_id index dropped (only one remains)',
    passed: indexes.length <= 1,
    notes: `${indexes.length} index(es) on orders(customer_id): ${indexes.map(r => r.indexname).join(', ')}`,
  };
}

async function checkOriginalIndexRetained(ctx: ToolEvalContext): Promise<CheckResult> {
  const indexes = await customerIdIndexes(ctx);
  return {
    name: 'at least one index on orders(customer_id) retained',
    passed: indexes.length >= 1,
    notes: indexes.map(r => r.indexname).join(', '),
  };
}

async function checkInsertsStillWork(ctx: ToolEvalContext): Promise<CheckResult> {
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
