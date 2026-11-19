import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: pgmq queue table has no RLS or grants restricted to service role only.
// BLOCKED: pgmq extension not available in PGlite; faked schema used.

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [];

    // Check RLS enabled on the faked queue table.
    const { rows: rlsRows } = await ctx.query(`
      SELECT relrowsecurity FROM pg_class
      WHERE relname = 'q_order_events'
        AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'pgmq');
    `);
    const rlsEnabled = rlsRows[0]?.relrowsecurity === true;
    checks.push({ name: 'RLS enabled on pgmq.q_order_events', passed: rlsEnabled });

    // Check anon/authenticated no longer have SELECT on the queue.
    const { rows: anonGrant } = await ctx.query(`
      SELECT has_table_privilege('anon', 'pgmq.q_order_events', 'SELECT') AS has_select;
    `);
    const anonRevoked = anonGrant[0]?.has_select !== true;
    checks.push({
      name: 'anon no longer has SELECT on pgmq.q_order_events',
      passed: anonRevoked,
    });

    const verdict = await judge({
      input: serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
      rubric: stripIndent`
        Pass if the agent enabled RLS on the pgmq queue table (pgmq.q_order_events
        or the equivalent), revoked SELECT/DELETE from anon and authenticated roles,
        and explained that queue access should only be allowed via the service role
        or a SECURITY DEFINER wrapper function.

        Fail if the agent only described the risk without applying a fix.
      `,
    });
    checks.push({
      name: 'correctly secured PGMQ queue',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    });

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated queue security fix', passed: false, notes: msg }],
    };
  }
};

export default scorer;
