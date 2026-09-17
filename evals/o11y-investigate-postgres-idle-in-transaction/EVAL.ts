import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: pid 55321 has been 'idle in transaction' for 47 minutes. This holds back
// the oldest transaction horizon across the entire cluster, preventing VACUUM from
// reclaiming dead tuples on any table.
// Fix: pg_terminate_backend(55321) and set idle_in_transaction_session_timeout.
// BLOCKED: pg_stat_activity system view in PGlite cannot be seeded — eval uses
// public.pg_stat_activity_snapshot.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedIdle =
    /idle.{0,20}in.{0,20}transaction|idle_in_transaction/i.test(report);
  const identifiedSession =
    /\b55321\b/.test(report);
  const proposedFix =
    /pg_terminate_backend|idle_in_transaction_session_timeout|terminate.{0,20}(session|backend)/i.test(
      report
    );

  const checks: CheckResult[] = [
    { name: 'identified idle-in-transaction session', passed: identifiedIdle },
    { name: 'identified the offending session (pid 55321)', passed: identifiedSession },
    { name: 'proposed terminating or preventing idle-in-transaction sessions', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified that pid 55321 has been in 'idle in transaction' state for
         approximately 47 minutes and is holding back the vacuum horizon.
      2. Proposed terminating the session with pg_terminate_backend(55321) and/or
         setting idle_in_transaction_session_timeout to automatically terminate
         such sessions in the future.

      Fail if the agent did not identify the specific session, did not explain the
      vacuum horizon impact, or gave no actionable remediation.
    `,
  });
  checks.push({
    name: 'correctly diagnosed idle-in-transaction and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
