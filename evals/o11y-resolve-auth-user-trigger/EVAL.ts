import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: AFTER INSERT trigger on auth.users writes to public.signup_log inside
// the GoTrue signup transaction. The fix drops the trigger.

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkTriggerDropped(ctx),
    ];
    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated auth user trigger fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkTriggerDropped(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT trigger_name FROM information_schema.triggers
    WHERE event_object_schema = 'auth'
      AND event_object_table = 'users'
      AND trigger_name = 'chaos_signup_log';
  `);
  return {
    name: 'chaos_signup_log trigger removed from auth.users',
    passed: rows.length === 0,
    notes: rows.length > 0 ? 'trigger still exists' : 'trigger dropped',
  };
}
