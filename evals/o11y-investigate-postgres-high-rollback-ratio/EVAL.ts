import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: 'app' database has xact_rollback=95000 vs xact_commit=155000 → ~38%
// rollback ratio. Normal is <1%. Likely cause: constraint violations, application
// errors, or deadlocks being silently swallowed.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedHighRollback =
    /rollback.{0,30}(ratio|rate|high|38|xact_rollback)/i.test(report);
  const citedNumbers =
    /95[,.]?000|155[,.]?000|38%|0\.\s*38/i.test(report);
  const proposedInvestigation =
    /constraint|application.{0,20}error|deadlock|log|pg_stat_statements|error.{0,20}log/i.test(
      report
    );

  const checks: CheckResult[] = [
    { name: 'identified high rollback ratio', passed: identifiedHighRollback },
    { name: 'cited approximate ratio or raw numbers', passed: citedNumbers },
    { name: 'proposed investigating error source (logs, constraints, deadlocks)', passed: proposedInvestigation },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified that the 'app' database has a rollback ratio of approximately
         38% (xact_rollback=95000 vs xact_commit=155000), far above the healthy
         threshold of <1%.
      2. Proposed investigating the cause — checking application error logs,
         looking for constraint violations in pg_stat_statements, or examining
         deadlock patterns.

      Fail if the agent did not compute or cite the rollback ratio, confused
      rollbacks with commits, or gave no direction for root-cause investigation.
    `,
  });
  checks.push({
    name: 'correctly diagnosed high rollback ratio and proposed investigation',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
