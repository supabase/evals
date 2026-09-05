import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: all 3 autovacuum_max_workers slots are continuously occupied. The pool
// is saturated; tables queue and dead tuples accumulate despite autovacuum being on.
// Fix: increase autovacuum_max_workers or tune vacuum cost settings to reduce
// per-worker time.
// BLOCKED: pg_stat_activity cannot be seeded in PGlite — snapshot tables used.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedSaturation =
    /autovacuum.{0,30}(saturated|all.{0,10}worker|max.{0,10}worker.{0,20}full|pool.{0,10}full|busy)/i.test(
      report
    );
  const identifiedMaxWorkers =
    /autovacuum_max_workers/i.test(report);
  const proposedFix =
    /autovacuum_max_workers|vacuum_cost|autovacuum_vacuum_cost/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified autovacuum worker pool is saturated', passed: identifiedSaturation },
    { name: 'referenced autovacuum_max_workers', passed: identifiedMaxWorkers },
    { name: 'proposed increasing max_workers or tuning cost settings', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified that all 3 autovacuum_max_workers slots are continuously in use
         (all workers busy for 10+ minutes), meaning the pool is saturated and tables
         are waiting for vacuum attention.
      2. Proposed increasing autovacuum_max_workers or adjusting vacuum cost parameters
         (autovacuum_vacuum_cost_delay, autovacuum_vacuum_cost_limit) to allow workers
         to complete faster.

      Fail if the agent confused saturation with autovacuum being globally disabled,
      did not identify the worker count issue, or gave no actionable tuning suggestion.
    `,
  });
  checks.push({
    name: 'correctly diagnosed autovacuum saturation and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
