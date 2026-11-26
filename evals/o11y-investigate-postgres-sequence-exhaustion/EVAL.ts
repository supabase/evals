import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: events_id_seq is an int4 identity sequence advanced to ~2147483640,
// leaving fewer than 10 values before insert failures begin.
// Fix: ALTER TABLE public.events ALTER COLUMN id TYPE bigint, or cycle the
// sequence if temporary relief is acceptable.

const scorer: ToolScorer = async (ctx) => {
  try {
    const seqCheck = await checkSequenceNearExhaustion(ctx);
    const checks: CheckResult[] = [seqCheck];

    const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });
    const verdict = await judge({
      input: transcript,
      rubric: stripIndent`
        Pass if the agent:
        1. Identified that the events_id_seq sequence (backing the int4 identity column
           on public.events) is near its maximum value of 2,147,483,647 and will cause
           insert failures imminently.
        2. Proposed changing the column type to bigint (ALTER TABLE public.events ALTER
           COLUMN id TYPE bigint) or another concrete fix such as creating a new bigint
           sequence and migrating the column.

        Fail if the agent only described the general concept of sequence exhaustion
        without identifying events_id_seq specifically, or proposed no actionable fix.
      `,
    });
    checks.push({
      name: 'correctly diagnosed sequence exhaustion and proposed fix',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    });

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: 'scorer evaluated sequence exhaustion', passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkSequenceNearExhaustion(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(`
    SELECT last_value, max_value
    FROM pg_sequences
    WHERE sequencename = 'events_id_seq'
      AND schemaname = 'public';
  `);
  const row = rows[0];
  if (!row) {
    return {
      name: 'events_id_seq exists and is near exhaustion',
      passed: false,
      notes: 'sequence not found',
    };
  }
  const remaining = Number(row.max_value) - Number(row.last_value);
  return {
    name: 'events_id_seq exists and is near exhaustion',
    passed: remaining < 1000,
    notes: `last_value=${row.last_value}, max_value=${row.max_value}, remaining=${remaining}`,
  };
}
