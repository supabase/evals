import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.order_summary is a SECURITY DEFINER view (Postgres default),
// bypassing RLS on orders. The fix sets security_invoker=on or drops the view.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkViewSafeOrDropped(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated security_definer view fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkViewSafeOrDropped(ctx: ToolEvalContext): Promise<CheckResult> {
  // Check if view was dropped.
  const { rows: viewRows } = await ctx.query(stripIndent`
    SELECT table_name
    FROM information_schema.views
    WHERE table_schema = 'public' AND table_name = 'order_summary';
  `);

  if (viewRows.length === 0) {
    return {
      name: 'order_summary view dropped or has security_invoker',
      passed: true,
      notes: 'view dropped',
    };
  }

  // If it still exists, check for security_invoker option.
  const { rows: optRows } = await ctx.query(stripIndent`
    SELECT reloptions
    FROM pg_class
    WHERE relname = 'order_summary'
      AND relnamespace = 'public'::regnamespace
      AND relkind = 'v';
  `);

  const opts = optRows[0]?.reloptions;
  const optsArr = Array.isArray(opts) ? opts : (opts ? [opts] : []);
  const hasSecurityInvoker = optsArr.some((o: string) =>
    /security_invoker\s*=\s*(on|true|1)/i.test(o)
  );

  return {
    name: 'order_summary view dropped or has security_invoker',
    passed: hasSecurityInvoker,
    notes: `view exists; security_invoker=${hasSecurityInvoker}; reloptions=${JSON.stringify(optsArr)}`,
  };
}
