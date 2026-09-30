import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: audit_log (480k dead tuples, 5 days since autovacuum) and events
// (95k dead tuples, 3 days) are vacuum-starved despite autovacuum being enabled.
// Fix: manual VACUUM on the affected tables; tune autovacuum_vacuum_scale_factor
// or per-table storage parameters to trigger more frequent automatic vacuums.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedStarved =
    /autovacuum.{0,30}(starv|not.{0,10}reach|behind|lag|dead.{0,20}tup)/i.test(report);
  const identifiedTables =
    /audit_log|events/.test(report);
  const proposedFix =
    /vacuum|autovacuum_vacuum_scale_factor|autovacuum_vacuum_threshold|storage.{0,20}parameter/i.test(
      report
    );

  const checks: CheckResult[] = [
    { name: 'identified vacuum-starved tables', passed: identifiedStarved },
    { name: 'named the affected tables (audit_log or events)', passed: identifiedTables },
    { name: 'proposed VACUUM or autovacuum tuning', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified that audit_log (480,000 dead tuples, last autovacuum 5 days ago)
         and/or events (95,000 dead tuples, last autovacuum 3 days ago) are
         accumulating dead tuples faster than autovacuum is cleaning them.
      2. Proposed running VACUUM on the specific tables and/or lowering
         autovacuum_vacuum_scale_factor (or autovacuum_vacuum_threshold) as a
         per-table storage parameter to trigger more frequent cleanups.

      Fail if the agent did not name the specific starved tables, confused this
      with global autovacuum being disabled, or gave no actionable remediation.
    `,
  });
  checks.push({
    name: 'correctly diagnosed autovacuum starvation and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
