import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const scorer: ToolScorer = async (ctx) => {
  const checks: CheckResult[] = [
    await checkMessagesRealtimePublication(ctx),
    await checkNoReadReplicaGuidance(ctx),
  ];

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
};

export default scorer;

async function checkMessagesRealtimePublication(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  // Realtime Postgres Changes needs subscribed tables in this publication.
  const { rows } = await ctx.query(stripIndent`
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'messages';
  `);

  return {
    name: 'messages table added to supabase_realtime publication',
    passed: rows.length > 0,
  };
}

async function checkNoReadReplicaGuidance(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  // AI-795 regression guard: live updates should not require read replicas.
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, {
      includeToolCallInputs: true,
    }),
    rubric: stripIndent`
      Pass if the assistant handles the live chat update request using Supabase Realtime/Postgres Changes without recommending read replicas.

      A passing answer should:
      - Treat the task as Realtime/Postgres Changes setup.
      - Avoid saying or implying that read replicas are required or useful for Realtime live updates.
      - Avoid confusing Supabase read replicas with Postgres logical replication or the supabase_realtime publication.

      Fail if the assistant recommends provisioning a read replica, presents read replicas as the fix for live browser updates, or says Realtime requires read replicas.
    `,
  });

  return {
    name: 'did not recommend read replicas for Realtime',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
