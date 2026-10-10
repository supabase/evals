import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: prepared transaction 'txn_payment_abc123' (xid 8834721) has been sitting
// for 6+ hours. Abandoned prepared transactions hold their xmin, blocking VACUUM
// and wraparound protection.
// Fix: ROLLBACK PREPARED 'txn_payment_abc123' (or COMMIT PREPARED if recoverable).
// BLOCKED: pg_prepared_xacts system view cannot be seeded in PGlite — snapshot used.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedPrepared =
    /prepared.{0,20}(transaction|xact)|pg_prepared_xacts/i.test(report);
  const identifiedOrphan =
    /txn_payment_abc123|abandoned.{0,30}prepared|orphan.{0,30}prepared/i.test(report);
  const proposedFix =
    /rollback\s+prepared|commit\s+prepared/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified abandoned prepared transaction', passed: identifiedPrepared },
    { name: 'identified the specific transaction (txn_payment_abc123)', passed: identifiedOrphan },
    { name: 'proposed ROLLBACK PREPARED or COMMIT PREPARED', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified that 'txn_payment_abc123' is an abandoned prepared transaction
         that has been sitting for over 6 hours, and explained that it holds an
         old xmin blocking VACUUM and wraparound protection.
      2. Proposed resolving it with ROLLBACK PREPARED 'txn_payment_abc123' (or
         COMMIT PREPARED if the transaction's intent can be determined).

      Fail if the agent did not name the specific transaction, confused it with a
      regular long-running query, or proposed no way to resolve it.
    `,
  });
  checks.push({
    name: 'correctly diagnosed abandoned prepared transaction and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
