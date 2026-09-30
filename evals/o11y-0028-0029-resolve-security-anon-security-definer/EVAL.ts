import {
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: public.admin_stats() is SECURITY DEFINER and GRANTed to anon.
// The fix revokes EXECUTE on the function from anon.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkAnonCannotExecute(ctx),
      await checkFunctionStillExists(ctx),
    ];

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated anon security-definer fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkAnonCannotExecute(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT has_function_privilege('anon', 'public.admin_stats()', 'EXECUTE') AS can_execute;
  `);
  const canExecute = rows[0]?.can_execute;
  return {
    name: 'anon cannot EXECUTE public.admin_stats()',
    passed: canExecute === false,
    notes: `has_function_privilege(anon, admin_stats, EXECUTE)=${canExecute}`,
  };
}

async function checkFunctionStillExists(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT proname FROM pg_proc
    WHERE proname = 'admin_stats'
      AND pronamespace = 'public'::regnamespace;
  `);
  return {
    name: 'function still exists after the fix',
    passed: rows.length === 1,
  };
}
