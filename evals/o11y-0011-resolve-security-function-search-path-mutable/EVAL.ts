import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.get_customer_balance() is SECURITY DEFINER with no SET
// search_path, allowing search_path injection. The fix pins search_path to ''.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkSearchPathPinned(ctx),
      await checkFunctionStillExists(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated search_path fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkSearchPathPinned(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT proname, proconfig
    FROM pg_proc
    WHERE proname = 'get_customer_balance'
      AND pronamespace = 'public'::regnamespace;
  `);

  if (rows.length === 0) {
    return {
      name: 'get_customer_balance has pinned search_path',
      passed: false,
      notes: 'function not found',
    };
  }

  const config = rows[0]?.proconfig;
  const configs = Array.isArray(config) ? config : (config ? [config] : []);
  // Postgres stores SET search_path='' as search_path="" in proconfig
  const hasPinnedSearchPath = configs.some((c: string) =>
    /search_path\s*=\s*('')/i.test(c) ||
    /search_path\s*=\s*("")/i.test(c) ||
    /search_path\s*=\s*$/i.test(c)
  );

  return {
    name: 'get_customer_balance has pinned search_path (SET search_path = \'\')',
    passed: hasPinnedSearchPath,
    notes: `proconfig: ${JSON.stringify(configs)}`,
  };
}

async function checkFunctionStillExists(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT proname FROM pg_proc
    WHERE proname = 'get_customer_balance'
      AND pronamespace = 'public'::regnamespace;
  `);
  return {
    name: 'function still exists after the fix',
    passed: rows.length === 1,
  };
}
