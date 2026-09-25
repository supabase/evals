import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: pid 12345 holds an ExclusiveLock on orders in 'idle in transaction'
// state (4 minutes), blocking pids 23456 and 34567 in a lock wait chain.
// Fix: pg_terminate_backend(12345) to break the chain.
// BLOCKED: pg_locks and pg_stat_activity are system views in PGlite and cannot
// be seeded — eval uses snapshot tables.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedChain =
    /lock.{0,30}(wait|chain|block)|blocking.{0,30}(chain|session|pid)/i.test(report);
  const identifiedBlocker =
    /\b12345\b/.test(report);
  const proposedFix =
    /pg_terminate_backend|terminate.{0,20}backend|kill.{0,20}(session|pid|connection)/i.test(
      report
    );

  const checks: CheckResult[] = [
    { name: 'identified a lock wait chain', passed: identifiedChain },
    { name: 'identified the blocking session (pid 12345)', passed: identifiedBlocker },
    { name: 'proposed terminating the blocking backend', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified that pid 12345 is in an 'idle in transaction' state and is
         holding a lock on the orders table, blocking pids 23456 and 34567.
      2. Proposed terminating the blocking session using pg_terminate_backend(12345)
         to break the chain, and suggested investigating why the transaction was
         left open (e.g. missing COMMIT or application bug).

      Fail if the agent did not identify pid 12345 as the root blocker, confused
      the blocked sessions as the cause, or gave no actionable remediation.
    `,
  });
  checks.push({
    name: 'correctly diagnosed blocking chain and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
