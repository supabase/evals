import {
  judge,
  serializeTranscript,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: a row in auth.users has aud='' and role='' (GoTrue integrity violation).
// The fix updates those fields to 'authenticated' or deletes the broken row.

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const noCorruptRows = await checkNoCorruptRows(ctx);
    const checks: CheckResult[] = [noCorruptRows];

    const verdict = await judge({
      input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
      rubric: stripIndent`
        Pass if the agent identified rows in auth.users with empty aud or role
        fields (GoTrue integrity violation) and either:
        - Updated those rows to set aud='authenticated' and role='authenticated', OR
        - Deleted the corrupted rows.

        Fail if the agent only reported the issue without fixing it, or fixed the
        wrong thing.
      `,
    });
    checks.push({
      name: 'correctly identified and fixed corrupt auth.users rows',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    });

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated auth data integrity fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkNoCorruptRows(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT count(*)::int AS n FROM auth.users
    WHERE aud = '' OR role = '';
  `);
  return {
    name: 'no auth.users rows with empty aud or role',
    passed: Number(rows[0]?.n ?? 0) === 0,
    notes: `corrupt rows remaining: ${rows[0]?.n}`,
  };
}
