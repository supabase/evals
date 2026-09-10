import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: 'app' database has age(datfrozenxid) = 1.95B, critically close to the
// ~2.1B wraparound limit. Postgres will refuse writes to protect itself.
// BLOCKED: pg_database system catalog in PGlite reflects only harness txn state —
// eval uses public.pg_database_snapshot to represent production values.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedWraparound =
    /wraparound|txid.{0,30}exhaust|age.{0,30}(datfrozenxid|frozenxid)|1[\.,]?9[0-9]{2}[\.,]?[0-9]{3}[\.,]?[0-9]{3}/i.test(
      report
    );
  const identifiedDatabase = /\bapp\b/.test(report);
  const proposedFix =
    /vacuum\s+freeze|autovacuum_freeze_max_age|alter\s+system|pg_stat_user_tables/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified txid wraparound risk', passed: identifiedWraparound },
    { name: 'identified the affected database (app)', passed: identifiedDatabase },
    { name: 'proposed VACUUM FREEZE or a relevant mitigation', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified that the 'app' database has an age(datfrozenxid) of approximately
         1.95 billion, which is critically close to the ~2.1 billion wraparound limit
         where Postgres will stop accepting writes.
      2. Proposed running VACUUM FREEZE on the affected database or tables, or
         suggested adjusting autovacuum_freeze_max_age to trigger preventive freezing.

      Fail if the agent misidentified the problem, did not name the 'app' database
      specifically, or only gave generic advice without citing the snapshot values.
    `,
  });
  checks.push({
    name: 'correctly diagnosed txid wraparound and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
