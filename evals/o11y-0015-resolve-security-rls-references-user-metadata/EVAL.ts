import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: customers RLS policy uses auth.jwt() ->> 'user_metadata' (user-editable).
// The fix rewrites the policy to use app_metadata or a separate roles table.

const scorer: ToolScorer = async (ctx) => {
  try {
    const noUserMetadata = await checkNoUserMetadataPolicy(ctx);
    const checks: CheckResult[] = [noUserMetadata];

    const verdict = await judge({
      input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
      rubric: stripIndent`
        Pass if the agent:
        1. Explained that user_metadata is user-editable and therefore unsafe for
           access-control decisions.
        2. Replaced the policy with one that uses app_metadata (server-controlled),
           a separate roles table, or removed the policy entirely with a safe
           replacement.

        Fail if the agent kept a policy using user_metadata, or only added
        documentation without changing the policy.
      `,
    });
    checks.push({
      name: 'policy correctly rewritten away from user_metadata',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    });

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated user_metadata policy fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkNoUserMetadataPolicy(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT policyname, qual
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'customers'
      AND qual ILIKE '%user_metadata%';
  `);
  return {
    name: 'no policy references user_metadata on customers',
    passed: rows.length === 0,
    notes: rows.length > 0
      ? `still referencing user_metadata: ${rows.map(r => r.policyname).join(', ')}`
      : 'none found',
  };
}
