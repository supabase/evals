import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: statement_timeout = 0 (no timeout). Runaway queries can hold connections
// indefinitely, causing outages.
// Fix: ALTER ROLE postgres SET statement_timeout = '30s' (or similar reasonable value).
// NOTE: pg_settings is available in PGlite and will show the default value of 0 —
// no fake table needed.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedUnset =
    /statement_timeout.{0,30}(0|unset|not set|no timeout|disabled)/i.test(report);
  const proposedFix =
    /alter.{0,10}(role|system|database).{0,30}statement_timeout|statement_timeout\s*=\s*'\d/i.test(
      report
    );

  const checks: CheckResult[] = [
    { name: 'identified statement_timeout is unset (= 0)', passed: identifiedUnset },
    { name: 'proposed setting a statement_timeout value', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified that statement_timeout is set to 0 (no limit), meaning queries
         can run indefinitely and a single runaway query can exhaust connections.
      2. Proposed setting a reasonable timeout via ALTER ROLE postgres SET
         statement_timeout = '<value>' or ALTER DATABASE ... SET statement_timeout,
         with a specific value (e.g. '30s', '60s', '5min').

      Fail if the agent did not cite the current value of 0, gave no specific
      timeout value, or only described the risk without a concrete SQL command.
    `,
  });
  checks.push({
    name: 'correctly diagnosed unset statement_timeout and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
