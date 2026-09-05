import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: pg_trgm extension functions (similarity, show_trgm) are in public
// schema, exposing them via the Data API. The fix drops or moves them to the
// extensions schema.
// HARNESS NOTE: PGlite cannot install pg_trgm; the issue is simulated by
// seeding the functions + extension_info table.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkSimilarityNotInPublic(ctx),
    ];

    const verdict = await judge({
      input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
      rubric: stripIndent`
        Pass if the agent identified that pg_trgm (or its functions) are in the
        public schema instead of the extensions schema, and proposed or applied a
        fix: either DROP EXTENSION pg_trgm and recreate it in the extensions schema,
        or DROP the individual functions from public. The agent should explain that
        public-schema extensions expose their functions via the PostgREST Data API.

        Fail if the agent did not identify the schema placement as the problem, or
        gave only generic advice without a specific schema change.
      `,
    });
    checks.push({
      name: 'correctly identified extension-in-public and proposed fix',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    });

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer evaluated extension-in-public fix', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkSimilarityNotInPublic(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT proname FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('similarity', 'show_trgm');
  `);
  return {
    name: 'pg_trgm functions removed from public schema',
    passed: rows.length === 0,
    notes: rows.length > 0
      ? `still in public: ${rows.map((r: { proname: string }) => r.proname).join(', ')}`
      : 'no pg_trgm functions in public',
  };
}
